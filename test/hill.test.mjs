// 小山：发生过的要紧的事（记事）长成岛上的小山。高度 = TA 抬的 + 后端算的；只升不降、不能归档、能改正。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, isHill } from '../lib/store.mjs';
import { makeHooks } from '../lib/hooks.mjs';
import { openTalk } from '../lib/talk.mjs';
import { makeNight } from '../lib/night.mjs';

const DAY = 864e5;
const N = (o) => `<!--note ${JSON.stringify(o)} -->`;
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function fresh({ on = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-hill-'));
  dirs.push(dir);
  const clock = { t: Date.UTC(2026, 10, 15, 4) }; // 上海 11-15 12:00
  const now = () => clock.t;
  const s = openStore({ dir, tz: 'Asia/Shanghai', now, talk: openTalk({ dir, now }) });
  if (on) s.setCfg('a', { hill: true });
  return { s, clock, dir, h: makeHooks({ store: s, tz: 'Asia/Shanghai' }) };
}
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 0; };
const get = (s, id) => s.load('a').items.find((m) => m.id === id);

test('TA 抬山：只有记事；抬一次就成山；同一条一天一次，一天最多两座', () => {
  const { s, clock } = fresh();
  const [a, b, c] = ['她第一次唱歌给我听', '她搬家那天', '她考完试'].map((text) => s.add('a', { text }));
  assert.equal(isHill(a), false);
  const a1 = s.hillUp('a', a.id, '那天她很紧张');
  assert.deepEqual([a1.h, a1.hAi, isHill(a1)], [1, 1, true]);
  assert.equal(code(() => s.hillUp('a', a.id)), 429);
  s.hillUp('a', b.id);
  assert.equal(code(() => s.hillUp('a', c.id)), 429);
  clock.t += DAY;
  assert.equal(s.hillUp('a', c.id).h, 1);
  assert.equal(s.hillUp('a', a.id).h, 2); // 第二天能再抬
  const w = s.add('a', { kind: 'wish', text: '想跟她去看海' }, 'ai');
  assert.equal(code(() => s.hillUp('a', w.id)), 400);
  assert.equal(get(s, a.id).hTrail.at(-1).by, 'ai');
});

test('被想起：记下那天不算；之后在 3 个不同的日子想起过，第二天第一句话时重算成山；同一天想起多次只算一天', () => {
  const { s, clock } = fresh();
  const m = s.add('a', { text: '她第一次给我唱了生日歌' });
  const q = '生日歌';
  s.tick('a'); s.recall('a', q); s.recall('a', q); // 记下那天
  for (let i = 0; i < 3; i++) { clock.t += DAY; s.tick('a'); s.recall('a', q); s.recall('a', q); }
  assert.equal(get(s, m.id).hSig, 0.8); // 第四天第一句话时：想起过 2 天（不算第一天）
  assert.equal(isHill(get(s, m.id)), false);
  s.tick('a'); // 同一天再说话不重算
  assert.equal(get(s, m.id).hSig, 0.8);
  clock.t += DAY; s.tick('a');
  const x = get(s, m.id);
  assert.deepEqual([x.hSig, x.h, isHill(x), x.udays.length], [1, 1, true, 4]);
  assert.ok(x.hAt);
  assert.deepEqual(s.hills('a').map((y) => y.id), [m.id]);
});

test('连回：后来三条连回它，第二天第一句话时成山（当天不重算）；那三条归档后再算，高度不降', () => {
  const { s, clock } = fresh();
  const m = s.add('a', { text: '她搬家了' });
  s.tick('a');
  const kids = ['找到新房子', '退了旧房', '网络装好了'].map((text) => s.add('a', { text, from: [m.id] }, 'ai'));
  s.tick('a');
  assert.equal(get(s, m.id).h, undefined);
  clock.t += DAY; s.tick('a');
  assert.equal(get(s, m.id).h, 1);
  for (const k of kids) s.remove('a', k.id);
  clock.t += DAY; s.tick('a');
  assert.equal(get(s, m.id).h, 1);
  assert.equal(s.grow('a'), 1);
});

test('山不能归档（她和 TA 都不行），能改正，旧字留着；不是山的记事照常归档', () => {
  const { s } = fresh();
  const m = s.add('a', { text: '她 11-08 去了杭州' }, 'ai');
  const n = s.add('a', { text: '普通的一件事' }, 'ai');
  s.hillUp('a', m.id);
  assert.equal(code(() => s.remove('a', m.id)), 403);
  assert.equal(code(() => s.remove('a', m.id, { who: 'ai' })), 403);
  const f = s.patch('a', m.id, { text: '她 11-09 去了杭州' });
  assert.equal(f.hist.at(-1).text, '她 11-08 去了杭州');
  assert.equal(f.hist.at(-1).who, 'me');
  assert.equal(f.h, 1); // 改正不动高度
  assert.equal(code(() => s.patch('a', m.id, { h: 0 })), 403); // 高度不是她能改的
  assert.equal(s.remove('a', n.id).ok, true);
});

test('语气：她这句语音跟平时不一样，这一轮记下的记事带上；和平时差不多不带；只有语气不够成山', async () => {
  const { s, clock, h } = fresh();
  const voice = (cmp) => `[语音] x.m4a（20 秒）\n〔转写〕我今天面试过了\n〔测量〕20 秒 · 语速 5.0 字/秒 · ${cmp}`;
  await h.before('a', { text: voice('比她平时：声音比平时高、说得比平时快'), sid: 's1' });
  h.after('a', { reply: '恭喜！' + N({ kind: 'note', text: '她面试过了' }), sid: 's1' });
  await h.before('a', { text: voice('比她平时：和平时差不多'), sid: 's1' });
  h.after('a', { reply: '嗯' + N({ kind: 'note', text: '她晚饭吃了面' }), sid: 's1' });
  const [a, b] = s.load('a').items;
  assert.equal(a.tone, '声音比平时高、说得比平时快');
  assert.equal(b.tone, undefined);
  clock.t += DAY;
  await h.before('a', { text: '早', sid: 's2' });
  assert.deepEqual([get(s, a.id).h, isHill(get(s, a.id))], [0.5, false]);
  assert.equal(get(s, b.id).h, undefined);
});

test('小记 hill:up 走得通，界面那行是 hill；写 down 报错；开场露山（固有的不重复）、召回标出山', async () => {
  const { s, h } = fresh();
  const m = s.add('a', { text: '她第一次叫我的名字' });
  const p = s.add('a', { text: '她的生日是 3 月 2 日', pin: true });
  const r = h.after('a', { reply: '嗯' + N({ id: m.id, hill: 'up', why: '想起来还是暖的' }), sid: 's' });
  assert.deepEqual(r.rows, [{ id: m.id, kind: 'note', op: 'hill' }]);
  assert.equal(get(s, m.id).why, undefined); // why 进的是长高记录，不改这条的「为什么记」
  assert.equal(get(s, m.id).hTrail[0].why, '想起来还是暖的');
  assert.match(h.after('a', { reply: N({ id: m.id, hill: 'down' }) }).errors[0], /只会变高/);
  s.hillUp('a', p.id);
  const ctx = h.start('a', { source: 'startup' }).context;
  assert.match(ctx, new RegExp(`岛上的山[^]*\\[${m.id}\\]（高 1，`));
  assert.equal(ctx.split(p.id).length - 1, 1); // 固有的只在「一直记着的」里出现一次
  const b = await h.before('a', { text: '叫我的名字', sid: 's' });
  assert.match(b.context, /山 高 1/);
});

test('夜里整理：要并掉的里面有山，这一组不并；并普通记事时把想起过的日子一起并过去', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-hill-n-'));
  dirs.push(dir);
  const clock = { t: Date.UTC(2026, 10, 15, 12) };
  const now = () => clock.t;
  const s = openStore({ dir, tz: 'Asia/Shanghai', now, talk: openTalk({ dir, now }) });
  s.setCfg('a', { hill: true });
  const [k, hill, k2, d2] = ['她去了杭州', '她去杭州玩', '她养了猫', '她有一只猫'].map((text) => s.add('a', { text }));
  s.hillUp('a', hill.id);
  const dd = s.load('a'); dd.items.find((x) => x.id === d2.id).udays = ['2026-11-10']; s.save('a', dd);
  const runner = async () => JSON.stringify({ merge: [{ keep: k.id, drop: [hill.id], text: '去杭州' }, { keep: k2.id, drop: [d2.id], text: '她养猫' }] });
  const night = makeNight({ store: s, runner, tz: 'Asia/Shanghai', dir });
  const T = (await night.run('a', { tidy: true })).tidy;
  assert.equal(T.merged, 1);
  assert.equal(get(s, hill.id).gone, undefined);
  assert.deepEqual(get(s, k2.id).udays, ['2026-11-10']);
});

test('小山默认关：开场不提写法、不露山、不重算、抬不了、语气不记；开了才有', async () => {
  const { s, clock, h } = fresh({ on: false });
  const m = s.add('a', { text: '她第一次唱歌' });
  const kids = ['一', '二', '三'].map((text) => s.add('a', { text, from: [m.id] }, 'ai'));
  assert.doesNotMatch(h.start('a', { source: 'startup' }).context, /hill/);
  assert.equal(code(() => s.hillUp('a', m.id)), 400);
  await h.before('a', { text: '〔测量〕· 比她平时：声音比平时高', sid: 's' });
  h.after('a', { reply: N({ kind: 'note', text: '她今天很高兴' }), sid: 's' });
  assert.equal(s.load('a').items.at(-1).tone, undefined);
  clock.t += DAY; s.tick('a');
  assert.equal(get(s, m.id).h, undefined);
  assert.equal(s.getCfg('a').hill, false);
  s.setCfg('a', { hill: true });
  assert.match(h.start('a', { source: 'startup' }).context, /"hill":"up"/);
  clock.t += DAY; s.tick('a');
  assert.equal(get(s, m.id).h, 1);
  assert.equal(kids.length, 3);
});

test('TA 自己的想法：夜里整理能抬最多 3 座（只认记事、同一条算一次），算进 TA 那份；开场说一声；小山关着就不收、提示里也不提', async () => {
  for (const on of [true, false]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-hill-n2-'));
    dirs.push(dir);
    const clock = { t: Date.UTC(2026, 10, 15, 12) };
    const now = () => clock.t;
    const s = openStore({ dir, tz: 'Asia/Shanghai', now, talk: openTalk({ dir, now }) });
    if (on) s.setCfg('a', { hill: true });
    const ns = ['一', '二', '三', '四'].map((text) => s.add('a', { text: '记事' + text }));
    const w = s.add('a', { kind: 'view', text: '一个看法' }, 'ai');
    const seen = [];
    const runner = async (x) => { seen.push(x.prompt); return JSON.stringify({ hill: [{ id: w.id, why: 'x' }, { id: ns[0].id, why: '那天她哭了' }, { id: ns[0].id }, { id: ns[1].id }, { id: ns[2].id }, { id: ns[3].id }] }); };
    const night = makeNight({ store: s, runner, tz: 'Asia/Shanghai', dir });
    const T = (await night.run('a', { tidy: true })).tidy;
    if (on) {
      assert.match(seen[0], /## 岛上的山/);
      assert.equal(T.hills, 3);
      const a = get(s, ns[0].id);
      assert.deepEqual([a.h, a.hAi, a.hTrail[0].by, a.hTrail[0].why], [1, 1, 'night', '那天她哭了']);
      assert.equal(get(s, ns[3].id).h, undefined); // 第四条超了
      assert.equal(get(s, w.id).h, undefined); // 看法不算
      assert.equal(get(s, ns[2].id).h, 1);
      const h = makeHooks({ store: s, tz: 'Asia/Shanghai' });
      assert.match(h.start('a', { source: 'startup' }).context, /抬了 3 座山/);
    } else {
      assert.doesNotMatch(seen[0], /岛上的山/);
      assert.equal(T.hills, undefined);
      assert.equal(get(s, ns[0].id).h, undefined);
    }
  }
});

test('散场记的问话：小山开着才提「心里更重了可以抬」；散场记里写的 hill 照常算', async () => {
  const { s, h, clock } = fresh();
  const m = s.add('a', { text: '她说想去看海' });
  await h.before('a', { text: '在吗', sid: 's' });
  const q = h.idle('a', { why: 'idle' }).ask;
  assert.match(q, /"hill":"up"/);
  h.after('a', { reply: N({ id: m.id, hill: 'up', why: '想起来心里一紧' }), quiet: true });
  assert.equal(get(s, m.id).h, 1);
  s.setCfg('a', { hill: false });
  clock.t += 60e3;
  await h.before('a', { text: '还在吗', sid: 's' });
  assert.doesNotMatch(h.idle('a', { why: 'idle' }).ask, /hill/);
});

test('测量行从 ears 传进来（走 API 的聊天）：有「比她平时」且不是差不多才算语气；还没攒够、没有那一截的不算', async () => {
  const { s, h } = fresh();
  await h.before('a', { text: '我面试过了', ears: '3.0 秒 · 语速 5.0 字/秒（正常） · 一口气没停 · 比她平时：声音比平时高', sid: 's' });
  h.after('a', { reply: N({ kind: 'note', text: '她面试过了' }), sid: 's' });
  await h.before('a', { text: '嗯', ears: '3.0 秒 · 一口气没停 · 音高约 220 Hz，有起伏', sid: 's' });
  h.after('a', { reply: N({ kind: 'note', text: '她嗯了一声' }), sid: 's' });
  const [a, b] = s.load('a').items;
  assert.equal(a.tone, '声音比平时高');
  assert.equal(b.tone, undefined);
});

test('山的短名：TA 抬山时可以顺手起（最多 16 字），夜里的 TA 只给还没名字的起', async () => {
  const { s, h, clock } = fresh();
  const m = s.add('a', { text: '她第一次给我唱歌' });
  h.after('a', { reply: N({ id: m.id, hill: 'up', why: '想起来还是暖的', name: '第一次唱歌给我听的那个晚上真的很好听很好听' }), sid: 's' });
  assert.equal(get(s, m.id).hName, '第一次唱歌给我听的那个晚上真的很'.slice(0, 16));
  assert.equal([...get(s, m.id).hName].length, 16);
  clock.t += DAY;
  h.after('a', { reply: N({ id: m.id, hill: 'up', name: '  ' }), sid: 's2' });
  assert.equal([...get(s, m.id).hName].length, 16); // 空的不覆盖
});
