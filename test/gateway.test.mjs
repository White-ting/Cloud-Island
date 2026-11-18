// 网关：起一个假上游，四种协议各走一遍非流式和流式。全在本机，不发外网请求。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../lib/store.mjs';
import { createServer } from '../lib/server.mjs';
import { makeHooks } from '../lib/hooks.mjs';
import { makeGateway, makeCut } from '../lib/gateway.mjs';
import { loadConfig } from '../backend.mjs';

const N = (o) => `<!--note ${JSON.stringify(o)} -->`;
const K = 'gk-0123456789abcdef'; // 测试用的网关口令
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // 自己建的临时目录自己清

// 假上游：记下收到的请求，按 reply(req, body, res) 回
function fakeUpstream() {
  const seen = [];
  const up = { seen, reply: null };
  up.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(raw); } catch {}
      const r = { method: req.method, url: req.url, headers: req.headers, raw, json };
      seen.push(r);
      up.reply(r, res);
    });
  });
  return up;
}
const sendJson = (res, obj, code = 200, extra = {}) => { const s = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', ...extra }); res.end(s); };
const sse = (res, events, done = false) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write((e.event ? `event: ${e.event}\n` : '') + `data: ${JSON.stringify(e.data ?? e)}\n\n`);
  if (done) res.write('data: [DONE]\n\n');
  res.end();
};

async function setup({ wrap, upstream, key = K } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-gw-'));
  dirs.push(dir);
  const clock = { t: Date.UTC(2026, 10, 15, 4) };
  const store = openStore({ dir, tz: 'Asia/Shanghai', now: () => clock.t });
  const real = makeHooks({ store, tz: 'Asia/Shanghai' });
  const calls = { start: [], before: [], after: [] };
  const hooks = {};
  for (const k of ['start', 'before', 'after', 'compact']) hooks[k] = (...a) => { calls[k]?.push(a); return (wrap?.[k] || real[k])(...a); };
  const up = fakeUpstream();
  await new Promise((ok) => up.server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${up.server.address().port}`;
  const logs = [];
  const srv = createServer({
    cfg: { port: 0, gatewayKey: key, upstream: upstream || { openai: base + '/oa', anthropic: base + '/an', gemini: base + '/ge' } },
    store, hooks, log: (...a) => logs.push(a.join(' ')),
  });
  const { port } = await srv.listen();
  // 当 App：发请求，收完整回复（上游断了也把收到的那部分交回来）
  const call = (p, { body, headers = {}, method = 'POST' } = {}) => new Promise((ok, no) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text, broken: false }));
      res.on('error', () => ok({ status: res.statusCode, headers: res.headers, text, broken: true }));
      res.on('aborted', () => ok({ status: res.statusCode, headers: res.headers, text, broken: true }));
    });
    req.on('error', no);
    req.end(data);
  });
  const close = async () => { await srv.close(); up.server.closeAllConnections(); await new Promise((ok) => up.server.close(ok)); };
  return { store, clock, calls, up, call, close, logs, base };
}
const mem = (store, ai = 'a') => store.list(ai, { who: 'ai' }).items.map((m) => m.text);
// SSE 文字 → 每个事件的 data 对象（[DONE] 原样）
const events = (text) => text.split('\n\n').filter(Boolean).map((b) => {
  const d = b.split('\n').find((l) => l.startsWith('data:')).slice(5).trim();
  return d === '[DONE]' ? d : JSON.parse(d);
});

test('扣字：小记断在几段之间、<!--no 这种半截、不是小记的 < 照放', () => {
  const run = (parts) => { const c = makeCut(); return parts.map((s) => c(s)); };
  assert.deepEqual(run(['好的。', '<!--no', 'te {"a":1} -', '-> 尾巴']), ['好的。', '', '', ' 尾巴']);
  assert.deepEqual(run(['a <', 'b> c']), ['a ', '<b> c']);
  assert.deepEqual(run(['x<!--', ' not', 'es -->']), ['x', '', '<!-- notes -->']);
  assert.deepEqual(run(['开头', '<!--note {"半截', '']), ['开头', '', '']);
});

test('对话式·非流式：开场放最前面的 system、每条消息前接在她那句后面、小记剥掉且存进记忆库、口令转到上游', async () => {
  const g = await setup();
  try {
    g.store.add('a', { text: '她叫 小满', pin: true });
    g.up.reply = (r, res) => sendJson(res, { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: '在。\n\n' + N({ kind: 'note', text: '她今晚来找我' }) }, finish_reason: 'stop' }] });
    const body = { model: 'm', messages: [{ role: 'system', content: '你是 TA' }, { role: 'user', content: '在吗' }] };
    const r = await g.call(`/gw/${K}/a/v1/chat/completions`, { body, headers: { authorization: 'Bearer sk-test-123', 'x-session-id': 's1' } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).choices[0].message.content, '在。');
    const sent = g.up.seen[0];
    assert.equal(sent.url, '/oa/v1/chat/completions');
    assert.equal(sent.headers.authorization, 'Bearer sk-test-123');
    assert.equal(sent.headers['x-session-id'], undefined);
    const ms = sent.json.messages;
    assert.equal(ms.length, 3);
    assert.equal(ms[0].role, 'system');
    assert.ok(ms[0].content.startsWith('〔记忆库 · 开场〕') && ms[0].content.includes('她叫 小满'));
    assert.deepEqual(ms[1], body.messages[0]);
    assert.match(ms[2].content, /^在吗\n\n〔现在 2026\/11\/15/);
    assert.ok(mem(g.store).includes('她今晚来找我'));
    assert.deepEqual(g.calls.after[0][1], { reply: '在。\n\n' + N({ kind: 'note', text: '她今晚来找我' }), sid: 's1' });
  } finally { await g.close(); }
});

test('开场怎么认：只有一句她的话、或隔了 6 小时以上才算；开场那段在这一场里一直放着', async () => {
  const g = await setup();
  try {
    g.up.reply = (r, res) => sendJson(res, { choices: [{ index: 0, message: { role: 'assistant', content: '嗯' } }] });
    const conv = (n) => ({ messages: Array.from({ length: n * 2 - 1 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '第' + i + '句' })) });
    await g.call(`/gw/${K}/a/v1/chat/completions`, { body: conv(1) });
    assert.equal(g.calls.start.length, 1);
    assert.deepEqual(g.calls.start[0][1], { source: 'startup', focus: false }); // focus 交给开场：专心的对话不浮旧的
    g.clock.t += 3600e3;
    await g.call(`/gw/${K}/a/v1/chat/completions`, { body: conv(3) }); // 三句、一小时后：不算开场
    assert.equal(g.calls.start.length, 1);
    assert.equal(g.calls.before.length, 2);
    assert.ok(g.up.seen[1].json.messages[0].content.startsWith('〔记忆库 · 开场〕')); // 开场那段照样在最前面
    await g.call(`/gw/${K}/a/v1/chat/completions`, { body: conv(2) }); // 消息变少了：App 压缩过
    assert.deepEqual(g.calls.start[1][1], { source: 'compact', focus: false });
    g.clock.t += 7 * 3600e3;
    await g.call(`/gw/${K}/a/v1/chat/completions`, { body: conv(3) }); // 隔了七小时：算开场
    assert.equal(g.calls.start.length, 3);
    await g.call(`/gw/${K}/a/v1/chat/completions`, { body: conv(1) }); // 新开一个对话
    assert.equal(g.calls.start.length, 4);
  } finally { await g.close(); }
});

test('对话式·流式：边收边转，小记断在两个增量之间也剥得掉', async () => {
  const g = await setup();
  try {
    const ch = (content, extra = {}) => ({ choices: [{ index: 0, delta: { content }, ...extra }] });
    g.up.reply = (r, res) => sse(res, [{ choices: [{ index: 0, delta: { role: 'assistant' } }] }, ch('好'), ch('的。'), ch('<!--no'), ch('te {"kind":"note","text":"流里的小记"} -->'), ch('', { finish_reason: 'stop' })], true);
    const r = await g.call(`/gw/${K}/a/v1/chat/completions`, { body: { stream: true, messages: [{ role: 'user', content: '晚上吃什么' }] } });
    assert.equal(r.headers['content-type'], 'text/event-stream');
    const ev = events(r.text);
    assert.equal(ev.at(-1), '[DONE]');
    assert.equal(ev.slice(0, -1).map((e) => e.choices[0].delta.content || '').join(''), '好的。');
    assert.ok(!r.text.includes('<!--') && !r.text.includes('流里的小记'));
    assert.ok(mem(g.store).includes('流里的小记'));
  } finally { await g.close(); }
});

test('流中途断了：扣着的半截不漏出去，也不记', async () => {
  const g = await setup();
  try {
    g.up.reply = (r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好。<!--note {"kind":"note","te' } }] })}\n\n`);
      setTimeout(() => res.socket.destroy(), 30);
    };
    const r = await g.call(`/gw/${K}/a/v1/chat/completions`, { body: { stream: true, messages: [{ role: 'user', content: '嗨' }] } });
    assert.equal(r.broken, true);
    assert.equal(events(r.text)[0].choices[0].delta.content, '好。');
    assert.ok(!r.text.includes('<!--') && !r.text.includes('kind'));
    assert.equal(g.calls.after.length, 0);
    assert.equal(mem(g.store).length, 0);
  } finally { await g.close(); }
});

test('Responses：instructions 接在后面、input 是字符串就接字符串；流式收尾那几个事件里的整段文字也剥', async () => {
  const g = await setup();
  try {
    const note = N({ kind: 'note', text: 'Responses 的小记' });
    g.up.reply = (r, res) => sendJson(res, { id: 'r1', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '嗯。' + note, annotations: [] }] }] });
    const r = await g.call(`/gw/${K}/a/v1/responses`, { body: { model: 'm', instructions: '你是 TA', input: '在吗' } });
    const sent = g.up.seen[0].json;
    assert.ok(sent.instructions.startsWith('你是 TA\n\n〔记忆库 · 开场〕'));
    assert.match(sent.input, /^在吗\n\n〔现在/);
    const out = JSON.parse(r.text).output;
    assert.deepEqual(out[0], { type: 'reasoning', summary: [] });
    assert.equal(out[1].content[0].text, '嗯。');
    assert.ok(mem(g.store).includes('Responses 的小记'));

    // 流式 + 块数组的 input
    const full = '嗯嗯。' + N({ kind: 'note', text: '流式 Responses' });
    const msg = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: full }] };
    g.up.reply = (r2, res) => sse(res, [
      { event: 'response.created', data: { type: 'response.created', response: { id: 'r2', output: [] } } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: '嗯嗯。<!' } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: '--note {"kind":"note",' } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: 'i1', content_index: 0, delta: '"text":"流式 Responses"} -->' } },
      { event: 'response.output_text.done', data: { type: 'response.output_text.done', item_id: 'i1', content_index: 0, text: full } },
      { event: 'response.output_item.done', data: { type: 'response.output_item.done', item: msg } },
      { event: 'response.completed', data: { type: 'response.completed', response: { id: 'r2', output: [msg] } } },
    ]);
    const input = [{ role: 'user', content: [{ type: 'input_text', text: '在吗' }] }, { role: 'assistant', content: '在' }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: '想你' }, { type: 'input_image', image_url: 'data:x' }] }];
    const r2 = await g.call(`/gw/${K}/a/v1/responses`, { body: { stream: true, input } });
    const sent2 = g.up.seen[1].json.input;
    assert.deepEqual(sent2.slice(0, 2), input.slice(0, 2));
    assert.deepEqual(sent2[2].content.slice(0, 2), input[2].content);
    assert.equal(sent2[2].content[2].type, 'input_text');
    assert.ok(sent2[2].content[2].text.startsWith('〔现在'));
    assert.ok(r2.text.includes('event: response.output_text.delta\ndata: '));
    const ev = events(r2.text);
    assert.equal(ev.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join(''), '嗯嗯。');
    assert.equal(ev.find((e) => e.type === 'response.output_text.done').text, '嗯嗯。');
    assert.equal(ev.find((e) => e.type === 'response.completed').response.output[0].content[0].text, '嗯嗯。');
    assert.ok(!r2.text.includes('<!--'));
    assert.ok(mem(g.store).includes('流式 Responses'));
  } finally { await g.close(); }
});

test('Anthropic·非流式：system 块数组接在最后、cache_control 和工具调用、图片、思考块都没动；x-api-key 转到上游', async () => {
  const g = await setup();
  try {
    const reply = { id: 'm1', type: 'message', role: 'assistant', content: [
      { type: 'thinking', thinking: '想一想 <!--note {"kind":"note","text":"思考里的不算"} -->', signature: 'sig' },
      { type: 'text', text: '看到了。' + N({ kind: 'note', text: '她发了张猫的照片' }) },
      { type: 'tool_use', id: 't2', name: 'save', input: { a: 1 } },
    ], stop_reason: 'tool_use' };
    g.up.reply = (r, res) => sendJson(res, reply);
    const system = [{ type: 'text', text: '你是 TA' }, { type: 'text', text: '长长的设定', cache_control: { type: 'ephemeral' } }];
    const messages = [
      { role: 'user', content: '帮我查天气' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '…', signature: 's' }, { type: 'tool_use', id: 't1', name: 'weather', input: { city: '杭州' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '晴' }] },
      { role: 'assistant', content: '晴天。' },
      { role: 'user', content: [{ type: 'text', text: '看这个', cache_control: { type: 'ephemeral' } }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    ];
    const r = await g.call(`/gw/${K}/a/v1/messages`, { body: { model: 'c', system, messages }, headers: { 'x-api-key': 'ak-test-456', 'anthropic-version': '2023-06-01' } });
    const sent = g.up.seen[0];
    assert.equal(sent.url, '/an/v1/messages');
    assert.equal(sent.headers['x-api-key'], 'ak-test-456');
    assert.equal(sent.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(sent.json.system.slice(0, 2), system);
    assert.ok(sent.json.system[2].text.startsWith('〔记忆库 · 开场〕'));
    assert.deepEqual(sent.json.messages.slice(0, 4), messages.slice(0, 4));
    const last = sent.json.messages[4].content;
    assert.deepEqual(last.slice(0, 2), messages[4].content);
    assert.equal(last.length, 3);
    assert.ok(last[2].type === 'text' && last[2].text.startsWith('〔现在') && !last[2].cache_control);
    const got = JSON.parse(r.text);
    assert.deepEqual(got.content[0], reply.content[0]);
    assert.equal(got.content[1].text, '看到了。');
    assert.deepEqual(got.content[2], reply.content[2]);
    assert.deepEqual(mem(g.store), ['她发了张猫的照片']);
  } finally { await g.close(); }
});

test('Anthropic·流式：文字剥小记，工具和思考的事件一个字节都不改；工具回来的中间一步不重算、带同一段', async () => {
  const g = await setup();
  try {
    const evs = [
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm', content: [] } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '<!--note 不是文字块 -->' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '我去查。<' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '!--note {"kind":"note","text":"Anthropic 流"} --' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '>' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'weather', input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"<!--note"}' } } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ];
    g.up.reply = (r, res) => sse(res, evs);
    const first = [{ role: 'user', content: '杭州天气' }];
    const r = await g.call(`/gw/${K}/a/v1/messages`, { body: { stream: true, system: '你是 TA', messages: first } });
    const sent = g.up.seen[0].json;
    assert.ok(sent.system.startsWith('你是 TA\n\n〔记忆库 · 开场〕'));
    const blocks = r.text.split('\n\n').filter(Boolean);
    const orig = evs.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}`);
    for (const i of [0, 1, 2, 3, 4, 8, 9, 10, 11, 12]) assert.equal(blocks[i], orig[i]);
    assert.equal(events(r.text).filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join(''), '我去查。');
    assert.deepEqual(mem(g.store), ['Anthropic 流']);

    // 工具回来的中间一步：不再调开场和每条消息前，她那句带上同一段，前面的缓存才对得上
    g.up.reply = (r2, res) => sendJson(res, { content: [{ type: 'text', text: '晴。' }] });
    const second = [...first, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'weather', input: { city: '杭州' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '晴' }] }];
    await g.call(`/gw/${K}/a/v1/messages`, { body: { system: '你是 TA', messages: second } });
    assert.equal(g.calls.start.length, 1);
    assert.equal(g.calls.before.length, 1);
    const sent2 = g.up.seen[1].json;
    assert.equal(sent2.system, sent.system);
    assert.equal(sent2.messages[0].content, sent.messages[0].content);
    assert.deepEqual(sent2.messages.slice(1), second.slice(1));
  } finally { await g.close(); }
});

test('Gemini·非流式：systemInstruction 多一个 part、她那句多一个 part、网址里的 key= 原样转', async () => {
  const g = await setup();
  try {
    g.up.reply = (r, res) => sendJson(res, { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '想法', thought: true }, { text: '早。' + N({ kind: 'note', text: 'Gemini 的小记' }) }] } }] });
    const body = { contents: [{ role: 'user', parts: [{ text: '早' }, { inlineData: { mimeType: 'image/png', data: 'AA' } }] }], systemInstruction: { parts: [{ text: '你是 TA' }] } };
    const r = await g.call(`/gw/${K}/a/v1beta/models/gemini-x:generateContent?key=gk-test-789`, { body });
    const sent = g.up.seen[0];
    assert.equal(sent.url, '/ge/v1beta/models/gemini-x:generateContent?key=gk-test-789');
    assert.equal(sent.json.systemInstruction.parts[0].text, '你是 TA');
    assert.ok(sent.json.systemInstruction.parts[1].text.startsWith('〔记忆库 · 开场〕'));
    assert.deepEqual(sent.json.contents[0].parts.slice(0, 2), body.contents[0].parts);
    assert.ok(sent.json.contents[0].parts[2].text.startsWith('〔现在'));
    const parts = JSON.parse(r.text).candidates[0].content.parts;
    assert.deepEqual(parts, [{ text: '想法', thought: true }, { text: '早。' }]);
    assert.deepEqual(mem(g.store), ['Gemini 的小记']);
  } finally { await g.close(); }
});

test('Gemini·流式（alt=sse）：x-goog-api-key 转到上游，小记跨事件也剥得掉；snake_case 的 system_instruction 跟着用', async () => {
  const g = await setup();
  try {
    const ev = (text) => ({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] } }] });
    g.up.reply = (r, res) => sse(res, [ev('早'), ev('呀。<!--'), ev('note {"kind":"note","text":"Gemini 流"}'), ev(' -->'), { candidates: [{ index: 0, content: { parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 9 } }]);
    const body = { system_instruction: { parts: [{ text: '你是 TA' }] }, contents: [{ role: 'user', parts: [{ text: '早' }] }] };
    const r = await g.call(`/gw/${K}/a/v1beta/models/gemini-x:streamGenerateContent?alt=sse`, { body, headers: { 'x-goog-api-key': 'gk-test-000' } });
    const sent = g.up.seen[0];
    assert.equal(sent.headers['x-goog-api-key'], 'gk-test-000');
    assert.equal(sent.json.systemInstruction, undefined);
    assert.equal(sent.json.system_instruction.parts.length, 2);
    const es = events(r.text);
    assert.equal(es.map((e) => e.candidates[0].content.parts[0].text).join(''), '早呀。');
    assert.equal(es.at(-1).usageMetadata.totalTokenCount, 9);
    assert.ok(!r.text.includes('<!--') && !r.text.includes('Gemini 流'));
    assert.deepEqual(mem(g.store), ['Gemini 流']);
  } finally { await g.close(); }
});

test('上游报错：状态码、头、内容原样回', async () => {
  const g = await setup();
  try {
    const err = '{"error":{"message":"rate limited","type":"rate_limit"}}';
    g.up.reply = (r, res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' }); res.end(err); };
    const r = await g.call(`/gw/${K}/a/v1/messages`, { body: { messages: [{ role: 'user', content: '嗨' }] } });
    assert.equal(r.status, 429);
    assert.equal(r.headers['retry-after'], '3');
    assert.equal(r.text, err);
    assert.equal(g.calls.after.length, 0);
  } finally { await g.close(); }
});

test('记忆这边出错不卡聊天：hooks 全抛错 → 请求原样转、回复照样回；请求体不是 JSON 也原样转', async () => {
  const boom = () => { throw new Error('记忆库坏了'); };
  const g = await setup({ wrap: { start: boom, before: boom, after: boom } });
  try {
    g.up.reply = (r, res) => sendJson(res, { choices: [{ index: 0, message: { role: 'assistant', content: '在。' + N({ kind: 'note', text: 'x' }) } }] });
    const raw = '{ "messages": [ {"role":"user","content":"在吗"} ] }';
    const r = await g.call(`/gw/${K}/a/v1/chat/completions`, { body: raw });
    assert.equal(g.up.seen[0].raw, raw); // 一个字节都没动
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).choices[0].message.content, '在。');
    assert.equal(g.logs.filter((l) => l.includes('记忆库坏了')).length, 3);

    g.up.reply = (r2, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('上游回的不是 JSON'); };
    const r2 = await g.call(`/gw/${K}/a/v1/chat/completions`, { body: 'not json at all' });
    assert.equal(g.up.seen[1].raw, 'not json at all');
    assert.deepEqual([r2.status, r2.text], [200, '上游回的不是 JSON']);
    assert.ok(!g.logs.some((l) => l.includes('not json')));
  } finally { await g.close(); }
});

test('别的路径原样转、按路径找上游；没配的那家回 502 加中文说明；上游连不上回 502', async () => {
  const g = await setup();
  try {
    g.up.reply = (r, res) => { res.writeHead(200, { 'content-type': 'application/json', 'x-up': '1' }); res.end('{"data":[]}'); };
    const r = await g.call(`/gw/${K}/a/v1/models?limit=5`, { method: 'GET', headers: { authorization: 'Bearer sk-x' } });
    assert.deepEqual([r.status, r.text, r.headers['x-up']], [200, '{"data":[]}', '1']);
    assert.deepEqual([g.up.seen[0].method, g.up.seen[0].url, g.up.seen[0].headers.authorization], ['GET', '/oa/v1/models?limit=5', 'Bearer sk-x']);
    const body = '{"messages":[{"role":"user","content":"数一数"}]}';
    await g.call(`/gw/${K}/a/v1/messages/count_tokens`, { body });
    assert.deepEqual([g.up.seen[1].url, g.up.seen[1].raw], ['/an/v1/messages/count_tokens', body]);
    await g.call(`/gw/${K}/a/v1beta/models`, { method: 'GET' });
    assert.equal(g.up.seen[2].url, '/ge/v1beta/models');
    assert.equal(g.calls.before.length, 0);
  } finally { await g.close(); }

  const g2 = await setup({ upstream: { openai: 'http://127.0.0.1:1' } });
  try {
    const r = await g2.call(`/gw/${K}/a/v1beta/models/x:generateContent`, { body: { contents: [] } });
    assert.equal(r.status, 502);
    assert.match(JSON.parse(r.text).error.message, /没配 UPSTREAM_GEMINI/);
    const r2 = await g2.call(`/gw/${K}/a/v1/chat/completions`, { body: { messages: [{ role: 'user', content: '嗨' }] } });
    assert.equal(r2.status, 502);
  } finally { await g2.close(); }
});

test('请求体太大：不看，边读边原样转', async () => {
  const up = fakeUpstream();
  up.reply = (r, res) => sendJson(res, { choices: [{ index: 0, message: { content: '收到' } }] });
  await new Promise((ok) => up.server.listen(0, '127.0.0.1', ok));
  const calls = [];
  const gw = makeGateway({ key: K, upstream: { openai: `http://127.0.0.1:${up.server.address().port}` }, hooks: { start: () => calls.push(1), before: () => calls.push(1), after: () => {} }, maxBody: 100 });
  const srv = http.createServer(gw);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const raw = JSON.stringify({ messages: [{ role: 'user', content: '长'.repeat(500) }] });
    const r = await new Promise((ok) => {
      const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: `/gw/${K}/a/v1/chat/completions`, method: 'POST', headers: { 'content-length': Buffer.byteLength(raw) } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => ok(t)); });
      req.write(raw.slice(0, 50));
      setTimeout(() => req.end(raw.slice(50)), 20);
    });
    assert.equal(up.seen[0].raw, raw);
    assert.equal(up.seen[0].headers['content-length'], String(Buffer.byteLength(raw)));
    assert.equal(JSON.parse(r).choices[0].message.content, '收到');
    assert.equal(calls.length, 0);
  } finally {
    await new Promise((ok) => srv.close(ok));
    up.server.closeAllConnections();
    await new Promise((ok) => up.server.close(ok));
  }
});

test('网关口令：没设回 503、不对回 401（不调记忆、不转上游、不进日志）、对了才转', async () => {
  const g = await setup({ key: '' });
  try {
    const r = await g.call('/gw/whatever/a/v1/chat/completions', { body: { messages: [{ role: 'user', content: '嗨' }] } });
    assert.equal(r.status, 503);
    assert.match(JSON.parse(r.text).error.message, /GATEWAY_KEY/);
    assert.equal(g.up.seen.length, 0);
  } finally { await g.close(); }

  const g2 = await setup();
  try {
    g2.up.reply = (r, res) => sendJson(res, { choices: [{ index: 0, message: { content: '在' } }] });
    const body = { messages: [{ role: 'user', content: '嗨' }] };
    for (const p of ['/gw/wrong-key/a/v1/chat/completions', `/gw/${K}x/a/v1/chat/completions`, '/gw//a/v1/chat/completions', '/gw/a/v1/chat/completions']) {
      const r = await g2.call(p, { body });
      assert.equal(r.status, 401, p);
      assert.equal(JSON.parse(r.text).error.message, '网关口令不对');
    }
    assert.equal(g2.up.seen.length, 0);
    assert.equal(g2.calls.before.length, 0);
    assert.ok(g2.logs.length > 0 && !g2.logs.some((l) => l.includes('wrong-key') || l.includes(K)));
    assert.equal((await g2.call(`/gw/${K}/a/v1/chat/completions`, { body })).status, 200);
    assert.equal((await g2.call(`/gw/${K}`, { method: 'GET' })).status, 404); // 口令对、没写 ai
    assert.equal(g2.up.seen.length, 1);
  } finally { await g2.close(); }
});

test('设置：三家上游地址和网关口令从 .env 或环境里读', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-cfg-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, '.env'), 'UPSTREAM_OPENAI=http://127.0.0.1:9\nUPSTREAM_GEMINI="http://g"\nGATEWAY_KEY=abc\n');
  const c = loadConfig(dir, { UPSTREAM_ANTHROPIC: 'http://a' });
  assert.deepEqual(c.upstream, { openai: 'http://127.0.0.1:9', anthropic: 'http://a', gemini: 'http://g' });
  assert.equal(c.gatewayKey, 'abc');
  assert.equal(loadConfig(dir, { GATEWAY_KEY: 'from-env' }).gatewayKey, 'from-env');
});
