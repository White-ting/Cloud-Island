// 假的 dsh：照 dsh-sdk-protocol 的样子，在 stdin/stdout 上说「一行一条」的 JSON-RPC 2.0，回固定的东西。
// 只给 test/dsh.test.mjs 用，不连任何模型。做过什么记在 $DSH_HOME/fake-log.jsonl（一行一件），测试拿来对。
// 她那句话里有这些字，就照着演：
//   你好   → 回一句话（带一段思考）；回执故意比 session/prompt 的回话先发
//   建文件 → 先记一个 write 工具调用，再问「行不行」（approval/request），批了写好、没批不写
//   多步   → 两步：说一句、跑一个 bash、再说一句
//   慢慢说 → 说一半就停住不动，等着被关掉（测「停」）
//   崩     → 回执发完直接退出（退出码 3）
//   出错   → 这一轮以错误结束
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.DSH_HOME || '.';
const logFile = path.join(home, 'fake-log.jsonl');
const sessFile = path.join(home, 'fake-sessions.json');
const note = (o) => fs.appendFileSync(logFile, JSON.stringify(o) + '\n');
const known = () => { try { return JSON.parse(fs.readFileSync(sessFile, 'utf8')); } catch { return []; } };
const remember = (sid) => { const k = known(); if (!k.includes(sid)) fs.writeFileSync(sessFile, JSON.stringify([...k, sid])); };

note({ boot: { argv: process.argv.slice(2), cwd: process.cwd(), env: {
  DSH_HOME: process.env.DSH_HOME, DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE, DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED,
  FAKE_KEY: process.env.FAKE_KEY, HOOK_TOKEN: process.env.HOOK_TOKEN, SOMETHING_ELSE: process.env.SOMETHING_ELSE, EXTRA: process.env.EXTRA } } });

const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const notify = (method, params) => send({ method, params });
const ev = (sid, type, data) => notify('session.event', { sessionId: sid, event: { type, data } });
const status = (sid, s) => notify('session.status', { sessionId: sid, status: s });
let seq = 0, inited = false;
const open = new Set();
const waiting = new Map(); // 我们问出去（approval/request）还没回的

function ask(method, params) {
  const id = 'srv_' + ++seq;
  return new Promise((ok) => { waiting.set(id, ok); send({ id, method, params }); });
}

async function prompt(id, { sessionId: sid, contentBlocks }) {
  const text = (contentBlocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const imgs = (contentBlocks || []).filter((b) => b.type === 'image').length;
  note({ prompt: { sid, text, imgs } });
  remember(sid);
  open.add(sid);
  const msgId = 'm' + ++seq;
  const receipt = () => { status(sid, 'running'); ev(sid, 'turn/start', { turn: 1 }); ev(sid, 'agent/inbox/spliced', { inserted: [{ id: msgId }] }); };
  const end = (reason = { kind: 'completed' }) => { ev(sid, 'turn/end', { turn: 1, reason }); status(sid, 'idle'); };
  const say = (t, think) => ev(sid, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [...(think ? [{ type: 'reasoning', text: think }] : []), { type: 'text', text: t }] }, stream: [] });

  if (text.includes('你好')) {
    receipt(); // 回执先到，回话后到
    send({ id, result: { messageId: msgId } });
    say('你好呀，我是假的 dsh。', '她在打招呼');
    end();
    return;
  }
  send({ id, result: { messageId: msgId } });
  receipt();
  if (text.includes('建文件')) {
    ev(sid, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'write', arguments: '{"path":"a.txt","content":"hi"}' });
    const r = await ask('approval/request', { sessionId: sid, toolName: 'write', callId: 'call-1', reason: '要在工作区写 a.txt' });
    note({ approval: r });
    const ok = r?.outcome === 'allowed-once';
    ev(sid, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-1', isError: !ok, content: [{ type: 'text', text: ok ? '写好了 a.txt' : '被拒绝了' }] } });
    say(ok ? '建好了。' : '好，不建了。');
    end();
  } else if (text.includes('多步')) {
    say('第一步');
    ev(sid, 'tool/call', { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{"command":"ls"}' });
    ev(sid, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'a.txt' }] } });
    say('第二步');
    end();
  } else if (text.includes('慢慢说')) {
    say('我先说一半');
    // 就停在这里，等着被关
  } else if (text.includes('崩')) {
    setTimeout(() => process.exit(3), 20);
  } else if (text.includes('出错')) {
    end({ kind: 'error', error: { message: '模型出错了', code: 'UNKNOWN' } });
  } else {
    say('收到：' + text);
    end();
  }
}

async function handle(m) {
  if (m.id != null && !m.method) { const ok = waiting.get(m.id); waiting.delete(m.id); ok?.(m.result ?? { error: m.error }); return; }
  const { id, method, params = {} } = m;
  note({ req: method, params: method === 'session/prompt' ? { sessionId: params.sessionId } : params });
  if (method === 'initialize') { inited = true; return send({ id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } }); }
  if (!inited) return send({ id, error: { code: -32603, message: 'SDK server is not initialized' } });
  if (method === 'session/prompt') return prompt(id, params);
  if (method === 'session/resume') {
    if (open.has(params.sessionId)) return send({ id, error: { code: -32603, message: 'SDK session is already open or opening' } });
    if (!known().includes(params.sessionId)) return send({ id, error: { code: -32603, message: 'session not found' } });
    open.add(params.sessionId);
    return send({ id, result: {} });
  }
  if (method === 'session/query') {
    const t = params.contentBlocks?.[0]?.text || '';
    if (t.startsWith('/permission ')) return send({ id, result: { kind: 'command', execution: { commandId: 'cmd1', result: { kind: 'success', text: 'ok' } } } });
    return prompt(id, params);
  }
  if (method === 'shutdown') { send({ id, result: {} }); setTimeout(() => process.exit(0), 20); return; }
  send({ id, error: { code: -32601, message: 'unknown method ' + method } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (s) => {
  buf += s;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    handle(m);
  }
});
process.stdin.on('end', () => { note({ eof: true }); process.exit(0); });
