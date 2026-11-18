// 向量层：在测试进程里起一个假的 embeddings 服务（按几个关键词给固定的小向量），用完关掉。不联网。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../lib/store.mjs';
import { openVec, makeEmbed, cos } from '../lib/vec.mjs';
import { makeHooks } from '../lib/hooks.mjs';
import { createServer } from '../lib/server.mjs';
import { loadConfig } from '../backend.mjs';

const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // 自己建的临时目录自己清

// 几个「意思」：文字里出现哪个词，那一维就是 1；一个都没有，落到最后一维
const CONCEPTS = [['猫', '橘色的小家伙', '喵'], ['海', '沙滩'], ['面', '饭'], ['雨', '伞']];
const vecFor = (t) => { const v = CONCEPTS.map((ws) => (ws.some((w) => t.includes(w)) ? 1 : 0)); return [...v, v.some(Boolean) ? 0 : 1]; };

// 假服务：记下收到的每段文字；bad(文字) 为真就回 500；hang 为真就不回
async function fakeEmbed() {
  const f = { seen: [], bad: () => false, hang: false };
  f.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const { input, model } = JSON.parse(raw);
      f.seen.push(...input);
      f.model = model;
      f.auth = req.headers.authorization;
      if (f.hang) return;
      if (input.some((t) => f.bad(t))) { res.writeHead(500); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vecFor(t) })) }));
    });
  });
  await new Promise((ok) => f.server.listen(0, '127.0.0.1', ok));
  f.url = `http://127.0.0.1:${f.server.address().port}/v1/embeddings`;
  f.close = () => { f.server.closeAllConnections(); return new Promise((ok) => f.server.close(ok)); };
  return f;
}
function fresh(url, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-vec-'));
  dirs.push(dir);
  const clock = { t: Date.UTC(2026, 10, 15, 4) };
  const vec = url ? openVec({ dir, embed: makeEmbed({ url, model: 'fake-m3', key: opts.key }), backoff: 5, maxBackoff: 20 }) : null;
  const s = openStore({ dir, tz: 'Asia/Shanghai', now: () => clock.t, vec });
  return { s, vec, dir, clock };
}
const vecFile = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'a', 'vec.json'), 'utf8'));

test('余弦：长度不一样（换过模型）当没有', () => {
  assert.equal(cos([1, 0], [1, 0]), 1);
  assert.equal(cos([1, 0], [0, 1]), 0);
  assert.equal(cos([1, 0], [1, 0, 0]), null);
});

test('没配向量：recallAsync 跟同步的 recall 一样，字面不像的找不到', async () => {
  const { s } = fresh(null);
  s.add('a', { text: '她家橘色的小家伙很黏人' });
  s.add('a', { text: '她说周末想去海边走走' });
  assert.deepEqual((await s.recallAsync('a', '去海边要带什么')).map((m) => m.id), s.recall('a', '去海边要带什么').map((m) => m.id));
  assert.equal((await s.recallAsync('a', '猫今天乖不乖')).length, 0);
});

test('配了向量：字面不像但意思像的能召回；why 的向量也算；私人念想不送去算；口令带上', async () => {
  const f = await fakeEmbed();
  const { s, vec, dir } = fresh(f.url, { key: 'ek-test' });
  try {
    const cat = s.add('a', { text: '她家橘色的小家伙很黏人' });
    const why = s.add('a', { text: '她下班路上买了一把新的', why: '那天下大雨' });
    const priv = s.add('a', { kind: 'wish', text: '悄悄想养一只猫', priv: true }, 'ai');
    s.add('a', { text: '她说周末想去海边走走' });
    await vec.idle();
    assert.equal(s.recall('a', '猫今天乖不乖').length, 0); // 同步版只看字面
    const r = await s.recallAsync('a', '猫今天乖不乖');
    assert.deepEqual(r.map((m) => m.id), [cat.id]); // 私人念想字面不像，也没有向量，不进
    assert.deepEqual((await s.recallAsync('a', '雨停了没')).map((m) => m.id), [why.id]);
    assert.ok(!f.seen.some((t) => t.includes('悄悄')));
    assert.equal(f.model, 'fake-m3');
    assert.equal(f.auth, 'Bearer ek-test');
    const vf = vecFile(dir);
    assert.ok(vf[cat.id].v && !vf[cat.id].w && vf[why.id].w && !vf[priv.id]);
    assert.equal(fs.statSync(path.join(dir, 'a', 'vec.json')).mode & 0o777, 0o600);
    // 私人念想 TA 打开了才送；又收回去，向量删掉
    s.patch('a', priv.id, { priv: false }, { who: 'ai' });
    await vec.idle();
    assert.ok(vecFile(dir)[priv.id]);
    s.patch('a', priv.id, { priv: true }, { who: 'ai' });
    assert.ok(!vecFile(dir)[priv.id]);
    // 改了正文：旧向量不用，补上新的
    const n = f.seen.length;
    s.patch('a', cat.id, { text: '她家那只狗很黏人' });
    assert.equal((await s.recallAsync('a', '猫今天乖不乖')).length, 0);
    await vec.idle();
    assert.ok(f.seen.length > n);
  } finally { vec.close(); await f.close(); }
});

test('归档的向量留着，彻底删时一起删；重开进程会补上没向量的、删掉多出来的', async () => {
  const f = await fakeEmbed();
  const { s, vec, dir } = fresh(f.url);
  try {
    const a = s.add('a', { text: '她家橘色的小家伙很黏人' });
    const b = s.add('a', { text: '沙滩上捡的贝壳' });
    await vec.idle();
    s.remove('a', a.id);
    assert.ok(vecFile(dir)[a.id]);
    assert.equal((await s.recallAsync('a', '猫今天乖不乖')).length, 0); // 归档的不召回
    s.restore('a', a.id);
    assert.equal((await s.recallAsync('a', '猫今天乖不乖')).length, 1);
    s.remove('a', a.id);
    s.purge('a', a.id);
    assert.ok(!vecFile(dir)[a.id] && vecFile(dir)[b.id]);
    // 换一个进程：文件里多一条不存在的、少一条没算过的
    const vf = vecFile(dir);
    vf.ghost = vf[b.id];
    fs.writeFileSync(path.join(dir, 'a', 'vec.json'), JSON.stringify(vf));
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'a', 'mem.json'), 'utf8'));
    d.items.push({ id: 'imported1', t: 1, by: 'me', kind: 'note', text: '喵了一声' });
    fs.writeFileSync(path.join(dir, 'a', 'mem.json'), JSON.stringify(d));
    const vec2 = openVec({ dir, embed: makeEmbed({ url: f.url, model: 'fake-m3' }), backoff: 5 });
    const s2 = openStore({ dir, tz: 'Asia/Shanghai', vec: vec2 });
    s2.list('a');
    await vec2.idle();
    const vf2 = vecFile(dir);
    assert.ok(!vf2.ghost && vf2.imported1 && vf2[b.id]);
    vec2.close();
  } finally { vec.close(); await f.close(); }
});

test('向量服务挂了：写记忆不等、不报错；召回退回字面；同一条连着失败 3 次就放下，记录变了再试', async () => {
  const f = await fakeEmbed();
  const { s, vec, dir } = fresh(f.url);
  try {
    f.bad = (t) => t.includes('坏');
    const bad = s.add('a', { text: '坏掉的那条' });
    s.add('a', { text: '她说周末想去海边走走' });
    await vec.idle();
    assert.equal(f.seen.filter((t) => t.includes('坏')).length, 3); // 三次就放下，不重试风暴
    assert.ok(!vecFile(dir)[bad.id]);
    s.patch('a', bad.id, { text: '坏掉的那条，改过' }); // 记录变了，再试
    await vec.idle();
    assert.equal(f.seen.filter((t) => t.includes('坏')).length, 6);
    // 整个关掉
    await f.close();
    const t0 = Date.now();
    const m = s.add('a', { text: '她说下周想去沙滩' });
    assert.ok(m.id && Date.now() - t0 < 200);
    const r = await s.recallAsync('a', '去海边要带什么');
    assert.ok(r.length >= 1 && r[0].text.includes('海边'));
    assert.equal((await s.recallAsync('a', '猫今天乖不乖')).length, 0);
  } finally { vec.close(); }
});

test('查询向量等太久（超过时限）就退回字面，不卡住', async () => {
  const f = await fakeEmbed();
  const { s, vec } = fresh(f.url);
  try {
    s.add('a', { text: '她说周末想去海边走走' });
    await vec.idle();
    f.hang = true;
    const t0 = Date.now();
    const r = await s.recallAsync('a', '去海边要带什么', 5, { wait: 150 });
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `等了 ${ms} 毫秒`);
    assert.equal(r.length, 1);
  } finally { vec.close(); await f.close(); }
});

test('每条消息前和 /recall 接口都走向量', async () => {
  const f = await fakeEmbed();
  const { s, vec } = fresh(f.url);
  const h = makeHooks({ store: s, tz: 'Asia/Shanghai' });
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: s, hooks: h });
  const { port } = await srv.listen();
  try {
    s.add('a', { text: '她家橘色的小家伙很黏人' });
    await vec.idle();
    assert.ok((await h.before('a', { text: '猫今天乖不乖' })).context.includes('橘色的小家伙'));
    const r = await fetch(`http://127.0.0.1:${port}/api/memory/a/recall`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '猫今天乖不乖' }) });
    assert.equal((await r.json()).items.length, 1);
    const hk = await fetch(`http://127.0.0.1:${port}/api/hook/a/before`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok' }, body: JSON.stringify({ text: '猫今天乖不乖' }) });
    assert.ok((await hk.json()).context.includes('橘色的小家伙'));
  } finally { await srv.close(); vec.close(); await f.close(); }
});

test('设置：EMBED_URL / EMBED_MODEL / EMBED_KEY 从 .env 或环境里读，不写就是空的', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-cfg-'));
  dirs.push(dir);
  assert.deepEqual(loadConfig(dir, {}).embed, { url: '', model: '', key: '' });
  fs.writeFileSync(path.join(dir, '.env'), 'EMBED_URL=http://127.0.0.1:11434/v1/embeddings\nEMBED_MODEL=bge-m3\n');
  assert.deepEqual(loadConfig(dir, { EMBED_KEY: 'k' }).embed, { url: 'http://127.0.0.1:11434/v1/embeddings', model: 'bge-m3', key: 'k' });
});

test('列表带向量的状态：没配是 off（网页据此提醒她去配），配了是 on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-'));
  try {
    assert.equal(openStore({ dir }).list('a').vec, 'off');
    const v = openVec({ dir, embed: async () => [1, 0] });
    assert.equal(openStore({ dir, vec: v }).list('a').vec, 'on');
    v.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
