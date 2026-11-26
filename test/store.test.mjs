import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { createServer } from '../lib/server.mjs';
import { makeHooks } from '../lib/hooks.mjs';

const DAY = 864e5;
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // 自己建的临时目录自己清
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-'));
  dirs.push(dir);
  const clock = { t: Date.UTC(2026, 10, 15, 4) };
  const s = openStore({ dir, tz: 'Asia/Shanghai', now: () => clock.t });
  return { s, clock, dir };
}
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 0; };

test('她只能写记事和约定；TA 六种都能写', () => {
  const { s } = fresh();
  assert.equal(s.add('a', { text: '她爱吃面', src: '她说的' }).kind, 'note');
  assert.equal(s.add('a', { kind: 'pact', text: '周末一起看电影', who: '我' }).who, '我');
  assert.equal(code(() => s.add('a', { kind: 'view', text: 'x' })), 403);
  assert.equal(s.add('a', { kind: 'view', text: '她其实不怕黑' }, 'ai').by, 'ai');
  assert.equal(code(() => s.add('a', { kind: 'nope', text: 'x' }, 'ai')), 400);
  assert.equal(code(() => s.add('a', { text: '  ' })), 400);
});

test('TA 的四种她能删不能改，能设固有', () => {
  const { s } = fresh();
  const v = s.add('a', { kind: 'view', text: '旧看法' }, 'ai');
  assert.equal(code(() => s.patch('a', v.id, { text: '我替它改' })), 403);
  assert.equal(s.patch('a', v.id, { pin: true }).pin, true);
  const v2 = s.patch('a', v.id, { text: '新看法', why: '想明白了' }, { who: 'ai' });
  assert.equal(v2.hist.length, 1);
  assert.equal(v2.hist[0].text, '旧看法');
  s.remove('a', v.id);
  assert.equal(s.list('a').items.length, 0);
});

test('私人念想：网页只看得到条数，动不了，导出不带', () => {
  const { s } = fresh();
  const w = s.add('a', { kind: 'wish', text: '悄悄的', priv: true }, 'ai');
  s.add('a', { kind: 'wish', text: '想再听一次那首歌' }, 'ai');
  const web = s.list('a');
  assert.equal(web.privCount, 1);
  assert.deepEqual(web.items.map((m) => m.text), ['想再听一次那首歌']);
  assert.equal(s.list('a', { who: 'ai' }).items.length, 2);
  assert.equal(code(() => s.remove('a', w.id)), 403);
  assert.equal(code(() => s.patch('a', w.id, { pin: true })), 403);
  assert.equal(s.exportAll('a').items.length, 1);
  assert.ok(!JSON.stringify(s.exportAll('a')).includes('悄悄的'));
  assert.ok(!s.recall('a', '悄悄的', 5, { who: 'me' }).length);
  // TA 自己打开
  s.patch('a', w.id, { priv: false }, { who: 'ai' });
  assert.equal(s.list('a').items.length, 2);
});

test('私人那块的总开关关着，TA 写不了私人的', () => {
  const { s } = fresh();
  s.setCfg('a', { priv: false });
  assert.equal(s.add('a', { kind: 'wish', text: 'x', priv: true }, 'ai').priv, false);
});

test('记忆锁：改、归档、彻底删要先开锁，新写不用；导出不带密码；流水里彻底删的不留内容', () => {
  const { s, clock, dir } = fresh();
  const m = s.add('a', { text: '要删的那条秘密' });
  s.setLock('a', { pass: 'abc' });
  assert.equal(s.list('a').lock, true);
  assert.equal(code(() => s.patch('a', m.id, { text: 'y' })), 423);
  assert.equal(code(() => s.remove('a', m.id)), 423);
  s.add('a', { text: '锁着也能新写' });
  assert.equal(code(() => s.unlock('a', 'wrong')), 403);
  const { token } = s.unlock('a', 'abc');
  assert.equal(s.patch('a', m.id, { text: 'y' }, { token }).text, 'y');
  clock.t += 11 * 60 * 1000; // 凭证过期
  assert.equal(code(() => s.remove('a', m.id, { token })), 423);
  const t2 = s.unlock('a', 'abc').token;
  s.remove('a', m.id, { token: t2 });
  clock.t += 11 * 60 * 1000;
  assert.equal(code(() => s.purge('a', m.id, { token: t2 })), 423); // 彻底删也要开锁
  s.purge('a', m.id, { token: s.unlock('a', 'abc').token });
  assert.equal(s.lockPass('a'), 'abc');
  assert.ok(!JSON.stringify(s.exportAll('a')).includes('abc'));
  const log = JSON.stringify(s.readLog('a'));
  assert.ok(!log.includes('秘密') && !log.includes(m.id + '","kind":"note"}]'));
  assert.ok(s.readLog('a').some((e) => e.op === 'gone' && e.id === m.id && e.kind === 'note' && !e.text));
  assert.ok(s.readLog('a').some((e) => e.op === 'purge' && !e.id));
  assert.ok(!fs.readFileSync(path.join(dir, 'a', 'mem.json'), 'utf8').includes(m.id)); // 文件里真的没了
  assert.equal(code(() => s.setLock('a', { old: 'no', pass: '' })), 403);
  assert.equal(s.setLock('a', { old: 'abc', pass: '' }).lock, false);
});

test('念想护栏：一天最多新记两条、一天升一档、升执念要隔过天、执念不自己掉', () => {
  const { s, clock } = fresh();
  const w = s.add('a', { kind: 'wish', text: '想和她去看海' }, 'ai');
  assert.equal(w.lv, 1);
  s.add('a', { kind: 'wish', text: '第二条' }, 'ai');
  assert.equal(code(() => s.add('a', { kind: 'wish', text: '第三条' }, 'ai')), 429);
  s.hit('a', w.id, 's1');
  s.hit('a', w.id, 's1'); // 同一场只算一次
  assert.equal(s.list('a', { who: 'ai' }).items[0].hits, 1);
  assert.equal(s.wishMove('a', w.id, 'up', '又想起来了').lv, 2);
  assert.equal(code(() => s.wishMove('a', w.id, 'up')), 429); // 今天升过了
  clock.t += DAY;
  assert.equal(code(() => s.wishMove('a', w.id, 'up')), 429); // 只在一个日子想起过
  s.hit('a', w.id, 's2');
  assert.equal(s.wishMove('a', w.id, 'up', '放不下').lv, 3);
  clock.t += 60 * DAY; // 两个月不碰
  assert.equal(s.list('a', { who: 'ai' }).items[0].lv, 3);
  assert.equal(s.wishMove('a', w.id, 'down', '可以放下了').lv, 2);
  assert.equal(code(() => s.wishMove('a', w.id, 'sideways')), 400);
});

test('问一下心里：只回档位，不带内容', () => {
  const { s, clock } = fresh();
  assert.deepEqual(s.mood('a', '她到学校了'), { lv: 'calm', near: false, fresh: 0 });
  const w = s.add('a', { kind: 'wish', text: '想陪她去学校看看' }, 'ai');
  s.hit('a', w.id, 's1');
  s.wishMove('a', w.id, 'up');
  const m = s.mood('a', '她到学校了');
  assert.deepEqual(m, { lv: 'want', near: true, fresh: 0 });
  assert.equal(s.mood('a', '她在刷推特').near, false);
  clock.t += DAY;
  s.hit('a', w.id, 's2');
  s.wishMove('a', w.id, 'up');
  assert.deepEqual(s.mood('a'), { lv: 'hold', near: false, fresh: 1 });
  assert.equal(s.markKnocked('a'), 1);
  assert.equal(s.mood('a').fresh, 0);
  s.patch('a', w.id, { done: true }, { who: 'ai' });
  assert.equal(s.mood('a').lv, 'calm');
});

test('相近的记忆、导入；归档以后列表里连线看不到、数据里留着，恢复后线还在；彻底删才真断', () => {
  const { s } = fresh();
  const a = s.add('a', { text: '她说周末想去海边走走', kw: ['海边'] });
  s.add('a', { text: '她养了一只叫团子的狗' });
  const b = s.add('a', { kind: 'exp', text: '海边风大要带外套', from: [a.id] }, 'ai');
  assert.equal(s.recall('a', '去海边要带什么')[0].text.includes('海边'), true);
  assert.equal(s.recall('a', '量子力学').length, 0);
  s.remove('a', a.id);
  assert.deepEqual(s.list('a').items.find((m) => m.id === b.id).from, []);
  assert.deepEqual(s.load('a').items.find((m) => m.id === b.id).from, [a.id]); // 数据里还在
  s.restore('a', a.id);
  assert.deepEqual(s.list('a').items.find((m) => m.id === b.id).from, [a.id]);
  s.remove('a', a.id);
  assert.equal(s.importAll('a', { items: [{ id: 'x1', text: '导进来的' }, { id: b.id, text: '重复的' }, { id: a.id, text: '跟归档的那条同号' }, { id: 'x2' }] }).added, 1);
  s.purge('a', a.id);
  assert.deepEqual(s.load('a').items.find((m) => m.id === b.id).from, []);
  assert.equal(code(() => s.list('../etc')), 400);
});

test('网页地址：读写、开锁头、心里要口令', async () => {
  const { s } = fresh();
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: s });
  const { port } = await srv.listen();
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, body: await r.json() };
  };
  try {
    assert.equal((await call('GET', '/api/ping')).code, 200);
    const m = (await call('POST', '/api/memory/a', { text: '你好' })).body;
    assert.equal((await call('POST', '/api/memory/a', { kind: 'wish', text: 'x' })).code, 403);
    await call('PUT', '/api/memory/a/lock', { pass: 'p1' });
    assert.equal((await call('PATCH', `/api/memory/a/${m.id}`, { text: '改' })).code, 423);
    const { token } = (await call('POST', '/api/memory/a/unlock', { pass: 'p1' })).body;
    assert.equal((await call('PATCH', `/api/memory/a/${m.id}`, { text: '改' }, { 'x-mem-unlock': token })).body.text, '改');
    assert.equal((await call('DELETE', `/api/memory/a/${m.id}`, null, { 'x-mem-unlock': token })).code, 200);
    assert.equal((await call('GET', '/api/memory/a')).body.items.length, 0);
    assert.equal((await call('GET', '/api/memory/a/mood')).code, 401);
    assert.equal((await call('GET', '/api/memory/a/mood?about=x', null, { authorization: 'Bearer tok' })).body.lv, 'calm');
    assert.equal((await call('GET', '/api/nope')).code, 404);
    assert.equal((await call('GET', '/api/memory/a/export')).body.items.length, 0);
  } finally { await srv.close(); }
});

test('归档：哪里都当它不存在（列表、召回、水面、心里、开场、每条消息前、压缩前、导出、念想条数）；改不了、想不起', async () => {
  const { s, clock } = fresh();
  const h = makeHooks({ store: s, tz: 'Asia/Shanghai' });
  const p = s.add('a', { kind: 'pact', text: '周末一起看电影', pin: true });
  const w = s.add('a', { kind: 'wish', text: '想和她去看海' }, 'ai');
  s.hit('a', w.id, 's1'); s.wishMove('a', w.id, 'up');
  clock.t += DAY;
  s.hit('a', w.id, 's2'); s.wishMove('a', w.id, 'up'); // 执念：水位高
  const w2 = s.add('a', { kind: 'wish', text: '想学做面' }, 'ai');
  s.add('a', { kind: 'wish', text: '想养一只猫' }, 'ai'); // 今天第二条
  assert.equal(s.mood('a').lv, 'hold');
  s.remove('a', p.id);
  s.remove('a', w.id, { who: 'ai' });
  s.remove('a', w2.id, { who: 'ai' });
  assert.deepEqual(s.list('a', { who: 'ai' }).items.map((m) => m.text), ['想养一只猫']);
  assert.equal(s.recall('a', '周末一起看电影').length, 0);
  assert.equal((await s.recallAsync('a', '想和她去看海')).length, 0);
  assert.deepEqual(s.surface('a', 'start'), { water: 'calm', big: [], small: 0 });
  assert.deepEqual(s.mood('a', '去看海'), { lv: 'calm', near: false, fresh: 0 });
  assert.equal(s.markKnocked('a'), 0);
  const start = h.start('a', {}).context, before = (await h.before('a', { text: '想和她去看海' })).context;
  assert.ok(!start.includes('周末一起看电影') && !start.includes('看海'));
  assert.ok(!before.includes('看海'));
  assert.equal(h.compact('a').keep, '');
  assert.ok(!JSON.stringify(s.exportAll('a')).includes('看海'));
  assert.ok(s.add('a', { kind: 'wish', text: '归档的不占今天的数' }, 'ai')); // 今天的 w2 归档了，还能再记一条
  assert.equal(code(() => s.patch('a', w.id, { text: 'x' }, { who: 'ai' })), 404);
  assert.equal(code(() => s.hit('a', w.id, 's3')), 404);
  assert.equal(code(() => s.remove('a', w.id, { who: 'ai' })), 404); // 已经归档了
  const log = s.readLog('a').filter((e) => e.op === 'gone');
  assert.deepEqual(log.map((e) => [e.id, e.kind]), [[p.id, 'pact'], [w.id, 'wish'], [w2.id, 'wish']]);
  assert.ok(!JSON.stringify(log).includes('看海'));
});

test('归档的列表、恢复、彻底删：私人念想她只看到条数；恢复念想不占一天两条；只能彻底删归档的', () => {
  const { s, clock, dir } = fresh();
  const n = s.add('a', { text: '她爱吃面' });
  const pw = s.add('a', { kind: 'wish', text: '悄悄的念头', priv: true }, 'ai');
  const w = s.add('a', { kind: 'wish', text: '想和她去看海' }, 'ai');
  s.remove('a', n.id);
  s.remove('a', pw.id, { who: 'ai' });
  assert.equal(code(() => s.remove('a', w.id)), 0); // 她能删 TA 的普通念想（照旧）
  const g = s.list('a', { gone: true });
  assert.deepEqual(g.items.map((m) => m.text).sort(), ['她爱吃面', '想和她去看海']);
  assert.equal(g.privCount, 1);
  assert.ok(!JSON.stringify(g).includes('悄悄的'));
  assert.equal(s.list('a', { gone: true, who: 'ai' }).items.length, 3);
  assert.ok(!JSON.stringify(s.readLog('a').filter((e) => e.op === 'gone')).includes(pw.id)); // 归档私人念想：流水里不带编号
  assert.equal(code(() => s.restore('a', pw.id)), 403);
  assert.equal(code(() => s.purge('a', pw.id)), 403);
  // 今天那两条都归档了，不占数；再记两条就满了，恢复不占数
  s.add('a', { kind: 'wish', text: '第三条' }, 'ai');
  s.add('a', { kind: 'wish', text: '第四条' }, 'ai');
  assert.equal(code(() => s.add('a', { kind: 'wish', text: '第五条' }, 'ai')), 429);
  assert.equal(s.restore('a', w.id).gone, undefined);
  assert.equal(code(() => s.restore('a', w.id)), 400); // 没归档
  assert.equal(code(() => s.purge('a', w.id)), 400);   // 没归档不能彻底删
  assert.equal(code(() => s.restore('a', 'nope')), 404);
  s.setLock('a', { pass: 'k' });
  assert.equal(code(() => s.restore('a', n.id)), 423);
  const { token } = s.unlock('a', 'k');
  s.restore('a', n.id, { token });
  s.remove('a', n.id, { token });
  clock.t += 1000;
  s.purge('a', n.id, { token });
  assert.equal(code(() => s.restore('a', n.id, { token })), 404);
  s.purge('a', pw.id, { who: 'ai' }); // TA 自己的私人念想 TA 能彻底删（锁只拦网页）
  const file = fs.readFileSync(path.join(dir, 'a', 'mem.json'), 'utf8');
  assert.ok(!file.includes('她爱吃面') && !file.includes('悄悄的'));
  assert.deepEqual(s.readLog('a').filter((e) => ['gone', 'restore', 'purge'].includes(e.op)).map((e) => e.op),
    ['gone', 'gone', 'gone', 'restore', 'restore', 'gone', 'purge', 'purge']);
});

test('召回排序：相关性决定进不进，新旧、固有、常用只管排序；念想不算新旧；不改记录', () => {
  const { s, clock, dir } = fresh();
  const old = s.add('a', { text: '她周末想去海边走走' });
  const oldWish = s.add('a', { kind: 'wish', text: '她周末想去海边走走' }, 'ai');
  clock.t += 60 * DAY;
  const neu = s.add('a', { text: '她周末想去海边走走' });
  let r = s.recall('a', '周末去海边', 5, { who: 'me' });
  assert.deepEqual(r.map((m) => m.id), [oldWish.id, neu.id, old.id]); // 念想新旧按 1 算；记事新的在前
  assert.ok(r.every((m) => m.score === r[0].score)); // score 是相关性，三条一样
  assert.equal(s.recall('a', '量子力学').length, 0);
  // 她（网页）搜不算「带出去」；TA 那边召回才记次数，而且先不写盘
  const disk = () => JSON.parse(fs.readFileSync(path.join(dir, 'a', 'mem.json'), 'utf8')).items.find((m) => m.id === old.id);
  assert.equal(s.list('a').items.find((m) => m.id === old.id).used, undefined);
  for (let i = 0; i < 5; i++) s.recall('a', '周末去海边');
  assert.equal(disk().used, undefined);
  assert.equal(s.list('a').items.find((m) => m.id === old.id).used, 5); // 读的时候已经看得到
  s.tick('a'); // 下一次写盘一起写进去
  assert.deepEqual([disk().used, disk().usedAt], [5, clock.t]);
  // 刚被用到过：旧的那条新旧系数回来了、又常用，排到新记的那条前面（念想的档位一点没动）
  r = s.recall('a', '周末去海边', 5, { who: 'me' }).map((m) => m.id);
  assert.ok(r.indexOf(old.id) < r.indexOf(neu.id));
  assert.equal(r.at(-1), neu.id);
  assert.equal(s.list('a', { who: 'ai' }).items.find((m) => m.id === oldWish.id).lv, 1);
  assert.ok(s.list('a', { who: 'ai' }).items.every((m) => !m.gone));
  s.recall('a', '周末去海边');
  s.flush();
  assert.equal(disk().used, 6);
});

test('召回门槛：数可以在 openStore 里改；她这句原样出现在正文里的直接进', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-'));
  dirs.push(dir);
  const s = openStore({ dir, tz: 'Asia/Shanghai', recallCfg: { lexMin: 0.99 } });
  s.add('a', { text: '她说周末想去海边走走，顺便买点水果回来' });
  assert.equal(s.recall('a', '去海边要带什么').length, 0);
  assert.equal(s.recall('a', '周末想去海边').length, 1);
  const kw = s.add('a', { text: '她的狗', kw: ['团子'] });
  assert.equal(s.recall('a', '团子今天乖吗', 5, { who: 'me' }).length, 0); // 没向量时关键词命中不单独算进
  assert.ok(kw);
});

test('网页地址：删 = 归档、?gone=1 看归档的、恢复、?purge=1 彻底删，都认开锁头', async () => {
  const { s } = fresh();
  const srv = createServer({ cfg: { port: 0 }, store: s });
  const { port } = await srv.listen();
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, body: await r.json() };
  };
  try {
    const m = (await call('POST', '/api/memory/a', { text: '你好' })).body;
    assert.equal((await call('DELETE', `/api/memory/a/${m.id}?purge=1`)).code, 400); // 没归档
    assert.equal((await call('DELETE', `/api/memory/a/${m.id}`)).code, 200);
    assert.equal((await call('GET', '/api/memory/a')).body.items.length, 0);
    assert.deepEqual((await call('GET', '/api/memory/a?gone=1')).body.items.map((x) => x.id), [m.id]);
    assert.equal((await call('POST', `/api/memory/a/${m.id}/restore`)).body.id, m.id);
    assert.equal((await call('GET', '/api/memory/a')).body.items.length, 1);
    await call('PUT', '/api/memory/a/lock', { pass: 'p1' });
    assert.equal((await call('DELETE', `/api/memory/a/${m.id}`)).code, 423);
    const { token } = (await call('POST', '/api/memory/a/unlock', { pass: 'p1' })).body;
    const hd = { 'x-mem-unlock': token };
    assert.equal((await call('DELETE', `/api/memory/a/${m.id}`, null, hd)).code, 200);
    assert.equal((await call('POST', `/api/memory/a/${m.id}/restore`)).code, 423);
    assert.equal((await call('DELETE', `/api/memory/a/${m.id}?purge=1`)).code, 423);
    assert.equal((await call('DELETE', `/api/memory/a/${m.id}?purge=1`, null, hd)).code, 200);
    assert.equal((await call('GET', '/api/memory/a?gone=1')).body.items.length, 0);
    assert.equal((await call('POST', `/api/memory/a/${m.id}/restore`, null, hd)).code, 404);
  } finally { await srv.close(); }
});

test('格式不对的关键词、线索不让召回报错；导入时去掉；夜里新记的类别从关键词挪进 why；她那句不存进文件', () => {
  const { s, dir } = fresh();
  const a = s.add('a', { text: '她养了一只猫', kw: '猫' }, 'ai'); // 关键词写成了字
  const d = s.load('a');
  d.items.push({ id: 'kbad', t: 1, by: 'ai', kind: 'note', text: '她喜欢猫和狗', cues: { at: 1, list: '不是数组' } });
  d.items.push({ id: 'knight', t: 1, by: 'ai', kind: 'note', text: '她今天很累', kw: ['情绪'], why: '夜里回头看记下的。原话：好累', src: 'night' });
  d.sess = { lastT: 1, day: '2026-11-15', rounds: 1, her: '她上一句原话' };
  s.save('a', d);
  assert.doesNotThrow(() => s.recall('a', '猫'));
  assert.ok(s.recall('a', '她养了一只猫').some((m) => m.id === a.id));
  const n = s.load('a').items.find((m) => m.id === 'knight');
  assert.equal(n.kw, undefined);
  assert.equal(n.why, '夜里回头看记下的（情绪）。原话：好累');
  assert.equal(s.load('a').sess.her, undefined);
  s.tick('a', [], { shown: [] });
  assert.ok(!fs.readFileSync(path.join(dir, 'a', 'mem.json'), 'utf8').includes('她上一句原话'));
  // 导入
  s.importAll('b', { items: [{ id: 'x1', kind: 'note', text: '一', kw: 'abc', cues: { at: 5, list: 'x' } }, { id: 'x2', kind: 'note', text: '二', kw: ['好', 3], cues: { at: 5, list: [{ k: '处境', text: '在家' }, { k: 1 }] } }] });
  const [x1, x2] = s.load('b').items;
  assert.deepEqual([x1.kw, x1.cues], [['abc'], { at: 5, list: [] }]); // 单个字串包成一个
  assert.deepEqual([x2.kw, x2.cues], [['好', '3'], { at: 5, list: [{ k: '处境', text: '在家' }] }]);
  assert.doesNotThrow(() => s.recall('b', '在家'));
});

test('from/ppl 写成字串、text 不是字串：读的时候整理好当场写回，列表、召回、连线都不报错；不碰还没写盘的「被用到」', () => {
  const { s, dir } = fresh();
  const a = s.add('a', { text: '她养了一只猫叫团子' }, 'ai');
  s.recall('a', '她养了一只猫叫团子'); // 记一次「被用到」，还在内存里
  const f = path.join(dir, 'a', 'mem.json');
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  raw.items.push({ id: 'kfrom', t: 2, by: 'ai', kind: 'note', text: '团子今天打喷嚏', from: a.id, ppl: '她' });
  raw.items.push({ id: 'knum', t: 3, by: 'ai', kind: 'note', text: 12345 });
  fs.writeFileSync(f, JSON.stringify(raw));
  assert.doesNotThrow(() => s.list('a', { who: 'ai' }));
  assert.doesNotThrow(() => s.recall('a', '团子打喷嚏', 5, { who: 'me' })); // 她那边查，不记被用到
  assert.doesNotThrow(() => s.links('a', 'kfrom'));
  const disk = JSON.parse(fs.readFileSync(f, 'utf8')).items;
  assert.deepEqual([disk.find((m) => m.id === 'kfrom').from, disk.find((m) => m.id === 'kfrom').ppl, disk.find((m) => m.id === 'knum').text], [[a.id], ['她'], '12345']);
  s.flush();
  assert.equal(s.load('a').items.find((m) => m.id === a.id).used, 1); // 写回去的时候没把内存里那次弄丢、也没算两遍
  // 写入口也整理
  const b = s.add('a', { text: '新的一条', from: a.id, kw: '猫' }, 'ai');
  assert.deepEqual([b.from, b.kw], [[a.id], ['猫']]);
  s.patch('a', b.id, { kw: '狗' }, { who: 'ai' });
  assert.deepEqual(s.load('a').items.find((m) => m.id === b.id).kw, ['狗']);
  // 导入：text 不是字串的不收
  assert.equal(s.importAll('c', { items: [{ id: 'z1', kind: 'note', text: 42 }, { id: 'z2', kind: 'note', text: '好的', from: 'z1' }] }).added, 1);
});

test('读的时候要整理格式、但写不回去（目录只读）：照样读得出来，下次再写', () => {
  const { s, dir } = fresh();
  s.add('a', { text: '她养了一只猫叫团子' }, 'ai');
  const f = path.join(dir, 'a', 'mem.json');
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  raw.items.push({ id: 'kfrom', t: 2, by: 'ai', kind: 'note', text: '团子打喷嚏', from: 'x' });
  fs.writeFileSync(f, JSON.stringify(raw));
  fs.chmodSync(path.join(dir, 'a'), 0o500);
  try {
    assert.doesNotThrow(() => s.list('a', { who: 'ai' }));
    assert.deepEqual(s.load('a').items.find((m) => m.id === 'kfrom').from, ['x']);
  } finally { fs.chmodSync(path.join(dir, 'a'), 0o700); }
  s.load('a');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).items.find((m) => m.id === 'kfrom').from, ['x']);
});
