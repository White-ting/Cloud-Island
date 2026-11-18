// 第⑨批·聊天这边：拍一拍、走 API 的散场记（后端自己多问一次）。上游是测试进程里起的假 HTTP 服务，定时器是假的。
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
import { openChat } from '../lib/chat.mjs';
import { openDigest } from '../lib/digest.mjs';
import { openDiary } from '../lib/diary.mjs';
import { openPat } from '../lib/pat.mjs';

const N = (o) => `<!--note ${JSON.stringify(o)} -->`;
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // 自己建的临时目录自己清
const sse = (res, texts) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const t of texts) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: t } }] })}\n\n`);
  res.end('data: [DONE]\n\n');
};
// 她那句（每条消息前那段接在后面，空一行，这里只看前面）
const lastUser = (r) => r.json.messages.filter((m) => m.role === 'user').at(-1).content.split('\n\n〔现在')[0];
const tick = () => new Promise((ok) => setImmediate(ok));
async function until(fn, n = 200) { for (let i = 0; i < n; i++) { if (fn()) return; await tick(); } throw new Error('等不到'); }

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-pat-'));
  dirs.push(dir);
  const clock = { t: Date.UTC(2026, 10, 16, 4) };
  const now = () => clock.t;
  const store = openStore({ dir, tz: 'Asia/Shanghai', now, talk: openTalk({ dir, now }) });
  const digest = openDigest({ store }), diary = openDiary({ store }), pat = openPat({ store });
  const hooks = makeHooks({ store, tz: 'Asia/Shanghai', digest, diary, pat });
  const up = { seen: [], reply: (r, res) => sse(res, ['好的。']) };
  up.server = http.createServer((req, res) => {
    const cs = [];
    req.on('data', (c) => cs.push(c));
    req.on('end', () => { const r = { url: req.url, json: JSON.parse(Buffer.concat(cs).toString('utf8')) }; up.seen.push(r); up.reply(r, res); });
  });
  await new Promise((ok) => up.server.listen(0, '127.0.0.1', ok));
  const tq = [];
  const timers = { set: (fn, ms) => { const h = { fn, ms }; tq.push(h); return h; }, clear: (h) => { h.cleared = true; } };
  const logs = [];
  const chat = openChat({ dir, store, hooks, pat, upstream: { openai: `http://127.0.0.1:${up.server.address().port}/oa` }, log: (...a) => logs.push(a.join(' ')), now, tz: 'Asia/Shanghai', timers });
  chat.setAis([{ id: 'o', model: 'gpt-x', style: 'openai' }]);
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store, hooks, chat, pat, digest, diary });
  const { port } = await srv.listen();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE */ }
    return { code: r.status, body: json, text };
  };
  const live = () => armed().at(-1);
  const armed = () => tq.filter((h) => !h.cleared);
  const close = async () => { await srv.close(); up.server.closeAllConnections(); await new Promise((ok) => up.server.close(ok)); };
  return { dir, clock, store, digest, pat, hooks, chat, up, call, tq, armed, live, logs, close };
}

test('拍一拍·设置：默认 next、两句后半句和她的名字各最长 30 字；写错回 400', async () => {
  const g = await setup();
  try {
    assert.deepEqual((await g.call('GET', '/api/pat/o')).body, { me: '', ai: '', reply: 'next', meName: '' });
    assert.equal((await g.call('PUT', '/api/pat/o', { me: '脑'.repeat(31) })).code, 400);
    assert.equal((await g.call('PUT', '/api/pat/o', { reply: 'later' })).code, 400);
    assert.equal((await g.call('PUT', '/api/pat/o', { ai: 3 })).code, 400);
    assert.deepEqual((await g.call('PUT', '/api/pat/o', { me: '然后揉了揉头发', ai: '叫你去睡觉', meName: '小满' })).body, { me: '然后揉了揉头发', ai: '叫你去睡觉', reply: 'next', meName: '小满' });
    assert.equal((await g.call('GET', '/api/pat/a%20b')).code, 400);
  } finally { await g.close(); }
});

test('拍一拍·next：一分钟内连拍合成一条 n+1；她下一句前面带一行（拍了几下）、带了就清；拍一拍不当成聊天发给模型；删除只标 gone', async () => {
  const g = await setup();
  try {
    await g.call('PUT', '/api/pat/o', { me: '然后揉了揉头发', ai: '叫你去睡觉' });
    const a = (await g.call('POST', '/api/chat/o/pat')).body;
    assert.deepEqual([a.role, a.pat, a.text], ['me', { n: 1, tail: '然后揉了揉头发' }, undefined]);
    g.clock.t += 30e3;
    const b = (await g.call('POST', '/api/chat/o/pat')).body;
    assert.deepEqual([b.id, b.pat.n], [a.id, 2]);
    g.clock.t += 50e3; // 离上一下 50 秒：还算连着
    assert.equal((await g.call('POST', '/api/chat/o/pat')).body.pat.n, 3);
    g.clock.t += 61e3;
    const c = (await g.call('POST', '/api/chat/o/pat')).body;
    assert.ok(c.id !== a.id && c.pat.n === 1);
    assert.equal(g.up.seen.length, 0); // next：不单独发
    await g.call('POST', '/api/chat/o/send', { text: '在吗' });
    assert.equal(lastUser(g.up.seen[0]), '〔她刚才拍了你 4 下，然后揉了揉头发〕\n在吗');
    assert.ok(g.up.seen[0].json.messages.every((m) => m.content)); // 拍一拍那两条不当成空的一轮发过去
    assert.equal(g.chat.readAll('o').find((m) => m.role === 'me' && m.text).text, '在吗'); // 存的是她的原话
    await g.call('POST', '/api/chat/o/send', { text: '嗯' });
    assert.equal(lastUser(g.up.seen[1]), '嗯'); // 带过一次就清掉
    // 删除照旧只标 gone
    await g.call('DELETE', `/api/chat/o/${a.id}`);
    assert.ok(g.chat.readAll('o').find((m) => m.id === a.id).gone);
    assert.ok(!(await g.call('GET', '/api/chat/o')).body.items.some((m) => m.id === a.id));
    // 拍一拍不是记忆
    assert.equal(g.store.list('o', { who: 'ai' }).items.length, 0);
  } finally { await g.close(); }
});

test('拍一拍·now：拍完马上让 TA 回（那一行当她这句）；TA 正在回时排到她下一句；TA 在小记里拍她：回复后加一行 role ai，不进回复下面的小字', async () => {
  const g = await setup();
  try {
    await g.call('PUT', '/api/pat/o', { me: '然后揉了揉头发', ai: '叫你去睡觉', reply: 'now' });
    g.up.reply = (r, res) => sse(res, ['干嘛呀。', N({ pat: true })]);
    const m = (await g.call('POST', '/api/chat/o/pat')).body;
    assert.deepEqual([m.role, m.pat.n], ['me', 1]);
    await until(() => !g.chat.busy('o') && g.chat.readAll('o').length >= 3);
    assert.equal(lastUser(g.up.seen[0]), '〔她拍了拍你，然后揉了揉头发〕');
    const all = g.chat.readAll('o');
    assert.deepEqual(all.map((x) => [x.role, x.text ?? null, x.pat ?? null]), [['me', null, { n: 1, tail: '然后揉了揉头发' }], ['ai', '干嘛呀。', null], ['ai', null, { n: 1, tail: '叫你去睡觉' }]]);
    assert.equal(all[1].notes, undefined);
    // TA 正在回：这一下排到下一句
    let release;
    g.up.reply = (r, res) => { release = () => sse(res, ['嗯']); };
    const p = g.call('POST', '/api/chat/o/send', { text: '你在干嘛' });
    await until(() => g.chat.busy('o') && release);
    g.clock.t += 120e3;
    await g.call('POST', '/api/chat/o/pat');
    assert.equal(g.up.seen.length, 2);
    release();
    await p;
    g.up.reply = (r, res) => sse(res, ['好。']);
    await g.call('POST', '/api/chat/o/send', { text: '睡了' });
    assert.equal(lastUser(g.up.seen[2]), '〔她刚才拍了拍你，然后揉了揉头发〕\n睡了');
  } finally { await g.close(); }
});

test('拍一拍·走钩子的：挂起的那一下由 ② before 带上并清掉；now 时这个 AI 不走这里的聊天，就把那一行交给调用的一方，不挂起', async () => {
  const g = await setup();
  try {
    await g.call('PUT', '/api/pat/cc', { me: '然后揉了揉头发' });
    const m = (await g.call('POST', '/api/chat/cc/pat')).body;
    assert.equal(m.line, undefined);
    let c = (await g.hooks.before('cc', { text: '在吗' })).context;
    assert.ok(c.includes('〔她刚才拍了拍你，然后揉了揉头发〕'), c);
    assert.ok(!(await g.hooks.before('cc', { text: '嗯' })).context.includes('拍了拍'));
    await g.call('PUT', '/api/pat/cc', { reply: 'now' });
    g.clock.t += 61e3; // 隔开一分钟，不跟上一下合成一条
    assert.equal((await g.call('POST', '/api/chat/cc/pat')).body.line, '〔她拍了拍你，然后揉了揉头发〕');
    c = (await g.hooks.before('cc', { text: '嗯' })).context;
    assert.ok(!c.includes('拍了拍'));
    // TA 在钩子那条路上写 pat：回 marks 让调用的一方显示
    assert.deepEqual(g.hooks.after('cc', { reply: N({ pat: true }) + N({ pat: 1 }) }).marks, [{ kind: 'pat' }]);
  } finally { await g.close(); }
});

test('走 API 的散场记：她停 digestIdle 分钟后后端多问一次（同样的聊天记录 + 问话），不进聊天记录、只存小记，最后一条消息上留 digest 标记；没新对话不问；0 是关；她这时发话让给她', async () => {
  const g = await setup();
  try {
    g.up.reply = (r, res) => sse(res, ['我陪你去。']);
    await g.call('POST', '/api/chat/o/send', { text: '周三要去体检，有点怕' });
    assert.equal(g.armed().length, 1);
    assert.equal(g.live().ms, 15 * 60e3);
    const before = g.chat.readAll('o');
    g.up.reply = (r, res) => sse(res, ['无', N({ digest: '她周三体检，怕抽血。我想陪她。' }), N({ kind: 'note', text: '她周三体检' })]);
    g.live().fn(); // 到点
    await until(() => g.up.seen.length === 2 && !g.chat.busy('o'));
    await until(() => g.chat.readAll('o').at(-1).digest);
    const sent = g.up.seen[1].json.messages;
    assert.ok(lastUser(g.up.seen[1]).includes('散场记'));
    assert.ok(sent.some((x) => x.role === 'user' && x.content.includes('周三要去体检')) && sent.some((x) => x.role === 'assistant' && x.content === '我陪你去。'));
    const after = g.chat.readAll('o');
    assert.equal(after.length, before.length); // 不进聊天记录
    assert.deepEqual(after.at(-1).digest, { n: 2, kinds: ['digest', 'note'] });
    assert.ok(!JSON.stringify(after.at(-1).digest).includes('抽血'));
    assert.deepEqual(g.digest.pending('o').map((x) => x.by), ['ai']);
    assert.ok(!g.store.talk.recent('o').some((x) => x.text.includes('无'))); // 问答不进对话原文
    // 没有新的对话：不再问
    assert.deepEqual(await g.chat.digest('o'), { skip: 'none' });
    assert.equal(g.up.seen.length, 2);
    // 她这时又发话：散场记让给她，什么都不存
    g.up.reply = (r, res) => sse(res, ['嗯。']);
    g.clock.t += 60e3;
    await g.call('POST', '/api/chat/o/send', { text: '还有一件事' });
    let hold = null;
    g.up.reply = (r, res) => { if (lastUser(r).includes('散场记')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); hold = res; } else sse(res, ['好。']); };
    const dp = g.chat.digest('o');
    await until(() => hold);
    const r = await g.call('POST', '/api/chat/o/send', { text: '你在听吗' });
    assert.equal(r.code, 200);
    assert.deepEqual(await dp, { skip: 'yield' });
    assert.equal(g.digest.pending('o').length, 1);
    assert.equal(g.chat.readAll('o').at(-1).text, '好。');
    // 0 是关：发完不再计时
    g.store.setCfg('o', { digestIdle: 0 });
    g.tq.length = 0;
    await g.call('POST', '/api/chat/o/send', { text: '晚安' });
    assert.equal(g.armed().length, 0);
    assert.equal((await g.call('PUT', '/api/memory/o/cfg', { digestIdle: -1 })).code, 400);
  } finally { await g.close(); }
});

test('走 API 的散场记·快压缩：all + ctxMax 时后端自己算 ctxLeft，跌进 10% 的那一句回完问一次（why 是快压缩了），同一轮不再问；last 模式没有压缩不问', async () => {
  const g = await setup();
  try {
    g.chat.setAis([{ id: 'o', model: 'gpt-x', style: 'openai', ctxMax: 100 }]);
    g.up.reply = (r, res) => sse(res, lastUser(r).includes('散场记') ? [N({ digest: '聊得很长了，她在讲搬家。' })] : ['嗯。']);
    const asks = () => g.up.seen.filter((r) => lastUser(r).includes('散场记'));
    await g.call('POST', '/api/chat/o/send', { text: '一'.repeat(40) }); // 一共 40 字：还剩 60%
    g.clock.t += 60e3;
    await g.call('POST', '/api/chat/o/send', { text: '二'.repeat(30) }); // 40+2+30=72：还剩 28%
    assert.equal(asks().length, 0);
    g.clock.t += 60e3;
    await g.call('POST', '/api/chat/o/send', { text: '三'.repeat(20) }); // 72+2+20=94：跌进 10%
    await until(() => asks().length === 1 && !g.chat.busy('o'));
    await until(() => g.digest.pending('o').length === 1);
    assert.ok(lastUser(asks()[0]).includes('快压缩了'));
    assert.ok(g.up.seen.at(-2).json.messages.at(-1).content.includes('〔快压缩了（还剩约 6%）')); // 那一句里也提醒了写交接
    assert.equal(g.chat.readAll('o').filter((m) => m.role === 'ai').length, 3); // 散场记不进聊天记录
    g.clock.t += 60e3;
    await g.call('POST', '/api/chat/o/send', { text: '四' }); // 还在 10% 以下：同一轮不再问
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(asks().length, 1);
    // last 模式（新的一个 AI）：没有「从最旧的开始不带」，不给 ctxLeft，不提醒也不问
    g.chat.setAis([{ id: 'o', model: 'gpt-x', style: 'openai', ctxMax: 100 }, { id: 'p', model: 'gpt-x', style: 'openai', ctxMax: 100 }]);
    await g.call('PUT', '/api/chat/p/ctx', { mode: 'last', n: 50 });
    g.clock.t += 60e3;
    await g.call('POST', '/api/chat/p/send', { text: '五'.repeat(95) });
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(asks().length, 1);
    assert.ok(!g.up.seen.at(-1).json.messages.at(-1).content.includes('快压缩了'));
  } finally { await g.close(); }
});

test('走 API 的散场记·重启：boot() 按她最后一句和上次散场记的时间重新挂定时器——没到点挂剩下的、过点了挂很短的；问过了、0 是关、没聊过都不挂', async () => {
  const g = await setup();
  try {
    g.chat.setAis([{ id: 'o', model: 'gpt-x', style: 'openai' }, { id: 'q', model: 'gpt-x', style: 'openai' }]);
    await g.call('POST', '/api/chat/o/send', { text: '我先去洗澡' });
    // 「重启」：同一份数据，新开一个聊天（定时器是新的、空的）
    const restart = () => {
      const tq = [];
      const timers = { set: (fn, ms) => { const h = { fn, ms }; tq.push(h); return h; }, clear: (h) => { h.cleared = true; } };
      const chat = openChat({ dir: g.dir, store: g.store, hooks: g.hooks, pat: g.pat, upstream: { openai: `http://127.0.0.1:${g.up.server.address().port}/oa` }, now: () => g.clock.t, tz: 'Asia/Shanghai', timers });
      return { chat, tq };
    };
    g.clock.t += 5 * 60e3;
    let r = restart();
    assert.equal(r.chat.boot(), 1); // q 没聊过：不挂
    assert.deepEqual(r.tq.map((h) => h.ms), [10 * 60e3]); // 15 分钟里过了 5 分钟
    g.clock.t += 20 * 60e3;
    r = restart();
    assert.equal(r.chat.boot(), 1);
    assert.deepEqual(r.tq.map((h) => h.ms), [30e3]); // 已经过点了：很短的延迟
    g.up.reply = (x, res) => sse(res, [N({ digest: '她去洗澡了。' })]);
    r.tq[0].fn(); // 到点：照常问一次
    await until(() => g.digest.pending('o').length === 1 && !r.chat.busy('o'));
    assert.ok(lastUser(g.up.seen.at(-1)).includes('散场记'));
    // 问过了、之后没有新的话：不挂
    r = restart();
    assert.equal(r.chat.boot(), 0);
    // 有新的话，但 digestIdle 是 0：不挂
    g.up.reply = (x, res) => sse(res, ['好。']);
    await g.call('POST', '/api/chat/o/send', { text: '洗好了' });
    g.store.setCfg('o', { digestIdle: 0 });
    r = restart();
    assert.equal(r.chat.boot(), 0);
    assert.equal(r.tq.length, 0);
  } finally { await g.close(); }
});

// 第⑩批
test('拍一拍·那一行读着通顺：没填后半句没有逗号；连拍写成「拍了你 3 下」；她自己在前面打了逗号不会出两个；走钩子的 now 每次只说这一下', async () => {
  const g = await setup();
  try {
    // 没填后半句
    assert.equal(g.pat.line('o'), '〔她刚才拍了拍你〕');
    assert.equal(g.pat.line('o', 3), '〔她刚才拍了你 3 下〕');
    assert.equal(g.pat.line('o', 1, { now: true }), '〔她拍了拍你〕');
    // 前面多打的逗号、空格去掉（存下来的也是去掉的）；只打了个逗号就当没填
    assert.deepEqual((await g.call('PUT', '/api/pat/o', { me: ' ，然后揉了揉头发', ai: ',叫你去睡觉' })).body, { me: '然后揉了揉头发', ai: '叫你去睡觉', reply: 'next', meName: '' });
    assert.equal(g.pat.line('o', 2), '〔她刚才拍了你 2 下，然后揉了揉头发〕');
    assert.equal((await g.call('PUT', '/api/pat/o', { me: '，' })).body.me, '');
    assert.equal(g.pat.line('o'), '〔她刚才拍了拍你〕');
    // 走钩子的 now：一分钟内拍第二下，显示的那行合成 2 下，交给调用方的那句只说这一下
    await g.call('PUT', '/api/pat/cc', { me: '然后揉了揉头发', reply: 'now' });
    const a = (await g.call('POST', '/api/chat/cc/pat')).body;
    g.clock.t += 20e3;
    const b = (await g.call('POST', '/api/chat/cc/pat')).body;
    assert.deepEqual([b.id, b.pat.n], [a.id, 2]);
    assert.deepEqual([a.line, b.line], ['〔她拍了拍你，然后揉了揉头发〕', '〔她拍了拍你，然后揉了揉头发〕']);
  } finally { await g.close(); }
});

test('走 API 的散场记·重启：好几个 AI 都过点了，一个隔 30 秒问，不一起挤上去；没到点的照剩下的时间', async () => {
  const g = await setup();
  try {
    g.chat.setAis([{ id: 'o', model: 'gpt-x', style: 'openai' }, { id: 'p', model: 'gpt-x', style: 'openai' }, { id: 'q', model: 'gpt-x', style: 'openai' }]);
    await g.call('POST', '/api/chat/o/send', { text: '我先去洗澡' });
    await g.call('POST', '/api/chat/p/send', { text: '我也去' });
    g.clock.t += 20 * 60e3;
    await g.call('POST', '/api/chat/q/send', { text: '我还在' }); // q 刚说完：还剩 15 分钟
    g.clock.t += 60e3;
    const tq = [];
    const timers = { set: (fn, ms) => { const h = { fn, ms }; tq.push(h); return h; }, clear: (h) => { h.cleared = true; } };
    const chat = openChat({ dir: g.dir, store: g.store, hooks: g.hooks, pat: g.pat, upstream: { openai: `http://127.0.0.1:${g.up.server.address().port}/oa` }, now: () => g.clock.t, tz: 'Asia/Shanghai', timers });
    assert.equal(chat.boot(), 3);
    assert.deepEqual(tq.map((h) => h.ms), [30e3, 60e3, 14 * 60e3]);
  } finally { await g.close(); }
});
