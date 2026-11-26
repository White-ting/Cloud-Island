import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/store.mjs';
import { createServer } from '../lib/server.mjs';
import { makeHooks } from '../lib/hooks.mjs';
import { split, apply } from '../lib/notes.mjs';
import { openTalk } from '../lib/talk.mjs';

const DAY = 864e5;
const here = path.dirname(fileURLToPath(import.meta.url));
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // 自己建的临时目录自己清
// rand：「浮上来一条旧的」挑哪条，测试里固定住
function fresh({ rand = () => 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-'));
  dirs.push(dir);
  const clock = { t: Date.UTC(2026, 10, 15, 4) };
  const now = () => clock.t;
  const s = openStore({ dir, tz: 'Asia/Shanghai', now, rand, talk: openTalk({ dir, now }) });
  return { s, clock, dir, h: makeHooks({ store: s, tz: 'Asia/Shanghai' }) };
}
const N = (o) => `<!--note ${JSON.stringify(o)} -->`;

test('习惯：她和 TA 都能写；every 不写当「常常」；还在做的开场带上，停了的不带；别的种类不收 every', () => {
  const { s, h } = fresh();
  const a = s.add('a', { kind: 'habit', text: '提醒她喝水', every: '每天下午' }, 'me');
  assert.deepEqual([a.kind, a.every, a.st], ['habit', '每天下午', 'on']);
  const b = s.add('a', { kind: 'habit', text: '睡前说晚安' }, 'ai');
  assert.equal(b.every, '常常');
  assert.equal(s.add('a', { kind: 'note', text: '她喜欢面', every: '每天' }, 'me').every, undefined);
  s.patch('a', b.id, { st: 'off' }, { who: 'me' });
  const st = h.start('a', {}).text || JSON.stringify(h.start('a', {}));
  assert.ok(st.includes('每天下午：提醒她喝水'));
  assert.ok(!st.includes('睡前说晚安'));
});

test('小记：摘走、正文不留；坏的一行扔掉不影响别的', () => {
  const r = split(`那就面。\n\n${N({ kind: 'note', text: '她今晚想吃面' })}\n<!--note {坏的} -->\n${N({ state: { ease: '高' } })}`);
  assert.equal(r.clean, '那就面。');
  assert.equal(r.notes.length, 2);
  assert.equal(r.bad.length, 1);
  assert.equal(split('没有小记').clean, '没有小记');
});

test('回复之后：新记、动旧的、状态、护栏拦下的不影响别的', () => {
  const { s, h } = fresh();
  const r = h.after('a', { sid: 's1', reply: '好。' + N({ kind: 'wish', text: '想和她去看海', ppl: ['她'] }) + N({ kind: 'ask', text: '她为什么怕打雷' }) + N({ state: { ease: '高', energy: '低', say: '有点困' } }) });
  assert.equal(r.notes, 3);
  assert.equal(r.clean, '好。'); // 直接调有 clean；钩子路由回给外面时会删掉
  const items = s.list('a', { who: 'ai' }).items;
  const w = items.find((m) => m.kind === 'wish'), q = items.find((m) => m.kind === 'ask');
  assert.equal(w.by, 'ai');
  assert.equal(s.getState('a').say, '有点困');
  const r2 = h.after('a', { sid: 's1', reply: N({ id: w.id, lv: 'up', why: '又想起来了' }) + N({ id: w.id, lv: 'up' }) + N({ id: q.id, st: 'done' }) + N({ id: 'nope', text: 'x' }) + N({ state: { ease: '特别高' } }) });
  assert.equal(r2.notes, 2);
  assert.equal(r2.errors.length, 3);
  const w2 = s.list('a', { who: 'ai' }).items.find((m) => m.id === w.id);
  assert.equal(w2.lv, 2);
  assert.equal(w2.hits, 1);
  assert.equal(s.list('a', { who: 'ai' }).items.find((m) => m.id === q.id).st, 'done');
});

test('小记存的时候出了意外（不是护栏拦的）：接住记成「存不进去」、不带原文，别的照存，回复之后不报错', () => {
  const { s, h } = fresh();
  const r = apply({ add: () => { throw new Error('磁盘满了 /secret/path'); } }, 'a', [{ kind: 'note', text: '她的原话' }]);
  assert.deepEqual(r, { done: [], errors: ['这一条小记存不进去'] });
  const add = s.add;
  s.add = () => { throw new Error('磁盘满了'); };
  const r2 = h.after('a', { reply: '嗯。' + N({ kind: 'note', text: '存不进的' }) + N({ state: { ease: '平' } }) });
  assert.deepEqual([r2.notes, r2.errors, r2.clean], [1, ['这一条小记存不进去'], '嗯。']);
  assert.equal(s.getState('a').ease, '平');
  s.add = add;
});

test('落叶：不占一天两条；七天没人碰不漂走、只是沉下去不上水面；能被相关的话唤起、浮回水面；TA 能自己归档', async () => {
  const { s, h, clock } = fresh();
  h.after('a', { sid: 's1', reply: N({ kind: 'wish', lv: 0, text: '想去看一次萤火虫' }) + N({ kind: 'wish', lv: 0, text: '想学吹口琴' }) + N({ kind: 'wish', lv: 0, text: '想给她织一条围巾' }) + N({ kind: 'wish', text: '想和她去看海' }) + N({ kind: 'wish', text: '想学做她爱吃的面' }) });
  let ws = s.list('a', { who: 'ai' }).items;
  const by = (t) => ws.find((m) => m.text === t);
  assert.equal(ws.length, 5);
  const sea = by('想和她去看海'), fly = by('想去看一次萤火虫'), harp = by('想学吹口琴'), scarf = by('想给她织一条围巾');
  s.hit('a', sea.id, 's1'); s.wishMove('a', sea.id, 'up'); // 欲望：水位中，开场看水面
  assert.match(h.start('a', { source: 'startup' }).context, /还有 3 条小的/); // 三片落叶都还在水面上
  clock.t += 3 * DAY;
  h.after('a', { sid: 's2', reply: N({ id: fly.id, lv: 'up', why: '又绕回来了' }) }); // 绕回来升成船
  clock.t += 5 * DAY; // 口琴、围巾已经八天没人碰
  const c8 = h.start('a', { source: 'startup' }).context;
  assert.match(c8, /还有 1 条小的/); // 沉下去的两片不算
  assert.ok(!c8.includes('想给她织一条围巾'));
  // 不漂走：没进归档，照样在 TA 的列表里；水位不受影响
  ws = s.list('a', { who: 'ai' }).items;
  assert.equal(ws.length, 5);
  assert.equal(s.list('a', { gone: true, who: 'ai' }).items.length, 0);
  assert.equal(by('想去看一次萤火虫').lv, 1);
  assert.equal(s.mood('a').lv, 'want');
  assert.ok(s.recall('a', '围巾').some((m) => m.id === scarf.id)); // 相关的话照样带得出来
  // 她提到口琴 → 带出来；TA 接着说了 → 算想起一次，浮回水面
  assert.ok((await h.before('a', { text: '你会吹口琴吗', sid: 's3' })).context.includes('想学吹口琴'));
  h.after('a', { sid: 's3', reply: '会一点点，我一直想学吹口琴来着' });
  ws = s.list('a', { who: 'ai' }).items;
  assert.equal(by('想学吹口琴').hits, 1);
  assert.equal(by('想学吹口琴').lv, 0); // 还是落叶，只是又碰过了
  assert.match(h.start('a', { source: 'clear' }).context, /还有 2 条小的/);
  // 天数可以改
  s.setCfg('a', { leafDays: 30 });
  assert.match(h.start('a', { source: 'clear' }).context, /还有 3 条小的/);
  // TA 自己归档：只能收自己记的；归档的捡不回来（她在网页上捡）
  const mine = s.add('a', { text: '她爱吃面' });
  const r = h.after('a', { sid: 's4', reply: '嗯。' + N({ id: scarf.id, gone: true }) + N({ id: mine.id, gone: true }) + N({ id: scarf.id, gone: false }) });
  assert.equal(r.notes, 1);
  assert.equal(r.errors.length, 2);
  assert.deepEqual(s.list('a', { gone: true, who: 'ai' }).items.map((m) => m.id), [scarf.id]);
  assert.ok(s.list('a').items.some((m) => m.id === mine.id));
  assert.ok(s.readLog('a').some((e) => e.who === 'ai' && e.op === 'gone' && e.id === scarf.id));
  assert.ok(harp);
});

test('时不时浮现一下：开场一天最多一次，从沉下去的落叶和 30 天没用到的 TA 自己的看法/经验/疑问里挑；压缩后、专心不浮；私人念想也能浮', () => {
  let pick = 0;
  const { s, h, clock } = fresh({ rand: () => pick });
  const FL = '〔浮上来一条旧的〕';
  s.add('a', { kind: 'view', text: '她其实不怕黑' }, 'ai');
  s.add('a', { kind: 'ask', text: '她为什么总是早上喝冰水' }, 'ai');
  s.add('a', { kind: 'ask', text: '已经弄明白的', st: 'done' }, 'ai');
  s.add('a', { kind: 'exp', text: '固有的不用浮', pin: true }, 'ai');
  s.add('a', { kind: 'note', text: '她写的记事不浮' });
  s.add('a', { kind: 'wish', lv: 0, text: '悄悄的落叶', priv: true }, 'ai');
  assert.ok(!h.start('a', { source: 'startup' }).context.includes(FL)); // 都还新：没有候选
  clock.t += 31 * DAY;
  assert.ok(!h.start('a', { source: 'compact' }).context.includes(FL));
  assert.ok(!h.start('a', { source: 'startup', focus: true }).context.includes(FL));
  pick = 0.99; // 挑最后一个候选
  const c = h.start('a', { source: 'startup' }).context;
  const got = c.match(/〔浮上来一条旧的〕(.*)（(k\w+)）/);
  assert.ok(got, c);
  assert.equal(got[1], '悄悄的落叶'); // 私人念想也可以浮（给 TA 看的）
  assert.ok(!h.start('a', { source: 'startup' }).context.includes(FL)); // 一天一次
  const seen = new Set([got[1]]);
  for (let i = 0; i < 2; i++) { // 再过两天，每天挑第一个：浮过的看法算用到了，第二天就轮到疑问
    clock.t += DAY;
    pick = 0;
    const m = h.start('a', {}).context.match(/〔浮上来一条旧的〕(.*)（/);
    if (m) seen.add(m[1]);
  }
  assert.deepEqual([...seen].sort(), ['她为什么总是早上喝冰水', '她其实不怕黑', '悄悄的落叶'].sort());
});

test('交接：TA 写的只留最新一句、最长 600 字、7 天内开场原样带；不是记忆、不进搜索和导出的 items', () => {
  const { s, h, clock } = fresh();
  const r = h.after('a', { sid: 's1', reply: '好。' + N({ handoff: '旧的一句' }) + N({ handoff: '聊到她外婆了，下次问问排骨怎么做' }) + N({ handoff: '' }) + N({ handoff: { x: 1 } }) });
  assert.deepEqual([r.notes, r.errors.length], [2, 2]);
  assert.equal(s.getHandoff('a').text, '聊到她外婆了，下次问问排骨怎么做');
  assert.equal(s.getHandoff('a').sid, 's1');
  assert.equal(s.list('a', { who: 'ai' }).items.length, 0);
  assert.equal(s.recall('a', '外婆').length, 0);
  const ex = s.exportAll('a');
  assert.equal(ex.items.length, 0);
  assert.equal(ex.handoff.text, '聊到她外婆了，下次问问排骨怎么做');
  clock.t += 3 * 3600e3;
  for (const opt of [{ source: 'startup' }, { source: 'compact' }, { source: 'resume', focus: true }]) { // 什么来源都带，专心也带
    const c = h.start('a', opt).context;
    assert.ok(c.includes('〔交接〕\n你上次留的交接（3 小时前写的）：聊到她外婆了，下次问问排骨怎么做'), c);
  }
  s.setHandoff('a', '长'.repeat(700));
  assert.equal([...s.getHandoff('a').text].length, 600);
  clock.t += 8 * DAY;
  assert.ok(!h.start('a', { source: 'startup' }).context.includes('〔交接〕'));
  assert.ok(s.readLog('a').some((e) => e.op === 'handoff' && !e.text));
});

test('交接：后端从原文里给最后三个来回（每句最多 300 字）和上一场记了哪几条（私人念想也给）；新开的要上一场不到 48 小时；原文关着只给 TA 写的', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-'));
  dirs.push(dir);
  const clock = { t: Date.UTC(2026, 10, 15, 4) }, now = () => clock.t;
  const s = openStore({ dir, tz: 'Asia/Shanghai', now, talk: openTalk({ dir, now, keepMs: 100 * 3600e3 }) }); // 原文留得比 48 小时久，才看得出「上一场不到 48 小时」那一条
  const h = makeHooks({ store: s, tz: 'Asia/Shanghai' });
  await h.before('a', { text: '上上一场的话', sid: 's0' });
  h.after('a', { sid: 's0', reply: '上上一场的回' + N({ kind: 'note', text: '上上一场记的' }) });
  for (let i = 1; i <= 4; i++) {
    await h.before('a', { text: `第${i}句她说的`, sid: 's1' });
    h.after('a', { sid: 's1', reply: `第${i}句我回的` + (i === 4 ? '长'.repeat(400) : '') });
  }
  h.after('a', { sid: 's1', reply: N({ kind: 'wish', text: '悄悄想她', priv: true }) + N({ kind: 'note', text: '她今天第一次说起她的外婆，外婆住在杭州，很会做糖醋排骨' }) });
  clock.t += 3 * 3600e3;
  const c = h.start('a', { source: 'startup' }).context;
  assert.ok(c.startsWith('〔记忆库 · 开场〕\n〔交接〕\n上一场最后 3 个来回（原话）：\n她：第2句她说的\n你：第2句我回的\n她：第3句她说的'), c);
  assert.ok(!c.includes('第1句') && !c.includes('上上一场'));
  assert.ok(c.includes('你：第4句我回的' + '长'.repeat(294) + '…\n')); // 300 字截断
  assert.match(c, /上一场记了这几条：\[k\w+\] 悄悄想她；\[k\w+\] 她今天第一次说起她的外婆，外婆住在杭州，很会做糖醋排骨/);
  assert.ok(!c.includes('上上一场记的'));
  assert.match(h.start('a', { source: 'compact' }).context, /压缩前最后 3 个来回/);
  // 来回数可以改
  s.setCfg('a', { talkRounds: 1 });
  assert.match(h.start('a', { source: 'resume' }).context, /上一场最后 1 个来回（原话）：\n她：第4句她说的\n你：第4句/);
  // 上一场结束超过 48 小时：新开的不给原话；接着聊的（压缩、清屏、续上）照给
  clock.t += 46 * 3600e3;
  assert.ok(!h.start('a', { source: 'startup' }).context.includes('〔交接〕'));
  assert.ok(h.start('a', { source: 'clear' }).context.includes('上一场最后 1 个来回'));
  // 原文关着：只给 TA 写的那句
  s.setHandoff('a', '下次接着说外婆');
  s.setCfg('a', { talk: false });
  const off = h.start('a', { source: 'compact' }).context;
  assert.ok(off.includes('〔交接〕\n你上次留的交接（0 分钟前写的）：下次接着说外婆') && !off.includes('来回'), off);
});

test('快压缩时提醒写交接：跌进 10% 一次，7%、4%、1% 各一次；写过交接就不再提醒；回到 10% 以上重置；没给 ctxLeft 不提醒', async () => {
  const { h, s, clock } = fresh();
  const say = async (ctxLeft) => (clock.t += 60e3, await h.before('a', { text: '嗯', ctxLeft })).context.match(/〔快压缩了（还剩约 (\d+)%）/)?.[1] ?? null;
  const got = [];
  for (const v of [undefined, 0.5, 0.10, 0.09, 0.07, 0.05, 0.04, 0.02, 0.01, 0.005]) got.push(await say(v));
  assert.deepEqual(got, [null, null, '10', null, '7', null, '4', null, '1', null]);
  assert.equal(await say(0.6), null); // 压缩完了：重置
  assert.equal(await say(0.08), '8');
  h.after('a', { reply: '好。' + N({ handoff: '在改钩子，下一步写测试' }) });
  assert.equal(await say(0.06), null); // 这一轮写过交接
  assert.equal(await say(0.03), null);
  assert.equal(await say(0.5), null);
  assert.equal(await say(0.09), '9'); // 新的一轮：上一轮写的交接不算
  assert.ok((await h.before('a', { text: '嗯', ctxLeft: 0.06, focus: true })).context.includes('快压缩了')); // 专心也提醒
  assert.ok(s.getHandoff('a'));
});

test('快压缩时告诉调用方做散场记：只在跌进 10% 的那一次回 digest:true；同一轮不重复，写过交接也照给；回到 10% 以上再跌进去重新给', async () => {
  const { h, clock } = fresh();
  const flag = async (ctxLeft) => (clock.t += 60e3, (await h.before('a', { text: '嗯', ctxLeft })).digest ?? false);
  const got = [];
  for (const v of [undefined, 0.5, 0.11, 0.09, 0.07, 0.03]) got.push(await flag(v));
  assert.deepEqual(got, [false, false, false, true, false, false]);
  assert.equal(await flag(0.8), false); // 压缩完了
  h.after('a', { reply: N({ handoff: '先写好交接' }) });
  assert.equal(await flag(0.1), true); // 新的一轮又跌进来（交接写没写不影响散场记）
  assert.equal(await flag(0.1), false);
});

test('水位决定带多少：低不带，中只在开场带，高每条消息前都带、大的在前', async () => {
  const { s, h, clock } = fresh();
  s.add('a', { text: '她叫 小满', pin: true });
  s.add('a', { kind: 'pact', text: '周末一起看电影', who: '我' });
  const w = s.add('a', { kind: 'wish', text: '想和她去看海' }, 'ai');
  const w2 = s.add('a', { kind: 'wish', text: '想学会做她爱吃的面' }, 'ai');
  // 低
  assert.ok(!h.start('a', {}).context.includes('水面'));
  assert.ok(h.start('a', {}).context.includes('周末一起看电影'));
  assert.ok(h.start('a', {}).context.includes('小记怎么写'));
  assert.ok(!(await h.before('a', { text: '今天上班好累' })).context.includes('水面'));
  // 她的话正好碰到 → 跟着相近的出来
  assert.ok((await h.before('a', { text: '周末要不要去看海' })).context.includes('想和她去看海'));
  // 中
  s.hit('a', w.id, 's1'); s.wishMove('a', w.id, 'up');
  assert.ok(h.start('a', {}).context.includes('水位中'));
  assert.ok(!(await h.before('a', { text: '今天上班好累' })).context.includes('水面'));
  // 高
  clock.t += DAY;
  s.hit('a', w.id, 's2'); s.wishMove('a', w.id, 'up');
  const ctx = (await h.before('a', { text: '今天上班好累' })).context;
  assert.ok(ctx.includes('水位高') && ctx.includes('（执念）想和她去看海') && ctx.includes('还有 1 条小的'));
  assert.ok(!ctx.includes('想学会做她爱吃的面'));
  // 专心：不带
  assert.ok(!(await h.before('a', { text: '今天上班好累', focus: true })).context.includes('水面'));
  // 压缩前：约定和执念要保住
  const keep = h.compact('a').keep;
  assert.ok(keep.includes('周末一起看电影') && keep.includes('想和她去看海') && !keep.includes(w2.text));
});

test('每条消息前：时间、隔了多久、第几轮；带出去的念想 TA 真接着说了才算想起一次', async () => {
  const { s, h, clock } = fresh();
  const w = s.add('a', { kind: 'wish', text: '想和她去看海' }, 'ai');
  assert.match((await h.before('a', { text: '嗨' })).context, /现在 2026\/11\/15.*12:00.*今天第 1 轮/);
  clock.t += 5 * 3600e3;
  const c = (await h.before('a', { text: '周末去看海吗' })).context;
  assert.match(c, /距她上一句 5 小时；今天第 2 轮/);
  h.after('a', { sid: 's1', reply: '好啊。' });                 // 调出来了但没接着说
  assert.equal(s.list('a', { who: 'ai' }).items[0].hits, 0);
  await h.before('a', { text: '周末去看海吗' });
  h.after('a', { sid: 's1', reply: '我一直想和她去看海来着，周末就去。' });
  assert.equal(s.list('a', { who: 'ai' }).items[0].hits, 1);
  assert.equal(w.id, s.list('a', { who: 'ai' }).items[0].id);
});

test('开场：久不碰的念想问一句，只问一次；记忆锁的密码在开场里、不在别处', async () => {
  const { s, h, clock } = fresh();
  s.add('a', { kind: 'wish', text: '想和她去看海' }, 'ai');
  s.setLock('a', { pass: 'hunter2' });
  clock.t += 15 * DAY;
  const c1 = h.start('a', { source: 'startup' }).context;
  assert.ok(c1.includes('还在吗') && c1.includes('hunter2') && c1.includes('不要随口给'));
  assert.ok(!h.start('a', {}).context.includes('还在吗'));
  assert.ok(!(await h.before('a', { text: '密码是多少' })).context.includes('hunter2'));
  assert.ok(h.start('a', { source: 'compact' }).context.startsWith('〔记忆库 · 压缩之后〕'));
});

test('Claude Code 钩子脚本：拿假的事件真跑一遍；后端连不上也安静退出', async () => {
  const { s, dir } = fresh();
  s.add('a', { text: '她叫 小满', pin: true });
  s.add('a', { kind: 'pact', text: '周末一起看电影' });
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: s, hooks: makeHooks({ store: s, tz: 'Asia/Shanghai' }) });
  const { port } = await srv.listen();
  const envf = path.join(dir, 'env'), sh = path.join(here, '../examples/claude-code/hook.sh');
  const write = (p, tok = 'tok') => fs.writeFileSync(envf, `MEM_URL=http://127.0.0.1:${p}\nMEM_AI=a\nMEM_TOKEN=${tok}\n`);
  // 钩子是另一个进程，得用不卡住事件循环的办法跑
  const { spawn } = await import('node:child_process');
  const run = (when, ev) => new Promise((ok) => {
    const p = spawn('/bin/sh', [sh, when], { env: { ...process.env, MEM_ENV: envf, MEM_LOG: path.join(dir, 'hook.log') } });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('close', (status) => ok({ status, out }));
    p.stdin.end(JSON.stringify(ev));
  });
  try {
    write(port);
    const a = await run('start', { hook_event_name: 'SessionStart', source: 'startup' });
    assert.equal(a.status, 0);
    const ja = JSON.parse(a.out);
    assert.equal(ja.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(ja.hookSpecificOutput.additionalContext.includes('她叫 小满'));
    const b = await run('before', { prompt: '周末看什么电影', session_id: 's1' });
    assert.equal(JSON.parse(b.out).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const c = await run('after', { last_assistant_message: '看那部吧。' + N({ kind: 'note', text: '她周末想看电影' }), session_id: 's1' });
    assert.deepEqual([c.status, c.out], [0, '']);
    assert.ok(s.list('a').items.some((m) => m.text === '她周末想看电影'));
    const skip = await run('after', { stop_hook_active: true, last_assistant_message: N({ kind: 'note', text: '不该记' }) });
    assert.equal(skip.out, '');
    assert.ok(!s.list('a').items.some((m) => m.text === '不该记'));
    assert.ok((await run('compact', {})).out.includes('周末一起看电影'));
    // 对话原文：她的话和 TA 摘掉小记的正文，带着这一场的编号
    assert.deepEqual(s.talk.recent('a').map((r) => [r.role, r.sid, r.text]), [['me', 's1', '周末看什么电影'], ['ai', 's1', '看那部吧。']]);
    // 离压缩还剩多少：没配 MEM_CTX_LEFT_CMD 就不传（上面那次没有提醒）；配了用它的输出；输出不是 0–1 的小数就不传
    assert.ok(!b.out.includes('快压缩了'));
    const ctx = async (cmd) => {
      fs.writeFileSync(envf, `MEM_URL=http://127.0.0.1:${port}\nMEM_AI=a\nMEM_TOKEN=tok\nMEM_CTX_LEFT_CMD='${cmd}'\n`);
      const r = await run('before', { prompt: '嗯', session_id: 's1' });
      return [r.status, JSON.parse(r.out).hookSpecificOutput.additionalContext.includes('快压缩了（还剩约 5%）')];
    };
    assert.deepEqual(await ctx('echo abc'), [0, false]);
    assert.deepEqual(await ctx('echo 5'), [0, false]);
    assert.deepEqual(await ctx('echo 0.05'), [0, true]);
    write(port);
    // 口令不对、后端关了：都什么也不输出，退出码 0
    write(port, 'wrong');
    assert.deepEqual(await run('before', { prompt: 'x' }).then((r) => [r.status, r.out]), [0, '']);
    await srv.close();
    assert.deepEqual(await run('start', {}).then((r) => [r.status, r.out]), [0, '']);
    assert.ok(fs.readFileSync(path.join(dir, 'hook.log'), 'utf8').trim().split('\n').length >= 2);
  } finally { try { await srv.close(); } catch {} }
});

// ---- 召回顺着连线（照 Obsidian）----
// 一串连着的：来处 root ← mid → 生出来的 c1、c2、念想 w（新的在后），还有一条归档了的 g
function chain() {
  const f = fresh(), { s, clock } = f;
  const root = s.add('a', { kind: 'note', text: '她养了一只橘猫' }, 'me');
  clock.t += 1000; const mid = s.add('a', { kind: 'pact', text: '每周五给团子买罐头', from: [root.id] }, 'me');
  clock.t += 1000; const c1 = s.add('a', { kind: 'note', text: '换成鸡肉味了', from: [mid.id] }, 'me');
  clock.t += 1000; const c2 = s.add('a', { kind: 'exp', text: '她说下次带去体检', from: [mid.id] }, 'ai');
  clock.t += 1000; const w = s.add('a', { kind: 'wish', text: '想看看它长什么样', from: [mid.id] }, 'ai');
  clock.t += 1000; const g = s.add('a', { kind: 'note', text: '这条要收起来', from: [mid.id] }, 'me');
  s.remove('a', g.id);
  s.add('a', { kind: 'note', text: '今天下雨' }, 'me');
  return { ...f, root, mid, c1, c2, w, g };
}

test('召回连线：最像那条特别像时自动带连着的，先来处、再新生出来的，最多 3 条、只走一步；归档的不带；跟着来的不算想起', async () => {
  const { s, h, root, mid, c1, c2, w, g } = chain();
  const c = (await h.before('a', { text: '每周五给团子买罐头' })).context;
  const rows = c.split('\n');
  const i = rows.findIndex((r) => r.includes(`[${mid.id}]`));
  assert.ok(i > 0);
  assert.deepEqual(rows.slice(i + 1, i + 4), [
    `  ↳ 它从这条来 [${root.id}]（记事，11-15）她养了一只橘猫`,
    `  ↳ 从它生出来 [${w.id}]（念想，11-15）想看看它长什么样`,
    `  ↳ 从它生出来 [${c2.id}]（经验，11-15）她说下次带去体检`,
  ]);
  assert.ok(!c.includes(c1.id), '超过 3 条的不带');
  assert.ok(!c.includes(g.id), '归档的不带');
  assert.ok(!c.includes('memory_read'), '展开了就不用提示');
  // 跟着来的念想不算想起：不进 recalled，也不记「被用到」
  assert.ok(!s.lastRecalled('a').includes(w.id));
  const items = s.load('a').items;
  assert.ok(!items.find((m) => m.id === w.id).used);
  assert.ok(!items.find((m) => m.id === root.id).used);
  assert.equal(items.find((m) => m.id === mid.id).used, 1);
});

test('召回连线：不够像就不展开，只标「连着几条」并提示 memory_read；已经在召回里的不重复算', async () => {
  const { h, mid } = chain();
  const c = (await h.before('a', { text: '周五买罐头吧' })).context;
  assert.ok(c.includes(`[${mid.id}]（约定，11-15）每周五给团子买罐头（连着 4 条）`));
  assert.ok(!c.includes('↳'));
  assert.match(c, /memory_read/);
});

test('召回：最像的那条给全文，其余照旧截成一行', async () => {
  const { s, h } = fresh();
  const long = '团子的故事：' + '它今天又趴在窗台上晒太阳。'.repeat(20);
  const other = '团子的另一个故事：' + '它把毛线球推到了沙发底下。'.repeat(20);
  s.add('a', { kind: 'note', text: long }, 'me');
  s.add('a', { kind: 'note', text: other }, 'me');
  const c = (await h.before('a', { text: '团子的故事' })).context;
  assert.ok(c.includes(long), '最像的给全文');
  assert.ok(!c.includes(other) && c.includes(other.slice(0, 120) + '…'), '其余截到 120 字');
});

test('读一条：全文 + 连着的几条；读的这条算用到一次，连着的不算；编号不对 404', () => {
  const { s, h, root, mid, w } = chain();
  const t = h.read('a', mid.id);
  assert.match(t, new RegExp(`^\\[${mid.id}\\]（约定，.+记的）每周五给团子买罐头`));
  assert.ok(t.includes('连着的：') && t.includes(`它从这条来 [${root.id}]`) && t.includes(`从它生出来 [${w.id}]`));
  assert.ok(h.read('a', root.id).includes(`从它生出来 [${mid.id}]`));
  const items = s.load('a').items;
  assert.equal(items.find((m) => m.id === mid.id).used, 1);
  assert.ok(!items.find((m) => m.id === w.id).used);
  assert.match(h.read('a', s.add('a', { kind: 'note', text: '孤零零的一条' }, 'me').id), /没有连着的/);
  assert.throws(() => h.read('a', 'nope'), (e) => e.code === 404);
});

test('召回连线（审稿补）：专心模式下连着的念想不带也不计数；「连着 N 条」数全，超过 9 条也照实数', async () => {
  const { s, h, mid, w, c2 } = chain();
  const c = (await h.before('a', { text: '每周五给团子买罐头', focus: true })).context;
  assert.ok(!c.includes(w.id), '专心模式不带念想');
  assert.ok(c.includes(c2.id));
  for (let i = 0; i < 10; i++) s.add('a', { kind: 'note', text: `第${i}件小事`, from: [mid.id] }, 'me');
  assert.ok((await h.before('a', { text: '周五买罐头吧' })).context.includes('（连着 14 条）'));
});

test('读一条（审稿补）：读念想放进这一轮的候选，接着说到它就算想起一次；读别的不放；不多算一轮', () => {
  const { s, h, mid, w } = chain();
  const r0 = s.load('a').sess?.rounds;
  h.read('a', mid.id);
  assert.ok(!s.lastRecalled('a').includes(mid.id));
  h.read('a', w.id);
  assert.ok(s.lastRecalled('a').includes(w.id));
  assert.equal(s.load('a').sess?.rounds, r0);
  const before = s.load('a').items.find((m) => m.id === w.id).hits || 0;
  h.after('a', { reply: '我刚才在想，想看看它长什么样', sid: 's1' });
  assert.equal(s.load('a').items.find((m) => m.id === w.id).hits, before + 1);
});

test('召回带日期：今年的写月-日，往年的写全年月日', async () => {
  const { s, h, clock } = fresh();
  clock.t = Date.UTC(2025, 10, 8, 4);
  s.add('a', { kind: 'note', text: '去年冬天她第一次说起团子' }, 'me');
  clock.t = Date.UTC(2026, 10, 8, 4);
  s.add('a', { kind: 'note', text: '今年她又说起团子怕冷' }, 'me');
  clock.t = Date.UTC(2026, 10, 20, 4);
  const c = (await h.before('a', { text: '团子' })).context;
  assert.match(c, /（记事，2025-11-08）去年冬天/);
  assert.match(c, /（记事，11-08）今年她又说起/);
});

test('冷却：递过去、TA 说到了的歇 6 轮；连着 3 轮没说到的歇 3 轮；她原样问到照样递', async () => {
  const { s, h, clock } = fresh();
  const a = s.add('a', { kind: 'note', text: '她喜欢在雨天听黑胶唱片' }, 'ai');
  const b = s.add('a', { kind: 'note', text: '她周三晚上去游泳馆游泳' }, 'ai');
  const ask = async (t) => { clock.t += 60e3; return (await h.before('a', { text: t })).context; };
  // 第 1 轮：两条都递了；TA 说到了唱片那条
  let c = await ask('雨天听唱片还是游泳');
  assert.ok(c.includes(a.id) && c.includes(b.id));
  h.after('a', { reply: '下雨天就适合听黑胶唱片呀' });
  // 接下来 6 轮里唱片那条歇着（游泳那条没说到，照常递，连着 3 轮没说到后也歇）
  c = await ask('雨天听唱片还是游泳'); assert.ok(!c.includes(a.id) && c.includes(b.id)); h.after('a', { reply: '嗯' });
  c = await ask('雨天听唱片还是游泳'); assert.ok(!c.includes(a.id) && c.includes(b.id)); h.after('a', { reply: '嗯' });
  c = await ask('雨天听唱片还是游泳'); assert.ok(!c.includes(a.id) && !c.includes(b.id)); h.after('a', { reply: '嗯' });
  // 她原样说出那条：歇着也递
  c = await ask('她喜欢在雨天听黑胶唱片'); assert.ok(c.includes(a.id));
  h.after('a', { reply: '嗯' });
  // 过了 6 轮：唱片那条回来
  for (let i = 0; i < 4; i++) { await ask('随便聊聊天气'); h.after('a', { reply: '好' }); }
  c = await ask('雨天听唱片还是游泳'); assert.ok(c.includes(a.id));
});

test('联想：回复后拿这一来一回备着，下一句挑一件带全文；跟这轮想起来的重了不挑；打算过了日子写明没记到结果', async () => {
  // 门槛 0.62 是照向量分定的；这里没向量、只有字面，门槛放低
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-')); dirs.push(dir);
  const clock = { t: Date.UTC(2026, 10, 15, 4) }, now = () => clock.t;
  const s = openStore({ dir, tz: 'Asia/Shanghai', now, rand: () => 0, recallCfg: { callAt: 0.1 } }), h = makeHooks({ store: s, tz: 'Asia/Shanghai' });
  const old = s.add('a', { kind: 'note', text: '她十月说过想学做红烧肉，要找周末试' }, 'ai');
  s.add('a', { kind: 'wish', text: '想跟她一起学做红烧肉，周末试' }, 'ai'); // 念想不备
  const d0 = s.load('a'); d0.items.find((m) => m.id === old.id).tag = { emo: 0, follow: { what: '周末试做红烧肉', day: '2026-11-01' }, ppl: [], at: 1 }; s.save('a', d0);
  const ask = async (t) => { clock.t += 60e3; return (await h.before('a', { text: t })).context; };
  // 这轮没递到，回复里聊到了：备着
  await ask('晚上吃什么好呢');
  h.after('a', { reply: '要不试试红烧肉，你之前说想学做红烧肉，周末试一下' });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual((s.load('a').calls || []).map((x) => x.id), [old.id]);
  // 下一句：挑这一件，带全文和「没记到结果」
  const c = await ask('今天好累');
  assert.ok(c.includes('联想到的') && c.includes(old.id) && c.includes('没记到结果'));
  assert.deepEqual(s.load('a').calls, []); // 挑走了
  h.after('a', { reply: '嗯' });
  await new Promise((r) => setTimeout(r, 20));
  // 这轮「想起来的」里已经有它：不再备
  await ask('今天食堂又是红烧肉');
  h.after('a', { reply: '嗯' });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!(s.load('a').calls || []).some((x) => x.id === old.id));
});

test('应声不召回：ok、好、1 不递想起来的；两个字的名字照样递', async () => {
  const { s, h } = fresh();
  s.add('a', { kind: 'note', text: 'ok 那天她说好的团子' }, 'me');
  for (const t of ['ok', '好的。', '1', '嗯嗯']) assert.ok(!(await h.before('a', { text: t })).context.includes('想起来的'), t);
  assert.ok((await h.before('a', { text: '团子' })).context.includes('想起来的'));
});
