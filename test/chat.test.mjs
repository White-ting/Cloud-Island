// 聊天（走 API 的 TA）：上游一律是这个测试进程里起的假 HTTP 服务，不发外网请求。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../lib/store.mjs';
import { createServer } from '../lib/server.mjs';
import { makeHooks } from '../lib/hooks.mjs';
import { openTalk } from '../lib/talk.mjs';
import { openPersona } from '../lib/persona.mjs';
import { openChat } from '../lib/chat.mjs';

const SECRET = 'SEKRIT-k3y-9f8e7d6c5b4a-zz'; // 假 key：跑完遍历数据和所有返回，不许出现
const N = (o) => `<!--note ${JSON.stringify(o)} -->`;
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // 自己建的临时目录自己清

const AIS = [
  { id: 'o', model: 'gpt-x', style: 'openai', keyEnv: 'AI_KEY', think: true },
  { id: 'r', model: 'gpt-r', style: 'responses', keyEnv: 'AI_KEY', think: true },
  { id: 'c', model: 'claude-x', style: 'anthropic', keyEnv: 'AI_KEY', think: true, maxTokens: 4096 },
  { id: 'g', model: 'gemini-x', style: 'gemini', keyEnv: 'AI_KEY', think: true },
];
const STYLE_OF = (url) => (url.startsWith('/oa/v1/chat') ? 'openai' : url.startsWith('/oa/v1/responses') ? 'responses' : url.startsWith('/an/') ? 'anthropic' : 'gemini');

// 各家的流：think 是思考，text 是正文切成的几段
function streamFor(style, { think = '', text = [], tool = null }) {
  if (style === 'openai') {
    return [...(think ? [{ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: think } }] }] : []),
      ...text.map((t) => ({ choices: [{ index: 0, delta: { content: t } }] })), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'];
  }
  if (style === 'responses') {
    const e = (type, o = {}) => ({ event: type, data: { type, ...o } });
    return [e('response.created', { response: { id: 'r', output: [] } }), ...(think ? [e('response.reasoning_summary_text.delta', { item_id: 'rs', delta: think })] : []),
      ...text.map((t) => e('response.output_text.delta', { item_id: 'i1', content_index: 0, delta: t })),
      e('response.output_text.done', { item_id: 'i1', content_index: 0, text: text.join('') }), e('response.completed', { response: { id: 'r', output: [] } })];
  }
  if (style === 'anthropic') {
    const e = (type, o = {}) => ({ event: type, data: { type, ...o } });
    return [e('message_start', { message: { id: 'm', content: [] } }),
      ...(think ? [e('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }), e('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: think } }), e('content_block_stop', { index: 0 })] : []),
      e('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
      ...text.map((t) => e('content_block_delta', { index: 1, delta: { type: 'text_delta', text: t } })), e('content_block_stop', { index: 1 }),
      ...(tool ? [e('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 't1', name: tool.name, input: {} } }),
        e('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } }), e('content_block_stop', { index: 2 })] : []),
      e('message_stop')];
  }
  return [...(think ? [{ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: think, thought: true }] } }] }] : []),
    ...text.map((t) => ({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: t }] } }] }))];
}
const writeSse = (res, evs) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of evs) res.write(e === '[DONE]' ? 'data: [DONE]\n\n' : (e.event ? `event: ${e.event}\n` : '') + `data: ${JSON.stringify(e.data ?? e)}\n\n`);
  res.end();
};

async function setup({ ais = AIS, keyOf = (n) => (n === 'AI_KEY' ? SECRET : ''), wrap = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-chat-'));
  dirs.push(dir);
  const clock = { t: Date.UTC(2026, 10, 15, 4) };
  const now = () => clock.t;
  const store = openStore({ dir, tz: 'Asia/Shanghai', now, talk: openTalk({ dir, now }) });
  const persona = openPersona({ store });
  const real = makeHooks({ store, tz: 'Asia/Shanghai', persona });
  const calls = { start: [], before: [], after: [] };
  const hooks = {};
  for (const k of ['start', 'before', 'after', 'compact']) hooks[k] = (...a) => { calls[k]?.push(a); return (wrap[k] || real[k])(...a); };
  // 假上游：记下收到的请求；默认按地址认是哪家、照 up.script 回一段流
  const up = { seen: [], closed: 0, script: { think: '想想', text: ['好', '的。<!--no', 'te {"kind":"note","text":"她来了"} -->'] } };
  up.reply = (r, res) => writeSse(res, streamFor(STYLE_OF(r.url), up.script));
  up.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const r = { url: req.url, headers: req.headers, raw, json: JSON.parse(raw) };
      up.seen.push(r);
      res.on('close', () => { if (!res.writableFinished) up.closed++; });
      up.reply(r, res);
    });
  });
  await new Promise((ok) => up.server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${up.server.address().port}`;
  const logs = [], outs = [], wakes = [];
  const log = (...a) => logs.push(a.join(' '));
  const mk = () => openChat({ dir, store, hooks, persona, upstream: { openai: base + '/oa', anthropic: base + '/an', gemini: base + '/ge' }, keyOf, log, now,
    tz: 'Asia/Shanghai', onWake: (ai, m, o) => wakes.push([ai, m.id, o.push]) });
  const chat = mk();
  if (ais) chat.setAis(ais);
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store, hooks, persona, chat, log });
  const { port } = await srv.listen();
  // 发一个请求；SSE 的边收边看（onText），收完回 { status, text, body, events }
  const call = (method, p, body, headers = {}, onText) => new Promise((ok, no) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; onText?.(text); });
      const fin = () => {
        outs.push(text);
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* SSE */ }
        const events = /event-stream/.test(res.headers['content-type'] || '') ? text.split('\n\n').filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, ''))) : [];
        ok({ status: res.statusCode, text, body: parsed, events });
      };
      res.on('end', fin);
      res.on('aborted', fin);
    });
    req.on('error', no);
    req.end(data);
  });
  const sendTo = (ai, body, onText) => call('POST', `/api/chat/${ai}/send`, body, {}, onText);
  const close = async () => { await srv.close(); up.server.closeAllConnections(); await new Promise((ok) => up.server.close(ok)); };
  // 密钥不落盘、不外泄：遍历数据目录的每个文件、每个接口返回、每行日志
  const noLeak = () => {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(dir)) assert.ok(!fs.readFileSync(f, 'utf8').includes(SECRET), '数据里有 key：' + f);
    for (const t of outs) assert.ok(!t.includes(SECRET), '接口返回里有 key');
    for (const l of logs) assert.ok(!l.includes(SECRET), '日志里有 key');
  };
  return { dir, store, persona, chat, clock, calls, up, call, sendTo, close, logs, noLeak, wakes, mk };
}
const userMsgs = (sent) => sent.json.messages.filter((m) => m.role !== 'system');
const deltas = (r) => r.events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
const thinks = (r) => r.events.filter((e) => e.type === 'think').map((e) => e.text).join('');
const mem = (store, ai) => store.list(ai, { who: 'ai' }).items.map((m) => m.text);

test('四种 style 各发一句：正文流到前端不含小记、思考变成 think 事件、小记记下、done 带 notes、key 放在各家的头里', async () => {
  const g = await setup();
  try {
    for (const { id, style } of AIS) {
      const r = await g.sendTo(id, { text: '在吗', timeTag: '〔现在 11-15 12:00〕' });
      assert.equal(r.status, 200, id);
      assert.equal(deltas(r), '好的。', id);
      assert.ok(!r.text.includes('<!--') && !r.text.includes('她来了'), id);
      assert.equal(thinks(r), '想想', id);
      const done = r.events.at(-1);
      assert.equal(done.type, 'done');
      assert.deepEqual(done.notes.map((n) => [n.kind, n.op, typeof n.id]), [['note', 'add', 'string']], id);
      assert.ok(mem(g.store, id).includes('她来了'), id);
      const items = (await g.call('GET', `/api/chat/${id}`)).body.items;
      assert.deepEqual(items.map((m) => [m.role, m.text]), [['me', '在吗'], ['ai', '好的。']], id); // timeTag 不存
      assert.equal(items[1].think, '想想');
      assert.deepEqual(items[1].notes, done.notes);
      assert.deepEqual([done.id, done.me], [items[1].id, items[0].id]);
      const sent = g.up.seen.at(-1);
      assert.equal(STYLE_OF(sent.url), style);
      // key 只出现在各家该在的头里
      if (style === 'anthropic') assert.equal(sent.headers['x-api-key'], SECRET);
      else if (style === 'gemini') assert.equal(sent.headers['x-goog-api-key'], SECRET);
      else assert.equal(sent.headers.authorization, 'Bearer ' + SECRET);
    }
    // 各家请求的形状：思考怎么打开、她那句开头是 timeTag、后面接每条消息前那段、开场在 system
    const [o, rr, c, ge] = g.up.seen;
    assert.equal(o.url, '/oa/v1/chat/completions');
    assert.equal(o.json.stream, true);
    const om = o.json.messages;
    assert.ok(om[0].role === 'system' && om[0].content.startsWith('〔记忆库 · 开场〕'));
    assert.match(om.at(-1).content, /^〔现在 11-15 12:00〕\n在吗\n\n〔现在 2026\/11\/15/);
    assert.equal(rr.url, '/oa/v1/responses');
    assert.deepEqual(rr.json.reasoning, { summary: 'auto' });
    assert.ok(rr.json.instructions.startsWith('〔记忆库 · 开场〕'));
    assert.match(rr.json.input.at(-1).content, /^〔现在 11-15 12:00〕\n在吗\n\n〔现在/);
    assert.equal(c.url, '/an/v1/messages');
    assert.deepEqual(c.json.thinking, { type: 'enabled', budget_tokens: 2048 });
    assert.equal(c.json.max_tokens, 4096);
    assert.equal(c.headers['anthropic-version'], '2023-06-01');
    assert.ok(c.json.system.startsWith('〔记忆库 · 开场〕'));
    assert.equal(ge.url, '/ge/v1beta/models/gemini-x:streamGenerateContent?alt=sse');
    assert.deepEqual(ge.json.generationConfig, { thinkingConfig: { includeThoughts: true } });
    assert.ok(ge.json.systemInstruction.parts[0].text.startsWith('〔记忆库 · 开场〕'));
    assert.equal(ge.json.contents[0].parts[0].text, '〔现在 11-15 12:00〕\n在吗');
    assert.ok(ge.json.contents[0].parts[1].text.startsWith('〔现在 2026'));
    // 对话原文（48 小时那份）由 hooks 写，一来回两行，不重复
    for (const { id } of AIS) assert.deepEqual(g.store.talk.recent(id).map((x) => [x.role, x.text]), [['me', '在吗'], ['ai', '好的。']]);
    g.noLeak();
  } finally { await g.close(); }
});

test('人格开着时放在 system 最前、开场在它后面；关着不带', async () => {
  const g = await setup();
  try {
    g.persona.put('o', { text: '我叫小克。', on: true });
    g.persona.put('c', { text: '我叫小克。', on: true });
    await g.sendTo('o', { text: '嗨' });
    const m = g.up.seen[0].json.messages;
    assert.equal(m[0].content, '我叫小克。');
    assert.ok(m[1].content.startsWith('〔记忆库 · 开场〕'));
    await g.sendTo('c', { text: '嗨' });
    assert.ok(g.up.seen[1].json.system.startsWith('我叫小克。\n\n〔记忆库 · 开场〕'));
    g.persona.put('o', { on: false });
    await g.sendTo('o', { text: '再来' });
    assert.ok(!JSON.stringify(g.up.seen[2].json).includes('我叫小克'));
  } finally { await g.close(); }
});

test('开场：第一句、隔了 6 小时以上、改了上下文把前面截掉时才重新取；同一场里一直放着同一段', async () => {
  const g = await setup();
  try {
    await g.sendTo('o', { text: '一' });
    assert.deepEqual(g.calls.start.map((a) => a[1].source), ['startup']);
    const first = g.up.seen[0].json.messages[0].content;
    g.clock.t += 3600e3;
    await g.sendTo('o', { text: '二' });
    assert.equal(g.calls.start.length, 1);
    assert.equal(g.up.seen[1].json.messages[0].content, first);
    g.clock.t += 7 * 3600e3;
    await g.sendTo('o', { text: '三' });
    assert.deepEqual(g.calls.start.map((a) => a[1].source), ['startup', 'startup']);
    assert.equal(g.calls.before.at(-1)[1].sid !== g.calls.before[0][1].sid, true); // 新的一场换 sid
    await g.call('PUT', '/api/chat/o/ctx', { mode: 'last', n: 1 });
    await g.sendTo('o', { text: '四' });
    assert.deepEqual(g.calls.start.map((a) => a[1].source), ['startup', 'startup', 'compact']);
    await g.sendTo('o', { text: '五' }); // 窗口往后挪不算截掉
    assert.equal(g.calls.start.length, 3);
    await g.call('PUT', '/api/chat/o/ctx', { mode: 'all' }); // 改成带更多：前面没被截，不重新取
    await g.sendTo('o', { text: '六' });
    assert.equal(g.calls.start.length, 3);
  } finally { await g.close(); }
});

test('上下文带多少：all / last / range 发给上游的条数对；all 超过 ctxMax 从最旧的不带、done 带 trimmed；设错回 400', async () => {
  const g = await setup({ ais: [{ id: 'o', model: 'm', style: 'openai', keyEnv: 'AI_KEY' }] });
  try {
    g.up.script = { text: ['好的。'] };
    for (let i = 1; i <= 4; i++) await g.sendTo('o', { text: `第${i}句`.padEnd(40, '。') });
    const ids = (await g.call('GET', '/api/chat/o')).body.items.map((m) => m.id);
    assert.equal(ids.length, 8);
    await g.sendTo('o', { text: '五' });
    assert.equal(userMsgs(g.up.seen.at(-1)).length, 9); // 全部 4 轮 + 这一句
    assert.deepEqual((await g.call('PUT', '/api/chat/o/ctx', { mode: 'last', n: 2 })).body, { mode: 'last', n: 2 });
    await g.sendTo('o', { text: '六' });
    assert.equal(userMsgs(g.up.seen.at(-1)).length, 5);
    assert.ok(userMsgs(g.up.seen.at(-1))[0].content.startsWith('第4句'));
    await g.call('PUT', '/api/chat/o/ctx', { mode: 'range', from: ids[2], to: ids[3] });
    assert.deepEqual((await g.call('GET', '/api/chat/o/ctx')).body, { mode: 'range', from: ids[2], to: ids[3] });
    await g.sendTo('o', { text: '七' });
    const rm = userMsgs(g.up.seen.at(-1));
    assert.equal(rm.length, 3);
    assert.ok(rm[0].content.startsWith('第2句') && rm[1].content === '好的。' && rm[2].content.startsWith('七'));
    await g.call('PUT', '/api/chat/o/ctx', { mode: 'range', from: ids[6] }); // to 不写 = 到最新
    await g.sendTo('o', { text: '八' });
    assert.equal(userMsgs(g.up.seen.at(-1)).length, 2 + 6 + 1);
    for (const bad of [{ mode: 'range', from: 'nope' }, { mode: 'range', from: ids[3], to: ids[1] }, { mode: 'range', from: ids[0], to: 'nope' }, { mode: 'last', n: 0 }, { mode: 'last', n: 501 }, { mode: 'x' }]) {
      assert.equal((await g.call('PUT', '/api/chat/o/ctx', bad)).status, 400, JSON.stringify(bad));
    }
    // all + ctxMax：从最旧的开始不带
    await g.call('PUT', '/api/chat/o/ctx', { mode: 'all' });
    g.chat.setAis([{ id: 'o', model: 'm', style: 'openai', keyEnv: 'AI_KEY', ctxMax: 100 }]);
    const r = await g.sendTo('o', { text: '九' });
    const all9 = userMsgs(g.up.seen.at(-1));
    assert.deepEqual([all9[0].role, all9[0].content], ['user', '（前面的聊天没有带上）']); // 截掉以后第一句是 TA 的：补一句占位
    const sent = all9.slice(1);
    const total = sent.slice(0, -1).reduce((a, m) => a + [...m.content].length, 0);
    assert.ok(total + 1 <= 100 && total > 50, String(total));
    assert.equal(r.events.at(-1).trimmed, 16 - (sent.length - 1)); // 一共 16 条历史，没带的那些
  } finally { await g.close(); }
});

test('删掉的消息不发给模型、列表里不给，能看、能恢复；编辑正文', async () => {
  const g = await setup();
  try {
    await g.sendTo('o', { text: '秘密的一句' });
    await g.sendTo('o', { text: '第二句' });
    const items = (await g.call('GET', '/api/chat/o')).body.items;
    assert.equal((await g.call('DELETE', `/api/chat/o/${items[0].id}`)).status, 200);
    assert.deepEqual((await g.call('GET', '/api/chat/o')).body.items.map((m) => m.text), ['好的。', '第二句', '好的。']);
    assert.deepEqual((await g.call('GET', '/api/chat/o?gone=1')).body.items.map((m) => m.text), ['秘密的一句']);
    await g.sendTo('o', { text: '第三句' });
    assert.ok(!JSON.stringify(g.up.seen.at(-1).json).includes('秘密的一句'));
    assert.equal((await g.call('POST', `/api/chat/o/${items[1].id}/restore`)).status, 400); // 没删的不用恢复
    assert.equal((await g.call('POST', `/api/chat/o/${items[0].id}/restore`)).status, 200);
    await g.sendTo('o', { text: '第四句' });
    assert.ok(JSON.stringify(g.up.seen.at(-1).json).includes('秘密的一句'));
    assert.equal((await g.call('DELETE', '/api/chat/o/nope')).status, 404);
    const e = await g.call('PATCH', `/api/chat/o/${items[2].id}`, { text: '第二句（改过）' });
    assert.equal(e.body.text, '第二句（改过）');
    // 翻页：before + limit，新的在后
    const p = (await g.call('GET', `/api/chat/o?before=${items[2].id}&limit=1`)).body;
    assert.deepEqual([p.items.map((m) => m.id), p.more], [[items[1].id], true]);
  } finally { await g.close(); }
});

test('按轮取：turns=2 是最近两轮（她一句 + 回复），配 before 往前翻，翻到头 more 是 false', async () => {
  const g = await setup();
  try {
    for (const s of ['一', '二', '三']) await g.sendTo('o', { text: s });
    const p = (await g.call('GET', '/api/chat/o?turns=2')).body;
    assert.deepEqual([p.items.map((m) => m.text), p.more], [['二', '好的。', '三', '好的。'], true]);
    const q = (await g.call('GET', `/api/chat/o?turns=2&before=${p.items[0].id}`)).body;
    assert.deepEqual([q.items.map((m) => m.text), q.more], [['一', '好的。'], false]);
    assert.equal((await g.call('GET', '/api/chat/o?turns=0')).body.items.length, 6); // 0 或乱写当默认 20 轮
  } finally { await g.close(); }
});

test('重新生成：旧回答进 alts、只许最后一句、小记按新这版算一次（不再 autoHit、不再算一轮）；/regen 也认', async () => {
  const g = await setup();
  try {
    await g.sendTo('o', { text: '在吗' });
    const [her, a1] = (await g.call('GET', '/api/chat/o')).body.items;
    g.up.script = { text: ['在的，', '换个说法。' + N({ kind: 'note', text: '第二版记的' })] };
    const r = await g.call('POST', `/api/chat/o/${a1.id}/again`, {});
    assert.equal(deltas(r), '在的，换个说法。');
    const done = r.events.at(-1);
    assert.equal(done.again, true);
    assert.equal(done.id, a1.id);
    assert.deepEqual(done.notes.map((n) => [n.op, n.again]), [['add', true]]);
    assert.equal(g.calls.after.at(-1)[1].again, true);
    assert.equal(g.calls.before.length, 1); // 每条消息前那段用上次的，不再记原文
    assert.equal(g.calls.start.length, 1);
    // 发给上游的还是她那一句，不另加「请重新回答」
    assert.equal(userMsgs(g.up.seen[1]).length, 1);
    assert.equal(userMsgs(g.up.seen[1])[0].content, userMsgs(g.up.seen[0])[0].content);
    let items = (await g.call('GET', '/api/chat/o')).body.items;
    assert.equal(items.length, 2);
    assert.deepEqual([items[1].text, items[1].alts], ['在的，换个说法。', ['好的。', '在的，换个说法。']]);
    assert.ok(mem(g.store, 'o').includes('她来了') && mem(g.store, 'o').includes('第二版记的')); // 旧版记下的不撤
    // /regen { id } 也认；第三版接在 alts 后面
    g.up.script = { text: ['第三版。'] };
    await g.call('POST', '/api/chat/o/regen', { id: a1.id });
    items = (await g.call('GET', '/api/chat/o')).body.items;
    assert.deepEqual(items[1].alts, ['好的。', '在的，换个说法。', '第三版。']);
    assert.equal(items[1].notes, undefined);
    assert.equal((await g.call('POST', `/api/chat/o/${her.id}/again`, {})).status, 400); // 不是最后一句
    assert.equal((await g.call('POST', '/api/chat/o/nope/again', {})).status, 404);
  } finally { await g.close(); }
});

test('上游 500：她那句存着、TA 那句不存；error 带状态码和一句人话，上游把 key 回显了也抹掉；之后可以对她那句补一个回答', async () => {
  const g = await setup();
  try {
    g.up.reply = (r, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'boom with key ' + SECRET } })); };
    const r = await g.sendTo('o', { text: '在吗' });
    const e = r.events.at(-1);
    assert.equal(e.type, 'error');
    assert.equal(e.status, 500);
    assert.match(e.msg, /上游/);
    assert.equal(e.detail, 'boom with key ***');
    const items = (await g.call('GET', '/api/chat/o')).body.items;
    assert.deepEqual(items.map((m) => m.role), ['me']);
    assert.equal(e.me, items[0].id);
    g.up.reply = (rq, res) => writeSse(res, streamFor('openai', { text: ['补上了。'] }));
    const r2 = await g.call('POST', `/api/chat/o/${items[0].id}/again`, {});
    assert.equal(deltas(r2), '补上了。');
    assert.deepEqual((await g.call('GET', '/api/chat/o')).body.items.map((m) => [m.role, m.text]), [['me', '在吗'], ['ai', '补上了。']]);
    // 连不上
    const g2 = await setup({ ais: [{ id: 'x', model: 'm', style: 'openai', url: 'http://127.0.0.1:1' }] });
    try {
      const r3 = await g2.sendTo('x', { text: '嗨' });
      assert.deepEqual([r3.events.at(-1).type, r3.events.at(-1).msg], ['error', '连不上上游']);
    } finally { await g2.close(); }
    g.noLeak();
  } finally { await g.close(); }
});

test('停下：上游连接断开，已经流出来的存下标 cut；同时第二句回 409；中途断了也存下标 cut', async () => {
  const g = await setup();
  try {
    let got;
    const arrived = new Promise((ok) => { got = ok; });
    g.up.reply = (r, res) => { // 回半句就不动了
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '我想想，<!--note {"kind":"no' } }] })}\n\n`);
      got();
    };
    let sawDelta;
    const seenDelta = new Promise((ok) => { sawDelta = ok; });
    const p = g.sendTo('o', { text: '讲个故事' }, (t) => { if (t.includes('"delta"')) sawDelta(); });
    await arrived;
    await seenDelta;
    const busy = await g.sendTo('o', { text: '再说一句' });
    assert.equal(busy.status, 409);
    assert.equal((await g.call('POST', '/api/chat/o/x/again', {})).status, 404);
    const s = await g.call('POST', '/api/chat/o/stop');
    assert.deepEqual(s.body, { ok: true, stopped: true });
    const r = await p;
    assert.deepEqual(r.events.at(-1).cut, true);
    assert.equal(deltas(r), '我想想，');
    await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(g.up.closed, 1); // 上游那头也断了
    let items = (await g.call('GET', '/api/chat/o')).body.items;
    assert.deepEqual(items.map((m) => [m.role, m.text, !!m.cut]), [['me', '讲个故事', false], ['ai', '我想想，', true]]);
    assert.ok(!mem(g.store, 'o').length); // 半截小记不记
    assert.deepEqual((await g.call('POST', '/api/chat/o/stop')).body, { ok: true, stopped: false });

    // 中途断了
    g.up.reply = (rq, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '断在这' } }] })}\n\n`);
      setTimeout(() => res.socket.destroy(), 30);
    };
    const r2 = await g.sendTo('o', { text: '再来' });
    assert.equal(r2.events.at(-1).cut, true);
    items = (await g.call('GET', '/api/chat/o')).body.items;
    assert.deepEqual([items.at(-1).text, items.at(-1).cut], ['断在这', true]);
  } finally { await g.close(); }
});

test('图片按各家的写法放进请求，网址存下、base64 不存；引用和动作交给模型时带上', async () => {
  const g = await setup();
  try {
    const data = 'data:image/png;base64,iVBORw0KGgo=', web = 'https://x.test/cat.webp';
    for (const { id } of AIS) await g.sendTo(id, { text: '看', img: [data, web] });
    const [o, r, c, ge] = g.up.seen.map((s) => s.json);
    assert.deepEqual(userMsgs({ json: o }).at(-1).content.slice(0, 3), [{ type: 'text', text: '看' }, { type: 'image_url', image_url: { url: data } }, { type: 'image_url', image_url: { url: web } }]);
    assert.deepEqual(r.input.at(-1).content.slice(1, 3), [{ type: 'input_image', image_url: data }, { type: 'input_image', image_url: web }]);
    assert.deepEqual(c.messages.at(-1).content.slice(1, 3), [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }, { type: 'image', source: { type: 'url', url: web } }]);
    assert.deepEqual(ge.contents.at(-1).parts.slice(1, 3), [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }, { fileData: { mimeType: 'image/webp', fileUri: web } }]);
    const her = (await g.call('GET', '/api/chat/o')).body.items[0];
    assert.deepEqual([her.img, her.inlineImg], [[web], 1]);
    assert.equal((await g.sendTo('o', { img: ['file:///etc/passwd'] })).status, 400);
    assert.equal((await g.sendTo('o', { text: '  ' })).status, 400);
    // 引用、动作
    const a = (await g.call('GET', '/api/chat/o')).body.items[1];
    await g.sendTo('o', { text: '递给你一杯水', action: true, quote: a.id });
    assert.match(userMsgs(g.up.seen.at(-1)).at(-1).content, /^〔引用你说过的：「好的。」〕\n\*递给你一杯水\*\n\n〔现在/);
    assert.equal((await g.sendTo('o', { text: 'x', quote: 'nope' })).status, 400);
  } finally { await g.close(); }
});

test('流里的工具调用原样记成一步（不执行），发 step 事件', async () => {
  const g = await setup();
  try {
    g.up.script = { text: ['我查一下。'], tool: { name: 'weather', input: { city: '杭州' } } };
    const r = await g.sendTo('c', { text: '天气' });
    const st = r.events.find((e) => e.type === 'step');
    assert.deepEqual(st, { type: 'step', i: 0, kind: 'tool', name: 'weather', input: { city: '杭州' } });
    const ai = (await g.call('GET', '/api/chat/c')).body.items[1];
    assert.deepEqual(ai.steps, [{ kind: 'tool', name: 'weather', input: { city: '杭州' } }]);
    // 对话式：tool_calls 一段段拼起来
    g.up.reply = (rq, res) => writeSse(res, [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't', function: { name: 'look', arguments: '{"a"' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] }, '[DONE]']);
    const r2 = await g.sendTo('o', { text: '看看' });
    assert.deepEqual(r2.events.find((e) => e.type === 'step'), { type: 'step', i: 0, kind: 'tool', name: 'look', input: '{"a":1}' });
  } finally { await g.close(); }
});

test('有哪几个 AI：没有文件回空；名单不能从接口改（带 HOOK_TOKEN 也不行）；只留认得的字段（顺手写的 key 不落盘）；不给 url、keyEnv；没配 key、没这个 AI 先拦下', async () => {
  const g = await setup({ ais: null });
  try {
    assert.deepEqual((await g.call('GET', '/api/ais')).body, []);
    const list = [{ id: 'a1', name: '小克', model: 'claude-x', style: 'anthropic', url: 'https://api.example.com/', keyEnv: 'AI_KEY', key: SECRET, think: true, notes: true, avatar: 'a.png' }];
    assert.equal((await g.call('PUT', '/api/ais', list)).status, 403);
    assert.equal((await g.call('PUT', '/api/ais', list, { authorization: 'Bearer tok' })).status, 403);
    assert.ok(!fs.existsSync(path.join(g.dir, 'ais.json')));
    g.chat.setAis(list); // 管理员手写文件（setAis 是后端自己用的那份校验）
    assert.deepEqual((await g.call('GET', '/api/ais')).body, [{ id: 'a1', name: '小克', model: 'claude-x', avatar: 'a.png', notes: true }]);
    const saved = JSON.parse(fs.readFileSync(path.join(g.dir, 'ais.json'), 'utf8'));
    assert.deepEqual(saved[0], { id: 'a1', model: 'claude-x', style: 'anthropic', name: '小克', avatar: 'a.png', url: 'https://api.example.com', keyEnv: 'AI_KEY', think: true, notes: true });
    const bad = [
      [{ id: 'a b', model: 'm', style: 'openai' }], [{ id: 'a', model: 'm', style: 'x' }], [{ id: 'a', style: 'openai' }],
      [{ id: 'a', model: 'm', style: 'openai', url: 'https://x.test/v1?key=abc' }], [{ id: 'a', model: 'm', style: 'openai', keyEnv: 'HOOK_TOKEN' }],
      [{ id: 'a', model: 'm', style: 'openai', keyEnv: 'sk-lower-case' }], [{ id: 'a', model: 'm', style: 'openai' }, { id: 'a', model: 'n', style: 'openai' }], { x: 1 },
    ];
    for (const b of bad) assert.throws(() => g.chat.setAis(b), (e) => e.code === 400, JSON.stringify(b));
    for (const k of ['WEB_PASSWORD', 'SESSION_SECRET', 'TRANSLATE_KEY', 'BARK_AES']) assert.throws(() => g.chat.setAis([{ id: 'a', model: 'm', style: 'openai', keyEnv: k }]), /不能用/, k);
    assert.equal((await g.sendTo('nope', { text: '嗨' })).status, 404);
    g.chat.setAis([{ id: 'k', model: 'm', style: 'openai', keyEnv: 'AI_EMPTY' }]);
    const r2 = await g.sendTo('k', { text: '嗨' });
    assert.equal(r2.status, 503);
    assert.match(r2.body.error, /AI_EMPTY/);
    assert.equal((await g.call('GET', '/api/chat/k')).body.items.length, 0); // 没发出去的不存
    g.noLeak();
  } finally { await g.close(); }
});

// 不经过 HTTP 直接调 send / again 时用的假回复（收下 SSE 事件）
function fakeRes() {
  const r = { text: '', headersSent: false, writableEnded: false, destroyed: false };
  r.writeHead = () => { r.headersSent = true; };
  r.flushHeaders = () => {};
  r.write = (x) => { r.text += x; };
  r.end = () => { r.writableEnded = true; };
  r.events = () => r.text.split('\n\n').filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, '')));
  return r;
}
// 每家请求里第一句（不算 system）：[她还是 TA, 文字]
function firstTurn(sent) {
  const j = sent.json, style = STYLE_OF(sent.url);
  if (style === 'openai') { const m = j.messages.find((x) => x.role !== 'system'); return [m.role, m.content]; }
  if (style === 'responses') return [j.input[0].role, j.input[0].content];
  if (style === 'anthropic') return [j.messages[0].role, j.messages[0].content];
  return [j.contents[0].role, j.contents[0].parts[0].text];
}

test('上下文截出来第一句是 TA 的：四种 style 都在最前面补一句她的占位，TA 那句不丢', async () => {
  const g = await setup();
  try {
    g.up.script = { text: ['好的。'] };
    for (const { id } of AIS) {
      await g.sendTo(id, { text: '一' });
      await g.sendTo(id, { text: '二' });
      const ids = (await g.call('GET', `/api/chat/${id}`)).body.items.map((m) => m.id);
      await g.call('PUT', `/api/chat/${id}/ctx`, { mode: 'range', from: ids[1] }); // 从 TA 那句开始
      await g.sendTo(id, { text: '三' });
      const sent = g.up.seen.at(-1);
      assert.deepEqual(firstTurn(sent), ['user', '（前面的聊天没有带上）'], id);
      assert.ok(JSON.stringify(sent.json).includes('好的。'), id);
      // 不截的（全部）照旧，第一句就是她的「一」
      await g.call('PUT', `/api/chat/${id}/ctx`, { mode: 'all' });
      await g.sendTo(id, { text: '四' });
      assert.equal(firstTurn(g.up.seen.at(-1))[0], 'user', id);
      assert.ok(String(firstTurn(g.up.seen.at(-1))[1]).startsWith('一'), id);
    }
  } finally { await g.close(); }
});

test('重新生成：对话原文里换掉上一版（不留两行）；后端重启后头一次重新生成不再记她那句、不再算一轮', async () => {
  const g = await setup();
  try {
    await g.sendTo('o', { text: '在吗' });
    const a1 = (await g.call('GET', '/api/chat/o')).body.items[1];
    g.up.script = { text: ['第二版。'] };
    await g.call('POST', `/api/chat/o/${a1.id}/again`, {});
    assert.deepEqual(g.store.talk.recent('o').map((x) => [x.role, x.text]), [['me', '在吗'], ['ai', '第二版。']]);
    const rounds = g.store.load('o').sess.rounds;
    // 重启：内存里的那份没了
    const chat2 = g.mk();
    g.up.script = { text: ['第三版。'] };
    const res = fakeRes();
    await chat2.again('o', a1.id, {}, res);
    assert.equal(res.events().at(-1).type, 'done');
    assert.equal(g.calls.before.at(-1)[1].again, true);
    assert.deepEqual(g.store.talk.recent('o').map((x) => [x.role, x.text]), [['me', '在吗'], ['ai', '第三版。']]);
    assert.equal(g.store.load('o').sess.rounds, rounds); // 不再算一轮
    assert.match(userMsgs(g.up.seen.at(-1)).at(-1).content, /今天第 1 轮/);
  } finally { await g.close(); }
});

test('TA 主动开口：提示只给模型（不存、不显示）、存一条带 wake 的消息、记进说过什么（下次带给 TA）、onWake 收到；她回了算回过', async () => {
  const g = await setup();
  try {
    g.up.script = { text: ['到家了吗？' + N({ kind: 'note', text: '问过她到家没' })] };
    const r = await g.chat.wake('o', { why: 'later', hint: '两小时前你自己定的：问她到家没', push: true });
    assert.equal(r.said, true);
    const sent = g.up.seen[0].json.messages;
    assert.ok(sent[0].role === 'system' && sent[0].content.startsWith('〔记忆库 · 开场〕'));
    const last = sent.at(-1);
    assert.equal(last.role, 'user');
    assert.match(last.content, /^〔这不是她说的话，是后端叫醒了你：你自己定的回头看到点了〕\n两小时前你自己定的：问她到家没\n〔现在 /);
    assert.ok(last.content.includes('〔不说〕') && !last.content.includes('你最近主动说过'));
    let items = (await g.call('GET', '/api/chat/o')).body.items;
    assert.deepEqual(items.map((m) => [m.role, m.text, m.wake]), [['ai', '到家了吗？', { why: 'later' }]]);
    assert.deepEqual(items[0].notes.map((n) => [n.kind, n.op]), [['note', 'add']]);
    assert.ok(mem(g.store, 'o').includes('问过她到家没'));
    assert.ok(!JSON.stringify(items).includes('两小时前'));
    assert.deepEqual(g.wakes, [['o', r.id, true]]);
    // 说过什么：一行 { t, why, gist }；她在设置页只看到条数和时间
    const said = fs.readFileSync(path.join(g.dir, 'o', 'said.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(said.map((x) => [x.why, x.gist]), [['later', '到家了吗？']]);
    assert.deepEqual(g.chat.said('o'), { n: 1, items: [{ t: said[0].t, why: 'later' }] });
    assert.deepEqual(g.chat.info('o').wake, { t: items[0].t, answered: false });
    // 下一次叫醒带上「你最近主动说过」；历史第一句是 TA 自己开的口，前面补一句占位
    g.clock.t += 600e3;
    g.up.script = { text: ['〔不说〕'] };
    assert.deepEqual(await g.chat.wake('o', { why: 'knock', hint: '守门人：她到学校了', about: '到学校了' }), { said: false });
    const p2 = g.up.seen[1].json.messages;
    assert.deepEqual([p2[1].role, p2[1].content], ['user', '（这里还没有她的话，是你先开的口）']);
    assert.match(p2.at(-1).content, /你最近主动说过：\n- .*（later）到家了吗？\n同一件事已经问过/);
    // 选择不说：什么都不存
    assert.equal((await g.call('GET', '/api/chat/o')).body.items.length, 1);
    assert.equal(g.chat.said('o').n, 1);
    // 去掉小记后是空的：也算不说，小记照常记
    g.up.script = { text: [N({ kind: 'note', text: '她今天去学校了' })] };
    assert.deepEqual(await g.chat.wake('o', { why: 'knock' }), { said: false });
    assert.ok(mem(g.store, 'o').includes('她今天去学校了'));
    assert.equal(g.wakes.length, 1);
    // 她回了一句：上一次主动说的算回过
    g.up.script = { text: ['嗯。'] };
    await g.sendTo('o', { text: '到了' });
    assert.equal(g.chat.info('o').wake.answered, true);
    // 30 天以前的说过什么清掉
    g.clock.t += 31 * 864e5;
    assert.equal(g.chat.said('o').n, 0);
    g.noLeak();
  } finally { await g.close(); }
});

test('TA 主动开口时她发来一句：wake 让给她（断开、不存、抛 409 让收件箱晚点再来），她这句照常；上游出错抛 502；没这个 AI 抛 404', async () => {
  const g = await setup();
  try {
    let got;
    const arrived = new Promise((ok) => { got = ok; });
    g.up.reply = (r, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '我想' } }] })}\n\n`); got(); };
    const w = g.chat.wake('o', { why: 'idle' }).catch((e) => e);
    await arrived;
    assert.equal(g.chat.busy('o'), true);
    g.up.reply = (r, res) => writeSse(res, streamFor('openai', { text: ['在呢。'] }));
    const r = await g.sendTo('o', { text: '你在干嘛' });
    assert.equal(deltas(r), '在呢。');
    const e = await w;
    assert.deepEqual([e.code, e.requeue], [409, true]);
    assert.deepEqual((await g.call('GET', '/api/chat/o')).body.items.map((m) => [m.role, m.text]), [['me', '你在干嘛'], ['ai', '在呢。']]);
    assert.equal(g.chat.said('o').n, 0);
    g.up.reply = (rq, res) => { res.writeHead(500); res.end('{}'); };
    await assert.rejects(g.chat.wake('o', { why: 'knock' }), (x) => x.code === 502);
    await assert.rejects(g.chat.wake('nope', { why: 'knock' }), (x) => x.code === 404);
    assert.equal(g.chat.busy('o'), false);
  } finally { await g.close(); }
});

// ---- 11-17 缓存：截断点站稳、用量和命中、上游不收附加项 ----
test('截断点站稳：last n 攒到一倍半才切回 n；all + ctxMax 切到七成后不动，开头几句连着几次都一样', async () => {
  const g = await setup({ ais: [{ id: 'o', model: 'm', style: 'openai', keyEnv: 'AI_KEY' }] });
  try {
    g.up.script = { text: ['好的。'] };
    const first = () => userMsgs(g.up.seen.at(-1)).find((m) => m.content.startsWith('第')).content.slice(0, 3);
    const turns = () => userMsgs(g.up.seen.at(-1)).filter((m) => m.role === 'user' && !m.content.startsWith('（')).length - 1;
    await g.call('PUT', '/api/chat/o/ctx', { mode: 'last', n: 2 });
    const seenLast = [];
    for (let i = 1; i <= 8; i++) { await g.sendTo('o', { text: `第${i}句` }); seenLast.push([first(), turns()]); }
    // 前面带的轮数：0 1 2 3 → 到 4 超过一倍半（3），切回 2 → 3 → 切回 2 …；切过以后开头那句连着两次不变
    assert.deepEqual(seenLast.map((x) => x[1]), [0, 1, 2, 3, 2, 3, 2, 3]);
    assert.deepEqual(seenLast.slice(2).map((x) => x[0]), ['第1句', '第1句', '第3句', '第3句', '第5句', '第5句']);

    await g.call('PUT', '/api/chat/o/ctx', { mode: 'all' });
    g.chat.setAis([{ id: 'o', model: 'm', style: 'openai', keyEnv: 'AI_KEY', ctxMax: 200 }]);
    const firsts = [], trimmed = [];
    for (let i = 1; i <= 8; i++) {
      const r = await g.sendTo('o', { text: `长${i}`.padEnd(30, '。') });
      const ms = userMsgs(g.up.seen.at(-1)).filter((m) => !m.content.startsWith('（'));
      firsts.push(ms[0].content.slice(0, 4));
      trimmed.push(r.events.at(-1).trimmed || 0);
      // 带过去的字数这里不数：最后一句后面还接着「每条消息前」那段
    }
    const changes = trimmed.filter((x, i) => i && x !== trimmed[i - 1]).length;
    assert.ok(changes >= 1 && changes <= 3, JSON.stringify(trimmed)); // 8 句里只切两三次，不是每句都挪
    assert.deepEqual(trimmed.slice(0, 7), [0, 0, 0, 0, 17, 17, 17]); // 切一次以后连着三句都从同一句带起
  } finally { await g.close(); }
});

test('用量和缓存命中：四家的字段都认，记进 usage.jsonl，/api/usage 给合计；Claude 带 cache_control、对话式带 stream_options', async () => {
  const g = await setup();
  try {
    const tail = {
      openai: [{ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } } }],
      responses: [{ event: 'response.completed', data: { type: 'response.completed', response: { id: 'r', output: [], usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 600 } } } } }],
      anthropic: [{ event: 'message_delta', data: { type: 'message_delta', delta: {}, usage: { output_tokens: 20 } } }],
      gemini: [{ candidates: [], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 400, candidatesTokenCount: 20 } }],
    };
    g.up.reply = (r, res) => {
      const st = STYLE_OF(r.url);
      let evs = streamFor(st, { text: ['好。'] }).filter((e) => e !== '[DONE]' && e.event !== 'response.completed');
      if (st === 'anthropic') evs[0] = { event: 'message_start', data: { type: 'message_start', message: { id: 'm', content: [], usage: { input_tokens: 100, cache_read_input_tokens: 700, cache_creation_input_tokens: 200, output_tokens: 1 } } } };
      writeSse(res, [...evs, ...tail[st]]);
    };
    for (const { id } of AIS) await g.sendTo(id, { text: '在吗' });
    const u = (await g.call('GET', '/api/usage?days=1')).body;
    const sum = ({ last, ...o }) => o;
    assert.deepEqual(sum(u.ais.o), { n: 1, in: 1000, hit: 800, out: 20, rate: 0.8 });
    assert.deepEqual(sum(u.ais.r), { n: 1, in: 1000, hit: 600, out: 20, rate: 0.6 });
    assert.deepEqual(sum(u.ais.c), { n: 1, in: 1000, hit: 700, out: 20, rate: 0.7 });
    assert.deepEqual(sum(u.ais.g), { n: 1, in: 1000, hit: 400, out: 20, rate: 0.4 });
    assert.equal(u.ais.o.last.in, 1000); assert.equal(u.ais.o.last.hit, 800);
    const by = Object.fromEntries(g.up.seen.map((r) => [STYLE_OF(r.url), r.json]));
    assert.deepEqual(by.openai.stream_options, { include_usage: true });
    assert.deepEqual(by.anthropic.cache_control, { type: 'ephemeral' });
    const rows = fs.readFileSync(path.join(g.dir, 'usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 4);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['ai', 'hit', 'in', 'model', 'out', 't', 'what']); // 只有数，没有内容
    g.noLeak();
  } finally { await g.close(); }
});

test('上游不收附加项（回 400）：去掉再试一次，她照样收到回复，以后这个 AI 不再带', async () => {
  const g = await setup({ ais: [{ id: 'o', model: 'm', style: 'openai', keyEnv: 'AI_KEY' }] });
  try {
    g.up.reply = (r, res) => {
      if (r.json.stream_options) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"unknown field"}}'); }
      writeSse(res, streamFor('openai', { text: ['好。'] }));
    };
    const r = await g.sendTo('o', { text: '在吗' });
    assert.equal(r.events.at(-1).type, 'done');
    assert.equal(g.up.seen.length, 2);
    await g.sendTo('o', { text: '再来' });
    assert.equal(g.up.seen.length, 3);
    assert.equal(g.up.seen.at(-1).json.stream_options, undefined);
  } finally { await g.close(); }
});
