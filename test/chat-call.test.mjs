// 聊天新加的几样：她发的语音（voice 字段）、打电话的提醒（call）、回完之后（onReply）、单问一句（ask）、开屏字幕让 TA 自己写。
// 上游一律是这个测试进程里起的假 HTTP 服务，不发外网请求。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../lib/store.mjs';
import { createServer } from '../lib/server.mjs';
import { openPersona } from '../lib/persona.mjs';
import { openChat } from '../lib/chat.mjs';
import { openFiles } from '../lib/files.mjs';
import { openLockwords, SLOTS } from '../lib/lockwords.mjs';

const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60, 7)]);
const sse = (res, parts) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const t of parts) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: t } }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};
const WORDS = Object.fromEntries(SLOTS.map((k) => [k, ['one', 'two', 'three']]));
WORDS.zh = Object.fromEntries(SLOTS.map((k) => [k, ['一', '二', '三']]));

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-call-')); dirs.push(dir);
  let t = Date.UTC(2026, 10, 18, 4);
  const clock = { add: (ms) => { t += ms; } }, now = () => t;
  const store = openStore({ dir, now });
  const persona = openPersona({ store });
  const up = { seen: [], reply: (r, res) => sse(res, ['好', '的。']) };
  up.server = http.createServer((req, res) => {
    const c = []; req.on('data', (x) => c.push(x));
    req.on('end', () => { const r = { url: req.url, json: JSON.parse(Buffer.concat(c).toString('utf8')) }; up.seen.push(r); up.reply(r, res); });
  });
  await new Promise((ok) => up.server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${up.server.address().port}`;
  const files = openFiles({ dir, now });
  const replies = [];
  const chat = openChat({ dir, store, persona, files, upstream: { openai: base }, keyOf: () => 'k', now, onReply: (ai, m) => { replies.push([ai, m.id, m.text]); } });
  chat.setAis([{ id: 'o', model: 'gpt-x', style: 'openai', keyEnv: 'AI_KEY' }]);
  const lockwords = openLockwords({ dir, folder: (ai) => store.folder(ai), ask: (ai, p) => chat.ask(ai, p) });
  const srv = createServer({ cfg: { port: 0 }, store, persona, chat, files, lockwords });
  const { port } = await srv.listen();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* SSE */ }
    return { status: r.status, text, json };
  };
  const close = async () => { await srv.close(); up.server.closeAllConnections(); await new Promise((ok) => up.server.close(ok)); };
  return { dir, store, persona, chat, files, up, call, close, replies, clock };
}
const lastUser = (r) => r.json.messages.filter((m) => m.role === 'user').at(-1).content;

test('她发的语音：voice { file, dur } 存在她那句上、历史原样返回；发给模型的那份说是语音；没字也能发；乱填的报 400', async () => {
  const g = await setup();
  try {
    const f = g.files.saveBuf(WEBM, 'voice', { audio: true });
    let r = await g.call('POST', '/api/chat/o/send', { text: '你好呀', voice: { file: f.id, dur: 3.27 } });
    assert.equal(r.status, 200);
    assert.equal(lastUser(g.up.seen.at(-1)), '〔她发了一条语音（3 秒），下面是转出来的字〕\n你好呀');
    const items = (await g.call('GET', '/api/chat/o')).json.items;
    assert.deepEqual(items[0].voice, { file: f.id, dur: 3.3 });
    assert.equal(items[0].text, '你好呀');
    // 认不出字：text 空着也能发
    r = await g.call('POST', '/api/chat/o/send', { voice: { file: '/api/file/' + f.id } });
    assert.equal(r.status, 200);
    assert.match(lastUser(g.up.seen.at(-1)), /没认出字/);
    const img = g.files.saveBuf(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20)]), 'a.jpg');
    for (const v of [{ file: 'nope' }, { file: 'f' + 'a'.repeat(14) }, { file: img.id }, { file: f.id, dur: -1 }, 'x']) {
      assert.equal((await g.call('POST', '/api/chat/o/send', { text: 'x', voice: v })).status, 400, JSON.stringify(v));
    }
  } finally { await g.close(); }
});

test('打电话：call: true 在发给模型的那句末尾加提醒（不存）；一通里头一句整段、后面短的；过 30 分钟或 call: start 再整段', async () => {
  const g = await setup();
  try {
    await g.call('POST', '/api/chat/o/send', { text: '喂', call: true });
    assert.match(lastUser(g.up.seen.at(-1)), /^喂\n〔通话：她在跟你打电话/);
    await g.call('POST', '/api/chat/o/send', { text: '听得见吗', call: true });
    assert.equal(lastUser(g.up.seen.at(-1)), '听得见吗\n〔通话：你们正在通话中〕');
    await g.call('POST', '/api/chat/o/send', { text: '新的一通', call: 'start' });
    assert.match(lastUser(g.up.seen.at(-1)), /她在跟你打电话/);
    g.clock.add(31 * 60e3);
    await g.call('POST', '/api/chat/o/send', { text: '又打来了', call: true });
    assert.match(lastUser(g.up.seen.at(-1)), /她在跟你打电话/);
    await g.call('POST', '/api/chat/o/send', { text: '不打电话' });
    assert.equal(lastUser(g.up.seen.at(-1)), '不打电话');
    const items = (await g.call('GET', '/api/chat/o')).json.items;
    assert.ok(items.every((m) => !String(m.text || '').includes('通话')));
  } finally { await g.close(); }
});

test('回完之后调 onReply（id、文字）；上游出错不调', async () => {
  const g = await setup();
  try {
    await g.call('POST', '/api/chat/o/send', { text: '在吗' });
    await new Promise((ok) => setImmediate(ok));
    assert.equal(g.replies.length, 1);
    assert.deepEqual([g.replies[0][0], g.replies[0][2]], ['o', '好的。']);
    g.up.reply = (r, res) => { res.writeHead(500); res.end('{}'); };
    await g.call('POST', '/api/chat/o/send', { text: '再问' });
    assert.equal(g.replies.length, 1);
  } finally { await g.close(); }
});

test('单问一句（ask）：只带人格和这一句，不带聊天记录、不存；开屏字幕让 TA 写一套，回草稿，save: true 才存', async () => {
  const g = await setup();
  try {
    g.persona.put('o', { on: true, text: '你是一只猫。' });
    await g.call('POST', '/api/chat/o/send', { text: '先聊一句' });
    const before = g.chat.readAll('o').length;
    g.up.reply = (r, res) => sse(res, ['好的，这是：\n```json\n', JSON.stringify(WORDS), '\n```<!--note {"kind":"note","text":"x"} -->']);
    let r = await g.call('POST', '/api/lockwords/write', { ai: 'o' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.words, WORDS);
    const sent = g.up.seen.at(-1).json.messages;
    assert.ok(sent.some((m) => m.role === 'system' && /你是一只猫/.test(typeof m.content === 'string' ? m.content : JSON.stringify(m.content))));
    assert.equal(sent.filter((m) => m.role === 'user').length, 1);
    assert.match(lastUser(g.up.seen.at(-1)), /开屏锁屏/);
    assert.ok(!JSON.stringify(sent).includes('先聊一句'));
    assert.equal(g.chat.readAll('o').length, before);
    assert.deepEqual((await g.call('GET', '/api/lockwords?ai=o')).json, { words: null });
    r = await g.call('POST', '/api/lockwords/write', { ai: 'o', save: true });
    assert.equal(r.json.saved, true);
    assert.deepEqual((await g.call('GET', '/api/lockwords?ai=o')).json.words, WORDS);
    // 写坏了：502；没有这个 AI：404
    g.up.reply = (rq, res) => sse(res, ['不想写']);
    assert.equal((await g.call('POST', '/api/lockwords/write', { ai: 'o' })).status, 502);
    assert.equal((await g.call('POST', '/api/lockwords/write', { ai: 'zz' })).status, 404);
    assert.equal((await g.call('POST', '/api/lockwords/write', { ai: '../x' })).status, 400);
  } finally { await g.close(); }
});

test('开屏字幕：存、读、格式不对报 400；中文小字条数不够就不收 zh；文件 600', async () => {
  const g = await setup();
  try {
    assert.deepEqual((await g.call('GET', '/api/lockwords?ai=o')).json, { words: null });
    let r = await g.call('PUT', '/api/lockwords?ai=o', { words: WORDS });
    assert.deepEqual(r.json, { ok: true, words: WORDS });
    assert.equal(fs.statSync(path.join(g.dir, 'lockwords', 'o.json')).mode & 0o777, 0o600);
    const short = { ...WORDS, zh: { ...WORDS.zh, dawn: ['一'] } };
    r = await g.call('PUT', '/api/lockwords?ai=o', short); // 直接传 words 本身也行
    assert.equal(r.json.words.zh, undefined);
    const bad = { ...WORDS }; delete bad.noon;
    assert.equal((await g.call('PUT', '/api/lockwords?ai=o', { words: bad })).status, 400);
    assert.equal((await g.call('PUT', '/api/lockwords?ai=o', { words: { ...WORDS, dusk: [] } })).status, 400);
    assert.equal((await g.call('GET', '/api/lockwords?ai=a/b')).status, 400);
    const long = { ...WORDS, night: ['x'.repeat(100), 'b', 'c', 'd', 'e', 'f'] };
    r = await g.call('PUT', '/api/lockwords?ai=o', { words: long });
    assert.deepEqual([r.json.words.night.length, r.json.words.night[0].length], [5, 60]);
  } finally { await g.close(); }
});

test('改她最后一句（rewind）：后面的回复收进归档（gone+rewound），她那句换成新的、旧的留在 was，照新的一句重新回答；只许最后一句、她的、打字的', async () => {
  const g = await setup();
  try {
    await g.call('POST', '/api/chat/o/send', { text: '今天吃什么' });
    await g.call('POST', '/api/chat/o/send', { text: '我想吃面' });
    let items = (await g.call('GET', '/api/chat/o')).json.items;
    const [h1, , h2, a2] = items;
    assert.equal(h2.text, '我想吃面');
    // 不是最后一句、不是她的、空的、没有的
    assert.equal((await g.call('POST', '/api/chat/o/rewind', { id: h1.id, text: 'x' })).status, 400);
    assert.equal((await g.call('POST', '/api/chat/o/rewind', { id: a2.id, text: 'x' })).status, 400);
    assert.equal((await g.call('POST', '/api/chat/o/rewind', { id: h2.id, text: '  ' })).status, 400);
    assert.equal((await g.call('POST', '/api/chat/o/rewind', { id: 'nope', text: 'x' })).status, 404);
    const n = g.up.seen.length;
    const r = await g.call('POST', '/api/chat/o/rewind', { id: h2.id, text: '我想吃饭' });
    assert.equal(r.status, 200);
    assert.equal(g.up.seen.length, n + 1);
    const sent = g.up.seen.at(-1).json.messages.filter((m) => m.role !== 'system');
    assert.equal(sent.at(-1).content, '我想吃饭');
    assert.equal(sent.filter((m) => m.role === 'assistant').length, 1); // 旧的那句回复不再带给模型
    items = (await g.call('GET', '/api/chat/o')).json.items;
    assert.deepEqual(items.map((m) => m.role), ['me', 'ai', 'me', 'ai']);
    assert.equal(items[2].text, '我想吃饭');
    assert.deepEqual(items[2].was, ['我想吃面']);
    assert.notEqual(items[3].id, a2.id);
    const gone = (await g.call('GET', '/api/chat/o?gone=1')).json.items.find((m) => m.id === a2.id);
    assert.ok(gone && gone.gone && gone.rewound);
    // 语音那句不能改
    const f = g.files.saveBuf(WEBM, 'voice', { audio: true });
    await g.call('POST', '/api/chat/o/send', { text: '语音的字', voice: { file: f.id, dur: 2 } });
    const v = (await g.call('GET', '/api/chat/o')).json.items.findLast((m) => m.role === 'me');
    assert.equal((await g.call('POST', '/api/chat/o/rewind', { id: v.id, text: '改' })).status, 400);
  } finally { await g.close(); }
});
