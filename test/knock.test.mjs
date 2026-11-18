// 主动找人：守门（纯函数）、设置、TA 自己定的回头看（小记、到点放进收件箱、她能看能取消）、收件箱的处理者。
// 让 TA 开口的那一步（chat.wake）这里用假的；真的那条在 chat.test.mjs 里拿假上游测。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { makeHooks } from '../lib/hooks.mjs';
import { openInbox } from '../lib/inbox.mjs';
import { createServer } from '../lib/server.mjs';
import { gate, quietEnd, nextAt, openKnock, makeHandlers, hintOf, KNOCK, IDLE_TEXT } from '../lib/knock.mjs';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const TZ = 'Asia/Shanghai';
const local = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi); // 上海时间 → 时间戳
const N = (o) => `<!--note ${JSON.stringify(o)} -->`;
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // 自己建的临时目录自己清

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-kn-'));
  dirs.push(dir);
  const clock = { t: local(2026, 11, 15, 14) };
  const now = () => clock.t;
  const store = openStore({ dir, tz: TZ, now });
  const act = { her: 0, wake: null };
  const knock = openKnock({ store, dir, tz: TZ, info: () => ({ ...act }) });
  const hooks = makeHooks({ store, tz: TZ, later: knock.later });
  return { dir, clock, store, knock, hooks, act };
}

test('守门：总开关默认关；外面的事看安静时段、一天几次、说了没回的冷却、平常的关心要心里有事；空下来要平静、够久、一天 2 次、安静时段也行但不推；回头看安静时段等它过去', () => {
  const at = (h, mi = 0) => local(2026, 11, 15, h, mi);
  const on = { on: true };
  assert.deepEqual(gate({ kind: 'knock', now: at(14), tz: TZ }), { ok: false, why: '主动找我没打开' });
  assert.deepEqual(gate({ kind: 'knock', now: at(14), tz: TZ, set: on }), { ok: true, push: true });
  assert.equal(gate({ kind: 'knock', now: at(23, 30), tz: TZ, set: on }).why, '安静时段');
  assert.equal(gate({ kind: 'knock', now: at(7, 59), tz: TZ, set: on }).why, '安静时段');
  assert.equal(gate({ kind: 'knock', now: at(8), tz: TZ, set: on }).ok, true);
  assert.equal(gate({ kind: 'knock', now: at(23, 30), tz: TZ, set: { on: true, quiet: null } }).ok, true);
  const st = { day: '2026-11-15', n: { knock: 5, idle: 2 } };
  assert.match(gate({ kind: 'knock', now: at(14), tz: TZ, set: on, st }).why, /今天已经叫醒 5 次/);
  assert.equal(gate({ kind: 'knock', now: local(2026, 11, 16, 14), tz: TZ, set: on, st }).ok, true); // 第二天重新算
  const wake = { t: at(13, 30), answered: false };
  assert.match(gate({ kind: 'knock', now: at(14), tz: TZ, set: on, act: { wake } }).why, /冷却/);
  assert.equal(gate({ kind: 'knock', now: at(14), tz: TZ, set: on, act: { wake: { ...wake, answered: true } } }).ok, true);
  assert.equal(gate({ kind: 'knock', now: at(14, 31), tz: TZ, set: on, act: { wake } }).ok, true);
  assert.match(gate({ kind: 'knock', now: at(14), tz: TZ, set: on, care: true, mood: { lv: 'calm' } }).why, /心里平静/);
  assert.equal(gate({ kind: 'knock', now: at(14), tz: TZ, set: on, care: true, mood: { lv: 'want' } }).ok, true);
  // 空下来
  const idle = { on: true, idle: true };
  assert.equal(gate({ kind: 'idle', now: at(14), tz: TZ, set: on }).why, '空下来没打开');
  assert.deepEqual(gate({ kind: 'idle', now: at(14), tz: TZ, set: idle, act: { her: at(7) } }), { ok: true, push: false });
  assert.match(gate({ kind: 'idle', now: at(14), tz: TZ, set: idle, act: { her: at(9) } }).why, /不到 6 小时/);
  assert.match(gate({ kind: 'idle', now: at(14), tz: TZ, set: idle, st: { knockT: at(10) } }).why, /不到 6 小时/);
  assert.match(gate({ kind: 'idle', now: at(14), tz: TZ, set: idle, mood: { lv: 'hold' } }).why, /心里有事/);
  assert.match(gate({ kind: 'idle', now: at(14), tz: TZ, set: idle, st }).why, /空下来已经 2 次/);
  assert.equal(gate({ kind: 'idle', now: at(23, 30), tz: TZ, set: idle }).ok, true); // 她睡了也能做
  assert.match(gate({ kind: 'idle', now: at(14), tz: TZ, set: idle, act: { her: at(4) }, st: { idleNo: 2 } }).why, /不到 12 小时/); // 连着两次不用，拉长
  // 回头看
  assert.equal(gate({ kind: 'later', now: at(14), tz: TZ, set: on }).why, '回头看没打开');
  assert.deepEqual(gate({ kind: 'later', now: at(14), tz: TZ, set: { on: true, later: true } }), { ok: true, push: true });
  const q = gate({ kind: 'later', now: at(23, 30), tz: TZ, set: { on: true, later: true } });
  assert.deepEqual([q.ok, q.wait], [false, local(2026, 11, 16, 8)]);
  assert.equal(gate({ kind: 'later', now: at(14), tz: TZ, set: { later: true } }).why, '主动找我没打开');
  // 时间小工具
  assert.equal(quietEnd(at(14), ['23:00', '08:00'], TZ), null);
  assert.equal(quietEnd(at(1, 15), ['23:00', '08:00'], TZ), at(8));
  assert.equal(quietEnd(at(13), ['12:00', '14:00'], TZ), at(14));
  assert.equal(nextAt(at(14, 0), '08:00', TZ), local(2026, 11, 16, 8));
  assert.equal(nextAt(at(7, 0), '08:00', TZ), at(8));
  assert.equal(nextAt(at(7, 55), '08:00', TZ), local(2026, 11, 16, 8)); // 不到 10 分钟算明天那个
});

test('设置：默认都关；改了留着；写错回 400；GET 带在等的回头看个数和说过什么的条数', async () => {
  const { store, knock, dir } = fresh();
  assert.deepEqual(knock.get('a'), { ...KNOCK, timers: 0 });
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store, knock });
  const { port } = await srv.listen();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, body: await r.json() };
  };
  try {
    const r = await call('PUT', '/api/knock/a', { on: true, perDay: 3, quiet: ['22:30', '07:00'], idleText: ' 你可以歇会儿 ', later: true });
    assert.deepEqual([r.body.on, r.body.perDay, r.body.quiet, r.body.idleText, r.body.later, r.body.idle], [true, 3, ['22:30', '07:00'], '你可以歇会儿', true, false]);
    assert.equal((await call('GET', '/api/knock/a')).body.perDay, 3);
    for (const bad of [{ on: 'yes' }, { perDay: -1 }, { perDay: 1.5 }, { cool: 9999 }, { quiet: ['25:00', '07:00'] }, { quiet: '23:00' }, { idleText: 'x'.repeat(501) }, { idleHours: 0 }]) {
      assert.equal((await call('PUT', '/api/knock/a', bad)).code, 400, JSON.stringify(bad));
    }
    assert.equal((await call('PUT', '/api/knock/a', { quiet: null })).body.quiet, null);
  } finally { await srv.close(); }
  const k2 = openKnock({ store, dir, tz: TZ, info: () => ({ said: { n: 2, items: [] } }) });
  assert.deepEqual(k2.get('a').said, { n: 2, items: [] });
});

test('回头看：关着时小记报「回头看没打开」、开场不提写法；开着才提；in / at、最短最长、why 必填和长度、最多等 5 个；TA 能取消；回复之后带 {kind:later, op}', () => {
  const { knock, hooks, clock, store } = fresh();
  let r = hooks.after('a', { reply: '好。' + N({ later: { in: '2h', why: '问她到家没' } }) });
  assert.deepEqual([r.notes, r.errors], [0, ['回头看没打开']]);
  assert.ok(!hooks.start('a', { source: 'startup' }).context.includes('"later"'));
  knock.set('a', { later: true });
  assert.deepEqual(hooks.after('a', { reply: N({ later: { in: '2h', why: 'x' } }) }).errors, ['回头看没打开']); // 总开关还关着
  knock.set('a', { on: true });
  assert.ok(hooks.start('a', { source: 'startup' }).context.includes('{"later":{"in":"2h"'));
  r = hooks.after('a', { reply: '好。' + N({ later: { in: '2h', why: '问她到家没' } }) });
  assert.deepEqual([r.notes, r.errors], [1, []]);
  assert.equal(r.marks.length, 1);
  const { id } = r.marks[0];
  assert.deepEqual(r.marks[0], { kind: 'later', op: 'add', id });
  const t0 = knock.timers.list('a').items[0];
  assert.deepEqual([t0.id, t0.due - clock.t, t0.why, t0.st], [id, 2 * HOUR, '问她到家没', 'wait']);
  const bad = [
    [{ in: '5m', why: 'x' }, '回头看最短 10 分钟、最长 7 天'], [{ in: '8d', why: 'x' }, '回头看最短 10 分钟、最长 7 天'],
    [{ in: '2 hours', why: 'x' }, 'in 写成 90m、2h、1d 这样'], [{ in: '2h' }, '回头看要写 why：到时候要做什么'],
    [{ in: '2h', why: '问'.repeat(101) }, '回头看的 why 最长 100 字'], [{ in: '2h', at: '08:00', why: 'x' }, '回头看的 in 和 at 要给一个（只给一个）'],
    [{ at: '8点', why: 'x' }, 'at 写成 08:00 这样'], ['2h', 'later 要写成 {"in":"2h","why":"…"}'],
  ];
  for (const [o, msg] of bad) assert.deepEqual(hooks.after('a', { reply: N({ later: o }) }).errors, [msg], JSON.stringify(o));
  r = hooks.after('a', { reply: N({ later: { at: '08:00', why: '早上问她睡得好不好' } }) + N({ later: { in: '90m', why: 'b' } }) + N({ later: { in: '1d', why: 'c' } }) + N({ later: { in: '10m', why: 'd' } }) });
  assert.deepEqual(r.errors, []);
  assert.equal(knock.timers.list('a').items.find((x) => x.why.startsWith('早上')).due, local(2026, 11, 16, 8));
  assert.deepEqual(hooks.after('a', { reply: N({ later: { in: '3h', why: 'e' } }) }).errors, ['在等的回头看已经有 5 个了']);
  // TA 取消
  r = hooks.after('a', { reply: N({ later: { cancel: id } }) });
  assert.deepEqual(r.marks, [{ kind: 'later', op: 'cancel', id }]);
  assert.deepEqual(hooks.after('a', { reply: N({ later: { cancel: id } }) }).errors, ['这个回头看已经不在等了']);
  assert.deepEqual(hooks.after('a', { reply: N({ later: { cancel: 'lnope' } }) }).errors, ['没有这个回头看']);
  assert.equal(knock.get('a').timers, 4);
  // 流水只有编号，不带 why
  const lg = store.readLog('a').filter((e) => String(e.op).startsWith('later'));
  assert.deepEqual(lg.map((e) => e.op), ['later-add', 'later-add', 'later-add', 'later-add', 'later-add', 'later-cancel']);
  assert.ok(!JSON.stringify(lg).includes('到家'));
});

test('回头看到点：放进收件箱（key 是它的编号）、标 fired；放不进去下一分钟再来；她能看、能取消（标 cancel 不真删）', async () => {
  const { knock, hooks, clock, store, dir } = fresh();
  knock.set('a', { on: true, later: true });
  const [m1] = hooks.after('a', { reply: N({ later: { in: '10m', why: '问她到家没' } }) }).marks;
  const [m2] = hooks.after('a', { reply: N({ later: { in: '1h', why: '第二个' } }) }).marks;
  const ib = openInbox({ dir, store });
  assert.deepEqual(knock.timers.fire((ai, x) => ib.put(ai, x)), []);
  clock.t += 10 * MIN;
  let boom = true;
  assert.deepEqual(knock.timers.fire(() => { if (boom) throw new Error('写不进'); }), []);
  assert.equal(knock.timers.list('a').items[0].st, 'wait');
  assert.deepEqual(knock.timers.fire((ai, x) => ib.put(ai, x)), [['a', m1.id]]);
  const q = ib.load('a')[0];
  assert.deepEqual([q.kind, q.key, q.body.why, q.body.id], ['later', m1.id, '问她到家没', m1.id]);
  assert.equal(knock.timers.list('a').items.find((x) => x.id === m1.id).st, 'fired');
  // 地址
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store, knock });
  const { port } = await srv.listen();
  try {
    const get = async () => (await (await fetch(`http://127.0.0.1:${port}/api/timers/a`)).json()).items;
    assert.deepEqual((await get()).map((x) => [x.id, x.st]), [[m2.id, 'wait'], [m1.id, 'fired']]);
    const d = await fetch(`http://127.0.0.1:${port}/api/timers/a/${m2.id}`, { method: 'DELETE' });
    assert.equal(d.status, 200);
    assert.deepEqual((await get()).map((x) => x.st), ['fired', 'cancel']);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/timers/a/${m2.id}`, { method: 'DELETE' })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/timers/a/lnope`, { method: 'DELETE' })).status, 404);
  } finally { await srv.close(); }
  clock.t += 2 * HOUR;
  assert.deepEqual(knock.timers.fire((ai, x) => ib.put(ai, x)), []); // 取消的不再响
  clock.t += 8 * DAY;
  hooks.after('a', { reply: N({ later: { in: '1h', why: '新的' } }) });
  assert.deepEqual(knock.timers.list('a').items.map((x) => x.why), ['新的']); // 7 天前到过点的、取消的清掉
});

test('处理者：先过守门（不过的标 drop 写原因；回头看在安静时段放回去等它过去）；过了让 TA 开口，记次数；合成的几件 knock 一起交给 TA；夜里交给 night.run', async () => {
  const { knock, clock, store, dir, act } = fresh();
  const woke = [];
  const chat = { wake: async (ai, o) => { woke.push(o); return { said: o.why !== 'idle' }; } };
  const nights = [];
  const ib = openInbox({ dir, store, handlers: makeHandlers({ knock, chat, night: { run: async (ai) => { nights.push(ai); } } }) });
  ib.put('a', { kind: 'knock', body: { why: '到学校了', brief: '她九点到了学校' } });
  await ib.pump('a');
  assert.deepEqual(ib.list('a').items.map((x) => [x.st, x.why]), [['drop', '主动找我没打开']]);
  assert.equal(woke.length, 0);
  knock.set('a', { on: true, idle: true, later: true });
  ib.put('a', { kind: 'knock', body: { why: '到学校了', brief: '她九点到了学校' } });
  ib.put('a', { kind: 'knock', body: { why: '下班了' } });
  await ib.pump('a');
  assert.equal(woke.length, 1);
  assert.deepEqual([woke[0].why, woke[0].about, woke[0].push], ['knock', '到学校了', true]);
  assert.equal(woke[0].hint, '守门人送来的简报（不是她说的话）：\n- 到学校了：她九点到了学校\n- 下班了');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'a', 'knock.json'), 'utf8')).n, { knock: 1 });
  // 平常的关心：心里平静不敲
  ib.put('a', { kind: 'knock', body: { why: '刷了两小时手机', care: true } });
  await ib.pump('a');
  assert.equal(ib.list('a').items.at(-1).why, '心里平静，平常的关心不用敲');
  // 空下来：TA 说「不用」也算一次；连着两次以后间隔拉长
  ib.put('a', { kind: 'idle', key: 'i0' });
  await ib.pump('a');
  assert.match(ib.list('a').items.at(-1).why, /不到 6 小时/); // 刚为外面的事叫醒过
  clock.t += 7 * HOUR;
  act.her = clock.t - 7 * HOUR;
  ib.put('a', { kind: 'idle', body: { why: 'idle', brief: '手边没有工具' } });
  await ib.pump('a');
  assert.deepEqual([woke.at(-1).why, woke.at(-1).push, woke.at(-1).hint], ['idle', false, IDLE_TEXT + '\n手边没有工具']);
  assert.deepEqual(ib.list('a').items.at(-1), { ...ib.list('a').items.at(-1), st: 'done', why: 'TA 选择不说' });
  // 回头看：安静时段放回去，过了再做
  clock.t = local(2026, 11, 15, 23, 30);
  ib.put('a', { kind: 'later', key: 'l1', body: { id: 'l1', why: '问她到家没', t: clock.t - 2 * HOUR } });
  await ib.pump('a');
  assert.equal(ib.load('a').at(-1).st, 'new');
  clock.t = local(2026, 11, 16, 8, 1);
  await ib.pump('a');
  assert.deepEqual([ib.load('a').at(-1).st, woke.at(-1).why, woke.at(-1).hint], ['done', 'later', '11 小时前你自己定的回头看：问她到家没']);
  // 夜里
  ib.put('a', { kind: 'night' });
  await ib.pump('a');
  assert.deepEqual(nights, ['a']);
  // 合成提示的样子
  assert.equal(hintOf({ kind: 'idle', body: {} }, { idleText: '歇会儿' }).hint, '歇会儿');
});
