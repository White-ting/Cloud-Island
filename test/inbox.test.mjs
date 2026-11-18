// 收件箱：放进来、去重、一次一件、合成、挂了重来、做完留 7 天、处理者的几种结果、地址、夜里改成往这里放。
// 处理者一律是注入的假函数；不调任何模型。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, fail } from '../lib/store.mjs';
import { openInbox } from '../lib/inbox.mjs';
import { createServer } from '../lib/server.mjs';
import { makeNight } from '../lib/night.mjs';

const MIN = 60e3, DAY = 864e5;
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // 自己建的临时目录自己清

function fresh(opt = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-ib-'));
  dirs.push(dir);
  const clock = { t: Date.UTC(2026, 10, 15, 4) };
  const now = () => clock.t;
  const store = openStore({ dir, tz: 'Asia/Shanghai', now });
  const state = { busy: false };
  const logs = [];
  const ib = openInbox({ dir, store, busy: () => state.busy, log: (...a) => logs.push(a.join(' ')), ...opt });
  return { dir, clock, store, ib, state, logs };
}

test('放进来：同一种同一个 key 24 小时内只算一件（回 dup）；没 key 不去重；kind、key、body 不对回错', () => {
  const { ib, clock } = fresh();
  const a = ib.put('a', { kind: 'knock', key: 'k1', body: { why: '到学校了' } });
  assert.deepEqual([a.kind, a.st, a.dup], ['knock', 'new', undefined]);
  assert.equal(a.body, undefined); // 回的不带内容
  const b = ib.put('a', { kind: 'knock', key: 'k1', body: { why: '又来' } });
  assert.deepEqual([b.id, b.dup], [a.id, true]);
  assert.notEqual(ib.put('a', { kind: 'later', key: 'k1' }).id, a.id); // 不同种不算重
  ib.put('a', { kind: 'idle' });
  ib.put('a', { kind: 'idle' });
  assert.equal(ib.load('a').length, 4);
  clock.t += DAY + 1;
  assert.notEqual(ib.put('a', { kind: 'knock', key: 'k1' }).id, a.id); // 过了 24 小时再来算新的
  for (const bad of [{ kind: 'x' }, { kind: 'knock', key: { a: 1 } }, { kind: 'knock', key: 'x'.repeat(201) }]) assert.throws(() => ib.put('a', bad), (e) => e.code === 400);
  assert.throws(() => ib.put('a', { kind: 'knock', body: 'x'.repeat(20000) }), (e) => e.code === 413);
  assert.throws(() => ib.put('../x', { kind: 'knock' }), (e) => e.code === 400);
});

test('一次一件：有 doing 时不取；TA 正忙不取；排着的几件 knock 取的时候合成一件；finish 后再取下一件', () => {
  const { ib, state } = fresh();
  const k1 = ib.put('a', { kind: 'knock', body: { why: '一' } });
  ib.put('a', { kind: 'idle' });
  const k2 = ib.put('a', { kind: 'knock', body: { why: '二' } });
  state.busy = true;
  assert.equal(ib.take('a'), null);
  state.busy = false;
  const x = ib.take('a');
  assert.deepEqual([x.id, x.st, x.many, x.body], [k1.id, 'doing', true, [{ why: '一' }, { why: '二' }]]);
  assert.equal(ib.load('a').find((y) => y.id === k2.id).into, k1.id);
  assert.equal(ib.take('a'), null); // 有 doing
  assert.equal(ib.doing('a'), true);
  ib.finish('a', x.id, { ok: true, said: true });
  assert.equal(ib.load('a').find((y) => y.id === k2.id).st, 'done');
  const y = ib.take('a');
  assert.equal(y.kind, 'idle');
  assert.equal(ib.finish('a', 'nope', {}), null);
  // 设置页看的：只有 id、t、kind、st、why
  ib.finish('a', y.id, { ok: false, drop: true, why: '空下来没打开' });
  const l = ib.list('a').items;
  assert.deepEqual(l.map((z) => Object.keys(z).sort().join()), ['id,kind,st,t', 'id,kind,st,t,why', 'id,kind,st,t,why']);
  assert.deepEqual(l.map((z) => z.st), ['done', 'drop', 'done']);
  assert.ok(!l.some((z) => 'body' in z));
});

test('挂了：doing 超过 10 分钟没 finish 变回 new、tries+1，满 3 次标 fail；进程重启时遗留的 doing 照同样规矩；做完的留 7 天', () => {
  const { ib, clock, dir, store } = fresh();
  const a = ib.put('a', { kind: 'night' });
  ib.take('a');
  clock.t += 9 * MIN;
  assert.equal(ib.take('a'), null); // 还没到 10 分钟
  clock.t += 2 * MIN;
  let x = ib.take('a'); // 挂了的变回 new，又被取走
  assert.deepEqual([x.id, x.tries], [a.id, 1]);
  clock.t += 11 * MIN;
  x = ib.take('a');
  assert.equal(x.tries, 2);
  clock.t += 11 * MIN;
  assert.equal(ib.take('a'), null);
  const f = ib.load('a')[0];
  assert.deepEqual([f.st, f.tries, f.why], ['fail', 3, '试了 3 次都没做完']);
  // 重启：遗留的 doing 都算挂了
  ib.put('b', { kind: 'later', key: 't1' });
  ib.take('b');
  const ib2 = openInbox({ dir, store });
  ib2.boot();
  assert.deepEqual(ib2.load('b').map((y) => [y.st, y.tries]), [['new', 1]]);
  // 7 天以后做完的清掉，没做的留着
  ib2.put('b', { kind: 'idle' });
  clock.t += 8 * DAY;
  ib2.put('b', { kind: 'idle' });
  assert.deepEqual(ib2.load('a'), [f]); // 还没写过的不动
  ib2.put('a', { kind: 'idle' });
  assert.deepEqual(ib2.load('a').map((y) => y.kind), ['idle']);
  assert.equal(ib2.load('b').length, 3);
});

test('处理者：没有的标 drop；回 drop 标 drop；抛 4xx 标 drop（原因照说）；抛 409 放回去晚点再来、不算失败；别的错隔一阵再试，满 3 次 fail；做完标 done 带 said', async () => {
  const seen = [];
  const H = {
    knock: async (ai, x) => { seen.push(x.kind); return { said: true }; },
    idle: async () => ({ drop: '空下来没打开' }),
    later: async () => { throw fail(404, '没有这个 AI（data/ais.json 里没写）'); },
    night: async () => { throw fail(409, '这一个正在跑'); },
  };
  const { ib, clock, logs } = fresh({ handlers: H });
  ib.put('a', { kind: 'knock', body: { why: 'x' } });
  ib.put('a', { kind: 'idle' });
  ib.put('a', { kind: 'later' });
  ib.put('a', { kind: 'sched' });
  ib.put('a', { kind: 'night' });
  assert.equal(await ib.pump('a'), 5);
  const st = Object.fromEntries(ib.load('a').map((x) => [x.kind, [x.st, x.why ?? null, x.tries]]));
  assert.deepEqual(st, {
    knock: ['done', null, 0], idle: ['drop', '空下来没打开', 0], later: ['drop', '没有这个 AI（data/ais.json 里没写）', 0],
    sched: ['drop', '没有处理这一种的（没配 AI，或者这一种还没做）', 0], night: ['new', null, 0],
  });
  assert.equal(ib.load('a').find((x) => x.kind === 'knock').said, true);
  assert.equal(await ib.pump('a'), 0); // 409 的那件一分钟内不再取
  // 别的错：隔一阵再试，三次以后 fail，日志不带内容
  H.night = async () => { throw new Error('里面有她的原话'); };
  for (let i = 0; i < 3; i++) { clock.t += 20 * MIN; await ib.pump('a'); }
  const n = ib.load('a').find((x) => x.kind === 'night');
  assert.deepEqual([n.st, n.tries], ['fail', 3]);
  assert.ok(!logs.join('\n').includes('原话'));
  // requeue 带 after：这个时间以前不取
  H.knock = async () => { throw Object.assign(new Error('安静时段'), { requeue: true, after: clock.t + 60 * MIN }); };
  ib.put('a', { kind: 'knock' });
  await ib.pump('a');
  clock.t += 30 * MIN;
  assert.equal(ib.take('a'), null);
  clock.t += 31 * MIN;
  assert.equal(ib.take('a').kind, 'knock');
});

test('处理者十分钟（这里改成 50 毫秒）没回：留着 doing 不卡住别的 AI，下次取件时按挂了处理', async () => {
  const H = { knock: (ai) => (ai === 'a' ? new Promise(() => {}) : Promise.resolve({ said: true })) };
  const { ib, clock } = fresh({ handlers: H, hangMs: 50 });
  ib.put('a', { kind: 'knock' });
  ib.put('b', { kind: 'knock' });
  await ib.pumpAll();
  assert.equal(ib.load('a')[0].st, 'doing');
  assert.equal(ib.load('b')[0].st, 'done');
  clock.t += 50;
  assert.equal(ib.take('a').tries, 1);
});

test('地址：放一件要口令；敲门地址转进收件箱（why 是 idle 的算空下来，ts 当去重编号）；设置页看的不带内容；收件箱在做时手动跑夜里回 409', async () => {
  const { ib, store, dir } = fresh();
  const night = { run: async () => ({ ok: true }), get: () => ({}) };
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store, inbox: ib, night });
  const { port } = await srv.listen();
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, body: await r.json() };
  };
  const A = { authorization: 'Bearer tok' };
  try {
    assert.equal((await call('POST', '/api/inbox/a', { kind: 'knock' })).code, 401);
    assert.equal((await call('POST', '/api/wake/a', { why: '到学校了' })).code, 401);
    const r1 = await call('POST', '/api/wake/a', { why: '到学校了', brief: '她九点到了学校', ts: 1794680286000, extra: 'x' }, A);
    assert.deepEqual([r1.code, r1.body.kind], [200, 'knock']);
    const r2 = await call('POST', '/api/wake/a', { why: '到学校了', brief: '重发', ts: 1794680286000 }, A);
    assert.deepEqual([r2.body.id, r2.body.dup], [r1.body.id, true]);
    assert.equal((await call('POST', '/api/wake/a', { why: 'idle', brief: '手边有这些' }, A)).body.kind, 'idle');
    assert.equal((await call('POST', '/api/wake/a', {}, A)).code, 400);
    assert.equal((await call('POST', '/api/inbox/a', { kind: 'later', key: 'l1', body: { why: '问她' } }, A)).body.kind, 'later');
    assert.equal((await call('POST', '/api/inbox/a', { kind: 'nope' }, A)).code, 400);
    const saved = ib.load('a')[0];
    assert.deepEqual([saved.key, saved.body], ['ts:1794680286000', { why: '到学校了', brief: '她九点到了学校', ts: 1794680286000 }]);
    const l = (await call('GET', '/api/inbox/a')).body.items;
    assert.equal(l.length, 3);
    assert.ok(!JSON.stringify(l).includes('学校'));
    // 互斥
    assert.equal((await call('POST', '/api/night/a/run', {}, A)).code, 200);
    ib.take('a');
    assert.equal((await call('POST', '/api/night/a/run', {}, A)).code, 409);
    assert.ok(fs.statSync(path.join(dir, 'a', 'inbox.json')).mode % 0o1000 === 0o600);
  } finally { await srv.close(); }
});

test('夜里改成往收件箱放：到点放一件 night（同一夜只放一件），由收件箱交给夜里去跑；手动跑时收件箱不取', async () => {
  const { store, dir, clock } = fresh();
  let ib;
  const runner = async () => '{"note":"好"}';
  runner.kind = 'fake';
  const night = makeNight({ store, runner, tz: 'Asia/Shanghai', dir, enqueue: (ai, x) => ib.put(ai, x) });
  ib = openInbox({ dir, store, busy: (ai) => night.busy(ai), handlers: { night: async (ai) => { await night.run(ai); return {}; } } });
  store.add('a', { text: '她今天说想睡觉' });
  night.set('a', { tidy: true });
  clock.t = Date.UTC(2026, 10, 16, 19, 1); // 上海 11-17 03:01
  assert.deepEqual(await night.tick(), ['a']);
  assert.deepEqual(await night.tick(), []); // 已经放了，一夜一件
  assert.deepEqual(ib.load('a').map((x) => [x.kind, x.key, x.st]), [['night', 'night:2026-11-17', 'new']]);
  assert.equal(store.load('a').cfg.lastNight, undefined); // 还没跑
  await ib.pump('a');
  assert.equal(ib.load('a')[0].st, 'done');
  assert.ok(store.load('a').cfg.lastNight.tidy);
  assert.deepEqual(await night.tick(), []); // 跑过了
  // 手动跑的时候收件箱不取件
  let release;
  const slow = makeNight({ store, runner: () => new Promise((ok) => { release = () => ok('{}'); }), tz: 'Asia/Shanghai', dir });
  const ib2 = openInbox({ dir, store, busy: (ai) => slow.busy(ai), handlers: {} });
  store.add('a', { text: '又一件新事' });
  const p = slow.run('a', { tidy: true });
  await new Promise((ok) => setImmediate(ok));
  ib2.put('a', { kind: 'idle' });
  assert.equal(ib2.take('a'), null);
  release();
  await p;
  assert.equal(ib2.take('a').kind, 'idle');
});
