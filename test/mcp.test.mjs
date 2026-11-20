// MCP 口（/mcp/{ai}）：握手、协议版本、通知回 202、三个工具、错误、口令、一批。用测试进程里的 HTTP 请求，不接真的 Grok。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { makeHooks } from '../lib/hooks.mjs';
import { openTalk } from '../lib/talk.mjs';
import { createServer } from '../lib/server.mjs';
import { makeMcp, TOOLS } from '../lib/mcp.mjs';

const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // 自己建的临时目录自己清

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-mcp-'));
  dirs.push(dir);
  const now = () => Date.UTC(2026, 10, 15, 4);
  const store = openStore({ dir, tz: 'Asia/Shanghai', now, talk: openTalk({ dir, now }) });
  const hooks = makeHooks({ store, tz: 'Asia/Shanghai' });
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store, hooks, mcp: makeMcp({ hooks, version: '9.9.9' }) });
  const { port } = await srv.listen();
  let n = 0;
  const raw = async (body, { auth = 'Bearer tok', method = 'POST', ai = 'grok' } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp/${ai}`, { method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) },
      body: method === 'POST' ? JSON.stringify(body) : undefined });
    const t = await r.text();
    return { code: r.status, type: r.headers.get('content-type'), body: t ? JSON.parse(t) : null };
  };
  const rpc = async (method, params) => (await raw({ jsonrpc: '2.0', id: ++n, method, ...(params ? { params } : {}) })).body;
  const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { store, srv, raw, rpc, tool, port };
}

test('握手：回客户端要的协议版本（认得的），不认得的回最新的；initialized 通知回 202；ping；没口令 401；GET 回 405', async () => {
  const g = await setup();
  try {
    let r = await g.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'grok', version: '1' } });
    assert.equal(r.result.protocolVersion, '2025-06-18');
    assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(r.result.serverInfo, { name: 'ta-memory', version: '9.9.9' });
    assert.match(r.result.instructions, /memory_start/);
    assert.equal((await g.rpc('initialize', { protocolVersion: '2024-11-05' })).result.protocolVersion, '2024-11-05');
    assert.equal((await g.rpc('initialize', { protocolVersion: '2099-01-01' })).result.protocolVersion, '2025-11-25');
    const n = await g.raw({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.deepEqual([n.code, n.body], [202, null]);
    assert.deepEqual((await g.rpc('ping')).result, {});
    assert.equal((await g.raw({ jsonrpc: '2.0', id: 1, method: 'ping' }, { auth: 'Bearer nope' })).code, 401);
    assert.equal((await g.raw({ jsonrpc: '2.0', id: 1, method: 'ping' }, { auth: null })).code, 401);
    assert.equal((await g.raw(null, { method: 'GET' })).code, 405);
    assert.equal((await g.raw({ jsonrpc: '2.0', id: 1, method: 'ping' }, { ai: 'a b' })).code, 400);
    // 不认得的方法、不像请求的、一批
    assert.equal((await g.rpc('resources/list')).error.code, -32601);
    assert.equal((await g.raw({ id: 3, method: 'ping' })).body.error.code, -32600);
    const b = await g.raw([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }]);
    assert.deepEqual(b.body.map((x) => x.id), ['a', 'b']);
    assert.equal((await g.raw([{ jsonrpc: '2.0', method: 'notifications/cancelled' }])).code, 202);
  } finally { await g.srv.close(); }
});

test('三个工具：列表里有中文说明；开场 = hooks.start；想一想 = hooks.before（回时间和相近的）；记 = hooks.after（notes 或 reply）；参数不对、工具不存在回错', async () => {
  const g = await setup();
  try {
    const tools = (await g.rpc('tools/list')).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ['memory_start', 'memory_recall', 'memory_note', 'memory_read', 'memory_diary']); // 后来加了翻日记、读一条
    assert.deepEqual(tools, TOOLS);
    assert.ok(tools.every((t) => /[一-龥]/.test(t.description) && t.inputSchema.type === 'object'));
    let r = await g.tool('memory_start', {});
    assert.ok(r.content[0].text.startsWith('〔记忆库 · 开场〕') && !r.isError);
    assert.ok((await g.tool('memory_start', { source: 'compact' })).content[0].text.startsWith('〔记忆库 · 压缩之后〕'));
    r = await g.tool('memory_note', { notes: [{ kind: 'note', text: '她养了一只猫叫团子' }, { kind: 'nope', text: 'x' }] });
    assert.equal(r.content[0].text, '记了 1 条。\n没记上的：\n- 没有这种记忆：nope');
    assert.equal(r.isError, undefined);
    r = await g.tool('memory_note', { reply: '好呀。<!--note {"kind":"exp","text":"她喜欢猫"} -->' });
    assert.equal(r.content[0].text, '记了 1 条。');
    assert.deepEqual(g.store.talk.recent('grok').map((x) => [x.role, x.text]), [['ai', '好呀。']]);
    r = await g.tool('memory_recall', { text: '团子今天怎么样' });
    assert.match(r.content[0].text, /^〔现在 2026\/11\/15/);
    assert.ok(r.content[0].text.includes('她养了一只猫叫团子'));
    assert.equal(g.store.talk.recent('grok').at(-1).text, '团子今天怎么样');
    for (const [name, args] of [['memory_recall', {}], ['memory_note', {}], ['memory_note', { notes: 'x' }], ['memory_note', { reply: 3 }]]) {
      assert.equal((await g.tool(name, args)).isError, true, name + JSON.stringify(args));
    }
    assert.equal((await g.tool('memory_note', { notes: [{ kind: 'nope', text: 'x' }] })).isError, true); // 一条都没记上
    assert.equal((await g.rpc('tools/call', { name: 'rm_rf', arguments: {} })).error.code, -32602);
  } finally { await g.srv.close(); }
});

test('读一条：memory_read 回全文和连着的；没给 id、编号不对回错；钩子口令的 GET /api/hook/{ai}/read 也能读', async () => {
  const g = await setup();
  try {
    const a = g.store.add('grok', { kind: 'note', text: '她养了一只橘猫' }, 'me');
    const b = g.store.add('grok', { kind: 'pact', text: '每周五给团子买罐头', from: [a.id] }, 'me');
    let r = await g.tool('memory_read', { id: b.id });
    assert.ok(!r.isError);
    assert.ok(r.content[0].text.includes('每周五给团子买罐头') && r.content[0].text.includes(`它从这条来 [${a.id}]`));
    assert.equal((await g.tool('memory_read', {})).isError, true);
    r = await g.tool('memory_read', { id: 'nope' });
    assert.deepEqual([r.isError, r.content[0].text], [true, '没有这条记忆']);
    const h = await fetch(`http://127.0.0.1:${g.port}/api/hook/grok/read?id=${a.id}`, { headers: { authorization: 'Bearer tok' } });
    assert.equal(h.status, 200);
    assert.ok((await h.json()).text.includes(`从它生出来 [${b.id}]`));
    assert.equal((await fetch(`http://127.0.0.1:${g.port}/api/hook/grok/read?id=${a.id}`)).status, 401);
  } finally { await g.srv.close(); }
});

test('只露出点名的工具：?tools=read,diary 时列表只有这两样、别的调不了、开场说明换成短的；不认得的名字忽略', async () => {
  const g = await setup();
  try {
    const call = async (method, params, q) => {
      const r = await fetch(`http://127.0.0.1:${g.port}/mcp/grok${q}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }) });
      return r.json();
    };
    const q = '?tools=read,diary,nope';
    assert.deepEqual((await call('tools/list', null, q)).result.tools.map((t) => t.name), ['memory_read', 'memory_diary']);
    assert.match((await call('initialize', {}, q)).result.instructions, /钩子做/);
    assert.equal((await call('tools/call', { name: 'memory_start', arguments: {} }, q)).error.code, -32602);
    assert.ok(!(await call('tools/call', { name: 'memory_diary', arguments: {} }, q)).error);
    assert.equal((await call('tools/list', null, '')).result.tools.length, 5);
    assert.deepEqual((await call('tools/list', null, '?tools=')).result.tools, [], '空着就一个都不给');
    assert.equal((await call('tools/call', { name: 'memory_note', arguments: { reply: 'x' } }, '?tools=')).error.code, -32602);
  } finally { await g.srv.close(); }
});
