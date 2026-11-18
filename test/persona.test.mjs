// 人格 md：@ 展开、TA 在小记里改、她在网页上改（锁、旧版、退回、引用文件）、网关四种协议放最前面、导入（md、角色卡 JSON、带卡的 PNG）。
// 全在本机：假上游是测试进程里起的 HTTP 服务，不发外网请求。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { openStore } from '../lib/store.mjs';
import { createServer } from '../lib/server.mjs';
import { makeHooks } from '../lib/hooks.mjs';
import { openPersona, expand, okName, importPersona, cardToMd } from '../lib/persona.mjs';

const N = (o) => `<!--note ${JSON.stringify(o)} -->`;
const K = 'gk-persona-test';
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // 自己建的临时目录自己清

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-ps-'));
  dirs.push(dir);
  const clock = { t: Date.UTC(2026, 10, 15, 4) };
  const s = openStore({ dir, tz: 'Asia/Shanghai', now: () => clock.t });
  const p = openPersona({ store: s });
  return { s, p, dir, clock, h: makeHooks({ store: s, tz: 'Asia/Shanghai', persona: p }) };
}
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 0; };
async function serve(opts) {
  const srv = createServer(opts);
  const { port } = await srv.listen();
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { code: r.status, body: json, text };
  };
  return { srv, port, call };
}

test('@ 展开：行内和独占一行都认；最多三层；循环引用不死循环；找不到的、名字不对的原样留着', () => {
  const files = { 'a.md': '甲 @b.md', 'b.md': '乙\n@c.md', 'c.md': '丙 @d.md', 'd.md': '丁', 'x.md': '叉 @y.md', 'y.md': '歪 @x.md', '说话.md': '轻一点' };
  const read = (n) => files[n] ?? null;
  assert.equal(expand('开头 @a.md 结尾', read), '开头 甲 乙\n丙 @d.md 结尾'); // 第四层不展开
  assert.equal(expand('@说话.md', read), '轻一点');
  assert.equal(expand('看 @d.md。', read), '看 丁。');
  assert.equal(expand('看 @d.md.', read), '看 丁.'); // 句末的点不算名字
  assert.equal(expand('@x.md', read), '叉 歪 @x.md'); // 循环：绕回来的那个原样留着
  assert.equal(expand('@没有.md 和 me@d.md 和 @../d.md 和 @d.txt', read), '@没有.md 和 me@d.md 和 @../d.md 和 @d.txt');
  assert.deepEqual(['a.md', '说话.md', 'a-b_c.1.md'].map(okName), [true, true, true]);
  assert.deepEqual(['../a.md', 'a/b.md', 'a..b.md', '.md', 'a.txt', 'a b.md', ''].map(okName), [false, false, false, false, false, false, false]);
});

test('TA 在小记里改：old 空在末尾另起一段；old 要恰好出现一次；超 4000 字拒绝；留旧版；开关关着也能改；回复之后带 marks', () => {
  const { s, p, h, dir } = fresh();
  let r = h.after('a', { reply: '嗯。' + N({ persona: { new: '我说话慢一点。' } }) });
  assert.deepEqual([r.notes, r.errors, r.marks], [1, [], [{ kind: 'persona', op: 'edit' }]]);
  assert.equal(p.raw('a'), '我说话慢一点。');
  h.after('a', { reply: N({ persona: { old: '', new: '喜欢下雨天。' } }) });
  assert.equal(p.raw('a'), '我说话慢一点。\n\n喜欢下雨天。');
  r = h.after('a', { reply: N({ persona: { old: '慢一点', new: '轻一点' } }) + N({ persona: { old: '没有这句', new: 'x' } }) + N({ persona: { old: '。', new: '！' } }) + N({ persona: { new: '长'.repeat(4001) } }) + N({ persona: { new: '  ' } }) });
  assert.equal(r.notes, 1);
  assert.deepEqual(r.errors, ['人格里找不到要改的那句', '那句不止一处，写长一点', '一次最多改 4000 字', '要加进人格的内容是空的']);
  assert.equal(p.raw('a'), '我说话轻一点。\n\n喜欢下雨天。');
  assert.equal(s.getCfg('a').persona, false); // 开关一直关着
  const g = p.get('a');
  assert.deepEqual(g.hist.map((e) => [e.who, e.old, e.new]), [['ai', '慢一点', '轻一点'], ['ai', '', '喜欢下雨天。'], ['ai', '', '我说话慢一点。']]);
  assert.ok(!('full' in g.hist[0])); // 旧全文不往外给
  assert.equal(fs.statSync(path.join(dir, 'a', 'persona.md')).mode & 0o777, 0o600);
  assert.ok(s.readLog('a').some((e) => e.who === 'ai' && e.op === 'persona' && !e.text));
  // 没有改人格的回复：marks 是空的
  assert.deepEqual(h.after('a', { reply: '好。' }).marks, []);
  // 没接人格的钩子：这一条记成错，不影响别的
  const h2 = makeHooks({ store: s, tz: 'Asia/Shanghai' });
  r = h2.after('a', { reply: N({ persona: { new: 'x' } }) + N({ kind: 'note', text: '她爱吃面' }) });
  assert.deepEqual([r.notes, r.errors], [1, ['这里没有人格可改']]);
});

test('开关开着时开场多一句「人格你也能改」；钩子这条路的开场不带人格正文', () => {
  const { p, h } = fresh();
  p.put('a', { text: '我叫阿岛，说话很轻。' });
  assert.ok(!h.start('a', {}).context.includes('"persona"'));
  p.put('a', { on: true });
  const c = h.start('a', {}).context;
  assert.ok(c.includes('"persona"') && !c.includes('我叫阿岛'));
});

test('她在网页上改：锁着改正文要开锁、改开关不用；8000 字提醒；引用文件读写删（删了也能退回）；退回某一版；导出；旧版最多 20 版', async () => {
  const { s, p, dir, clock } = fresh();
  const { srv, call } = await serve({ cfg: { port: 0, hookToken: 'tok' }, store: s, persona: p });
  try {
    let r = await call('PUT', '/api/persona/a', { text: '第一版\n@说话.md' });
    assert.deepEqual(r.body, { on: false, text: '第一版\n@说话.md', files: [] });
    await call('PUT', '/api/memory/a/lock', { pass: 'pw' });
    clock.t += 1000;
    assert.equal((await call('PUT', '/api/persona/a', { text: '偷改' })).code, 423);
    assert.equal((await call('PUT', '/api/persona/a', { on: true })).body.on, true); // 开关不用开锁
    assert.equal((await call('PUT', '/api/persona/a/files/' + encodeURIComponent('说话.md'), { text: '轻一点' })).code, 423);
    const { token } = (await call('POST', '/api/memory/a/unlock', { pass: 'pw' })).body;
    const U = { 'x-mem-unlock': token };
    r = await call('PUT', '/api/persona/a/files/' + encodeURIComponent('说话.md'), { text: '轻一点' }, U);
    assert.equal(r.code, 200);
    assert.deepEqual((await call('GET', '/api/persona/a/files/' + encodeURIComponent('说话.md'))).body, { name: '说话.md', text: '轻一点' });
    assert.equal((await call('PUT', '/api/persona/a/files/' + encodeURIComponent('../x.md'), { text: 'x' }, U)).code, 400);
    assert.equal((await call('PUT', '/api/persona/a/files/' + encodeURIComponent('a..b.md'), { text: 'x' }, U)).code, 400);
    assert.equal((await call('GET', '/api/persona/a/files/nope.md')).code, 404);
    assert.equal(p.inject('a'), '第一版\n轻一点'); // 网关带的是展开后的
    clock.t += 1000;
    r = await call('PUT', '/api/persona/a', { text: '第二版\n@说话.md' }, U);
    assert.equal(r.body.text, '第二版\n@说话.md'); // 回的是没展开的原文
    assert.deepEqual(r.body.files, ['说话.md']);
    assert.equal(r.body.warn, undefined);
    const g = (await call('GET', '/api/persona/a')).body;
    assert.deepEqual(g.hist.map((e) => [e.who, e.file || '', e.old, e.new]), [['me', '', '一', '二'], ['me', '说话.md', '', '轻一点'], ['me', '', '', '第一版\n@说话.md']]);
    // 删引用文件：要开锁；真删，但旧的留了一版
    assert.equal((await call('DELETE', '/api/persona/a/files/' + encodeURIComponent('说话.md'))).code, 423);
    clock.t += 1000;
    assert.equal((await call('DELETE', '/api/persona/a/files/' + encodeURIComponent('说话.md'), undefined, U)).code, 200);
    assert.ok(!fs.existsSync(path.join(dir, 'a', 'persona', '说话.md')));
    assert.equal(p.inject('a'), '第二版\n@说话.md');
    const delT = (await call('GET', '/api/persona/a')).body.hist[0].t;
    assert.equal((await call('POST', '/api/persona/a/back', { t: delT }, U)).code, 200);
    assert.equal(p.inject('a'), '第二版\n轻一点');
    // 退回正文：回到「第二版」那次改动之前
    const t2 = g.hist[0].t;
    assert.equal((await call('POST', '/api/persona/a/back', { t: t2 })).code, 423);
    r = await call('POST', '/api/persona/a/back', { t: t2 }, U);
    assert.equal(r.body.text, '第一版\n@说话.md');
    assert.equal((await call('GET', '/api/persona/a')).body.hist[0].back, t2); // 退回本身也留一版
    assert.equal((await call('POST', '/api/persona/a/back', { t: 1 }, U)).code, 404);
    // 导出：展开前的原文 + 引用文件
    const ex = (await call('GET', '/api/persona/a/export')).body;
    assert.deepEqual([ex.text, ex.files], ['第一版\n@说话.md', [{ name: '说话.md', text: '轻一点' }]]);
    // 超过 8000 字：提醒，不拦
    r = await call('PUT', '/api/persona/a', { text: '长'.repeat(7998) + '\n@说话.md' }, U);
    assert.equal(r.code, 200);
    assert.match(r.body.warn, /越长越不照着做/);
    // 旧版最多 20 版
    for (let i = 0; i < 25; i++) p.edit('a', { new: '第' + i + '段' });
    assert.equal(p.get('a').hist.length, 20);
    assert.equal(fs.statSync(path.join(dir, 'a', 'persona.hist.json')).mode & 0o777, 0o600);
    assert.equal((await call('PUT', '/api/persona/a', { text: 3 }, U)).code, 400);
    assert.equal((await call('GET', '/api/persona/..%2Fx')).code, 400);
  } finally { await srv.close(); }
  // 没接人格的后端：这几个地址都没有
  const { srv: s2, call: c2 } = await serve({ cfg: { port: 0 }, store: s });
  try { assert.equal((await c2('GET', '/api/persona/a')).code, 404); } finally { await s2.close(); }
});

// ---- 网关 ----
function fakeUp() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const cs = [];
    req.on('data', (c) => cs.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, json: JSON.parse(Buffer.concat(cs).toString('utf8')) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return { seen, server };
}

test('网关：开着且不空时人格在 system 最前面（四种协议，开场那段和 App 自带的在后面）；关着或空着一点不动', async () => {
  const { s, p, h } = fresh();
  const up = fakeUp();
  await new Promise((ok) => up.server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${up.server.address().port}`;
  const { srv, call } = await serve({ cfg: { port: 0, gatewayKey: K, upstream: { openai: base, anthropic: base, gemini: base } }, store: s, hooks: h, persona: p });
  const P = '我叫阿岛。\n说话很轻。';
  const send = async (rest, body) => { await call('POST', `/gw/${K}/a${rest}`, body); return up.seen.at(-1).json; };
  const chat = () => ({ model: 'm', messages: [{ role: 'system', content: 'App 的' }, { role: 'user', content: '在吗' }] });
  try {
    // 关着：跟没有人格一样
    p.put('a', { text: P });
    let j = await send('/v1/chat/completions', chat());
    assert.ok(j.messages[0].content.startsWith('〔记忆库 · 开场〕'));
    assert.ok(!JSON.stringify(j).includes('我叫阿岛'));
    p.put('a', { on: true });
    // 对话式
    j = await send('/v1/chat/completions', chat());
    assert.deepEqual(j.messages[0], { role: 'system', content: P });
    assert.ok(j.messages[1].content.startsWith('〔记忆库 · 开场〕'));
    assert.deepEqual(j.messages[2], { role: 'system', content: 'App 的' });
    // Responses
    j = await send('/v1/responses', { model: 'm', instructions: 'App 的', input: '在吗' });
    assert.ok(j.instructions.startsWith(P + '\n\nApp 的'));
    // Anthropic：块数组，App 标的 cache_control 跟着它那块
    j = await send('/v1/messages', { model: 'm', system: [{ type: 'text', text: 'App 的', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: '在吗' }] });
    assert.deepEqual(j.system[0], { type: 'text', text: P });
    assert.deepEqual(j.system[1], { type: 'text', text: 'App 的', cache_control: { type: 'ephemeral' } });
    j = await send('/v1/messages', { model: 'm', system: 'App 的', messages: [{ role: 'user', content: '在吗' }] });
    assert.ok(j.system.startsWith(P + '\n\nApp 的'));
    j = await send('/v1/messages', { model: 'm', messages: [{ role: 'user', content: '在吗' }] });
    assert.ok(j.system.startsWith(P + '\n\n〔记忆库'));
    // Gemini 两种写法
    j = await send('/v1beta/models/g:generateContent', { systemInstruction: { parts: [{ text: 'App 的' }] }, contents: [{ role: 'user', parts: [{ text: '在吗' }] }] });
    assert.deepEqual(j.systemInstruction.parts[0], { text: P });
    assert.deepEqual(j.systemInstruction.parts[1], { text: 'App 的' });
    j = await send('/v1beta/models/g:generateContent', { system_instruction: 'App 的', contents: [{ role: 'user', parts: [{ text: '在吗' }] }] });
    assert.deepEqual(j.system_instruction.parts.map((x) => x.text.slice(0, 5)), [P.slice(0, 5), 'App 的', '〔记忆库 ']);
    // 每次请求都带（不只是开场）
    const before = up.seen.length;
    await send('/v1/chat/completions', { messages: [{ role: 'user', content: '在吗' }, { role: 'assistant', content: '在' }, { role: 'user', content: '嗯' }] });
    assert.equal(up.seen.length, before + 1);
    assert.deepEqual(up.seen.at(-1).json.messages[0], { role: 'system', content: P });
    // 开着但空着：不动
    p.put('a', { text: '   ' });
    j = await send('/v1/chat/completions', chat());
    assert.ok(j.messages[0].content.startsWith('〔记忆库'));
    // 人格读出错：当没有，照常转
    const { srv: s3, call: c3 } = await serve({ cfg: { port: 0, gatewayKey: K, upstream: { openai: base } }, store: s, hooks: h, persona: { inject: () => { throw new Error('坏了'); } } });
    try { assert.equal((await c3('POST', `/gw/${K}/a/v1/chat/completions`, chat())).code, 200); } finally { await s3.close(); }
  } finally {
    await srv.close();
    up.server.closeAllConnections();
    await new Promise((ok) => up.server.close(ok));
  }
});

// ---- 导入 ----
// 拼一个最小的 PNG：IHDR + 几个 tEXt + IEND
function png(texts = {}, { bad = false } = {}) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(bad && type === 'tEXt' ? data.length + 999 : data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    ...Object.entries(texts).map(([k, v]) => chunk('tEXt', Buffer.from(k + '\0' + v, 'latin1'))), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const CARD = {
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: '小雨', description: '{{char}}是一只住在{{user}}窗台上的猫。', personality: '懒，嘴硬心软', scenario: '',
    mes_example: '<START>\n{{user}}：早\n{{char}}：喵。', first_mes: '{{user}}，你回来啦。', alternate_greetings: ['又是你，{{user}}。', ''],
    system_prompt: '别替{{user}}说话。', post_history_instructions: '',
    character_book: { entries: [{ keys: ['窗台'], content: 'x' }, { keys: ['鱼'], content: 'y' }] },
  },
};

test('导入：md / txt 原样；酒馆角色卡 v2 转成中文分节、换掉 {{char}} {{user}}、开场白单列、世界书不转只说明；v1 也认；替换词能改', () => {
  assert.deepEqual(importPersona({ name: 'CLAUDE.md', text: '# 我\n@说话.md', files: [{ name: '说话.md', text: '轻' }] }), { text: '# 我\n@说话.md', files: [{ name: '说话.md', text: '轻' }] });
  assert.equal(importPersona({ name: 'a.txt', text: '原样' }).text, '原样');
  assert.equal(code(() => importPersona({ name: 'a.md', text: 'x', files: [{ name: '../x.md', text: '' }] })), 400);
  const r = importPersona({ name: '小雨.json', text: JSON.stringify(CARD) });
  assert.equal(r.text, '# 小雨\n\n## 设定\n\n小雨是一只住在她窗台上的猫。\n\n## 性格\n\n懒，嘴硬心软\n\n## 说话的样子\n\n<START>\n她：早\n小雨：喵。\n\n## 另外的要求\n\n别替她说话。\n');
  assert.ok(!r.text.includes('## 场景')); // 空的小节不写
  assert.deepEqual(r.firstMes, ['她，你回来啦。', '又是你，她。']);
  assert.deepEqual(r.skipped, ['世界书 2 条']);
  assert.equal(importPersona({ name: 'c.json', text: JSON.stringify(CARD), user: '小满' }).firstMes[0], '小满，你回来啦。');
  const v1 = cardToMd({ name: '阿白', description: '<BOT>很高', personality: '', first_mes: '你好 <USER>' });
  assert.deepEqual([v1.text, v1.firstMes, v1.skipped], ['# 阿白\n\n## 设定\n\n阿白很高\n', ['你好 她'], []]);
  // 认不出的、坏的、世界书本身
  assert.equal(code(() => importPersona({ name: 'x.json', text: '{"foo":1}' })), 400);
  assert.equal(code(() => importPersona({ name: 'x.json', text: '{坏' })), 400);
  assert.equal(code(() => importPersona({ name: 'x.json', text: '{"entries":{"0":{}}}' })), 400);
  assert.equal(code(() => importPersona({ name: 'x.docx', text: 'x' })), 400);
});

test('导入：带卡的 PNG（v2 的 chara、v3 的 ccv3 先用）；不是 PNG、块长度越界、没卡都回 400 说清楚；走地址只转不存、上限 5 MB', async () => {
  const v3 = { spec: 'chara_card_v3', data: { ...CARD.data, name: '小雨三' } };
  let r = importPersona({ name: 'card.png', base64: png({ chara: b64(CARD) }).toString('base64') });
  assert.ok(r.text.startsWith('# 小雨\n'));
  r = importPersona({ name: 'card.png', base64: png({ chara: b64(CARD), ccv3: b64(v3) }).toString('base64') });
  assert.ok(r.text.startsWith('# 小雨三\n'));
  const msg = (body) => { try { importPersona(body); } catch (e) { return [e.code, e.message]; } return null; };
  assert.deepEqual(msg({ name: 'a.png', base64: Buffer.from('GIF89a....').toString('base64') }), [400, '不是 PNG 图片']);
  assert.deepEqual(msg({ name: 'a.png', base64: png({ chara: b64(CARD) }, { bad: true }).toString('base64') }), [400, 'PNG 的块长度不对，图可能坏了']);
  assert.deepEqual(msg({ name: 'a.png', base64: png({ Comment: 'hi' }).toString('base64') }), [400, '这张图里没有角色卡（没找到 chara / ccv3）']);
  assert.deepEqual(msg({ name: 'a.png', base64: png({ chara: 'bm90IGpzb24=' }).toString('base64') }), [400, '图里的角色卡解不开']);
  // 走地址
  const { s, p, dir } = fresh();
  const { srv, call } = await serve({ cfg: { port: 0 }, store: s, persona: p });
  try {
    const big = png({ chara: b64(CARD), Comment: 'x'.repeat(2 * 1024 * 1024) }); // 2 MB 多：超过平常的 1 MB，在 5 MB 以内
    r = await call('POST', '/api/persona/a/import', { name: 'card.png', base64: big.toString('base64') });
    assert.equal(r.code, 200);
    assert.deepEqual(r.body.firstMes, ['她，你回来啦。', '又是你，她。']);
    assert.ok(!fs.existsSync(path.join(dir, 'a', 'persona.md'))); // 只转不存
    // 超过 5 MB：后端回 413 并掐断连接（掐得快的话这边只看到连接断了）
    const over = await call('POST', '/api/persona/a/import', { name: 'a.png', text: 'x'.repeat(5.5 * 1024 * 1024) }).then((x) => x.code, () => 'reset');
    assert.ok([413, 'reset'].includes(over), String(over));
    assert.equal((await call('POST', '/api/persona/a/import', { name: 'x.json', text: '{"a":1}' })).code, 400);
  } finally { await srv.close(); }
});
