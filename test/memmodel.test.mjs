// 记忆小模型：设置、夜里出的补充（打标、同一件事、漏记、到日子、印象草稿）、递给夜里的 TA、收下的印象开场带上。
// 小模型和临时的 TA 一律是假的：按收到的指令开头回写好的 JSON，不调任何真的模型。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { openTalk } from '../lib/talk.mjs';
import { makeHooks } from '../lib/hooks.mjs';
import { makeNight } from '../lib/night.mjs';
import { makeMemModel, MM_PROMPTS, looseJson, cleanImpression } from '../lib/memmodel.mjs';
import { makeSlotGuard } from '../lib/helper.mjs';

const TZ = 'Asia/Shanghai';
const local = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// answer(活的名字, prompt) → 回的文字；asked 记下每次发给小模型的 prompt
function fresh({ answer = () => '[]' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-mm-'));
  dirs.push(dir);
  const clock = { t: local(2026, 11, 20, 2) };
  const now = () => clock.t;
  const s = openStore({ dir, tz: TZ, now, talk: openTalk({ dir, now }) });
  const asked = [], made = [];
  const which = (p) => Object.keys(MM_PROMPTS).find((k) => p.startsWith(MM_PROMPTS[k].slice(0, 300)) && p.includes(MM_PROMPTS[k].slice(-60)));
  const runnerOf = (opt) => { made.push(opt); return async ({ prompt }) => { const k = which(prompt); asked.push({ k, prompt }); return answer(k, prompt); }; };
  // 公开版：地址和 Key 走 makeSlotGuard。测试里网络检查放行（不真解析域名），Key 登记成只能发到 api.example.com
  const guard = makeSlotGuard({ net: { okSync() {}, async check() {} }, keyOrigins: 'SF_KEY=https://api.example.com' });
  const mm = makeMemModel({ store: s, tz: TZ, runnerOf, keyOf: (n) => (n === 'SF_KEY' ? 'k-123' : ''), guard });
  return { s, clock, mm, asked, made };
}
const ON = { on: true, url: 'https://api.example.com', model: 'flash', keyEnv: 'SF_KEY' };

test('设置：默认关；打开要先填 url 和 model；key 只存变量名；talk 只能是布尔；get 不带 url 和 keyEnv', () => {
  const { mm } = fresh();
  assert.deepEqual(mm.get('a'), { on: false, model: '', key: false, src: null, talk: false, impression: null });
  assert.throws(() => mm.set('a', { on: true }), (e) => e.code === 400);
  assert.throws(() => mm.set('a', { keyEnv: 'sk-real-key' }), (e) => e.code === 400);
  assert.throws(() => mm.set('a', { talk: 'yes' }), (e) => e.code === 400);
  const g = mm.set('a', ON);
  assert.deepEqual(g, { on: true, model: 'flash', key: true, src: 'own', talk: false, impression: null });
  assert.ok(!JSON.stringify(g).includes('example.com'));
});

test('没打开：不出补充、不调模型', async () => {
  const { s, mm, asked } = fresh();
  s.add('a', { kind: 'note', text: '她说想去海边' }, 'me');
  assert.equal((await mm.prepare('a')).text, '');
  assert.equal(asked.length, 0);
});

test('补充：打标存进记忆（不改正文、不算改动）；同一件事只报复核为 true 的；到日子的列出来；私人念想不给它看；关思考、带 key', async () => {
  const { s, clock, mm, asked, made } = fresh({
    answer: (k, p) => {
      if (k === 'tag') return '```json\n' + JSON.stringify([...p.matchAll(/"id":"([^"]+)"/g)].map(([, id]) => ({ id, emo: p.includes(`"id":"${id}","day":"2026-11-08"`) ? 3 : 1, follow: p.includes(`"id":"${id}"`) && /复查/.test(p.split(`"id":"${id}"`)[1].split('\n')[0]) ? { what: '复查结果', day: '2026-11-19' } : null, ppl: ['领导', 7, ''] }))) + '\n```';
      if (k === 'same') { const olds = [...p.split('旧的：')[1].matchAll(/"id":"([^"]+)"/g)].map((x) => x[1]); return JSON.stringify(olds.map((old, i) => ({ old, same: i === 0, why: '同一个领导当众批评' }))); }
      if (k === 'impression') return '{"blocks":{"她是谁":[{"text":"她上班","from":["nope"]}]}}';
      return '[]';
    },
  });
  mm.set('a', ON);
  clock.t = local(2026, 11, 8, 12);
  const old = s.add('a', { kind: 'note', text: '领导周会上当众批评她方案做得粗' }, 'me');
  clock.t = local(2026, 11, 10, 12);
  const doc = s.add('a', { kind: 'note', text: '她 11-19 去医院复查' }, 'me');
  const secret = s.add('a', { kind: 'wish', text: '偷偷想要她的照片', priv: true }, 'ai');
  clock.t = local(2026, 11, 20, 1);
  const nw = s.add('a', { kind: 'note', text: '她今天又被领导当众批评' }, 'me');
  clock.t = local(2026, 11, 20, 3);
  const r = await mm.prepare('a');
  // 打标
  const items = s.load('a').items;
  const tg = items.find((m) => m.id === nw.id).tag;
  assert.deepEqual([tg.emo, tg.ppl], [1, ['领导']]);
  assert.deepEqual(items.find((m) => m.id === doc.id).tag.follow, { what: '复查结果', day: '2026-11-19' });
  assert.equal(items.find((m) => m.id === nw.id).t2, undefined, '打标不算改动');
  assert.ok(!items.find((m) => m.id === secret.id).tag);
  // 补充里的几块
  assert.match(r.text, new RegExp(`\\[${nw.id}\\] 情绪 1；涉及 领导`));
  assert.match(r.text, new RegExp(`\\[${nw.id}\\]（2026-11-20）↔ \\[${old.id}\\]（2026-11-08）：同一个领导当众批评`));
  assert.match(r.text, new RegExp(`\\[${doc.id}\\] 复查结果（2026-11-19）：日子到了`));
  assert.ok(!r.text.includes('印象草稿'), '依据编号不存在的整句扔掉，扔光了就不带');
  // 私人念想一个字都没发出去；关思考、带 key
  assert.ok(asked.every((x) => !x.prompt.includes('偷偷想要')));
  assert.deepEqual([made[0].key, made[0].extra.enable_thinking, made[0].url], ['k-123', false, 'https://api.example.com/v1/chat/completions']);
  // talk 没开：不找漏记的
  assert.ok(!asked.some((x) => x.k === 'missed'));
  // 第二次：打过的、没改过的不再打
  asked.length = 0;
  await mm.prepare('a');
  assert.ok(!asked.some((x) => x.k === 'tag'));
});

test('补充：talk 开着才把原文给它找漏记的；一件出错别的照出；印象草稿带上一版', async () => {
  const { s, clock, mm, asked } = fresh({
    answer: (k) => {
      if (k === 'tag') throw Object.assign(new Error('接口回了 500'), { safe: true });
      if (k === 'missed') return JSON.stringify([{ quote: '下个月小林结婚，我当伴娘', when: '01:30', why: '朋友的大事' }, { quote: '' }]);
      if (k === 'impression') return null;
      return '[]';
    },
  });
  mm.set('a', { ...ON, talk: true });
  const m = s.add('a', { kind: 'note', text: '她跟小林吃火锅' }, 'me');
  clock.t = local(2026, 11, 20, 1, 30);
  s.talk.add('a', { role: 'me', text: '下个月小林结婚，我当伴娘' });
  const d = s.load('a'); d.impression = { blocks: { 她是谁: [{ text: '她有个闺蜜小林', from: [m.id] }] }, t: clock.t, by: 'night' }; s.save('a', d);
  clock.t = local(2026, 11, 20, 3);
  const r = await mm.prepare('a');
  assert.equal(r.stats.tag, 'fail');
  assert.match(r.text, /01:30 她说：「下个月小林结婚，我当伴娘」——朋友的大事/);
  assert.equal(r.text.match(/她说：/g).length, 1, '空的那条扔掉');
  assert.ok(asked.find((x) => x.k === 'impression').prompt.includes('上一版：'));
});

test('印象的检查：只认还在的、不是私人念想的编号；每块最多 5 句、每句 60 字；四块以外的不要', () => {
  const items = [{ id: 'a1', text: 'x' }, { id: 'g', text: 'x', gone: 1 }, { id: 'p', kind: 'wish', priv: true, text: 'x' }];
  const b = cleanImpression({ 她是谁: [{ text: '甲', from: ['a1', 'g'] }, { text: '乙', from: ['p'] }], 别的: [{ text: '丙', from: ['a1'] }],
    她在意的: Array.from({ length: 7 }, (_, i) => ({ text: '长'.repeat(80) + i, from: ['a1'] })) }, items);
  assert.deepEqual(b.她是谁, [{ text: '甲', from: ['a1'] }]);
  assert.equal(b.她在意的.length, 5);
  assert.equal([...b.她在意的[0].text].length, 60);
  assert.ok(!('别的' in b));
  assert.equal(cleanImpression({ 她是谁: [{ text: '乙', from: ['p'] }] }, items), null);
  assert.deepEqual(looseJson('好的：\n[{"a":1}] 以上'), [{ a: 1 }]);
});

test('夜里：小模型的补充递给临时的 TA；TA 收下的印象存起来（过检查），开场带上；小模型没开就不带', async () => {
  const { s, clock, mm } = fresh({ answer: (k) => (k === 'tag' ? '[]' : '[]') });
  const seen = [];
  let back = {};
  const runner = async (x) => { seen.push(x); return JSON.stringify(back); };
  const night = makeNight({ store: s, runner, tz: TZ, dir: '/nonexistent', memModel: mm });
  const m = s.add('a', { kind: 'note', text: '她养了一只猫叫团子' }, 'me');
  const p = s.add('a', { kind: 'wish', text: '私人的', priv: true }, 'ai');
  // 没开：整理照旧，不带补充
  await night.run('a', { tidy: true });
  assert.ok(!seen.at(-1).prompt.includes('小模型整理的补充'));
  // 开了：打标那块会有（假的回空数组，就没有）；用一条有下文的让补充不空
  mm.set('a', ON);
  const d = s.load('a'); d.items.find((x) => x.id === m.id).tag = { emo: 0, follow: { what: '团子复查', day: '2026-11-19' }, ppl: [], at: clock.t + 1 }; s.save('a', d);
  clock.t += 3600e3;
  s.add('a', { kind: 'note', text: '新的一条' }, 'me');
  back = { fix: [], merge: [], ask: [], note: '整理了', impression: { 她是谁: [{ text: '她养猫', from: [m.id, p.id] }], 我们之间: [{ text: '编的', from: [p.id] }] } };
  const out = await night.run('a', { tidy: true });
  assert.ok(seen.at(-1).prompt.includes('## 小模型整理的补充'));
  assert.ok(seen.at(-1).prompt.includes('团子复查（2026-11-19）'));
  assert.equal(out.tidy.impression, true);
  assert.deepEqual(s.load('a').impression.blocks.她是谁, [{ text: '她养猫', from: [m.id] }]);
  assert.deepEqual(s.load('a').impression.blocks.我们之间, []);
  const st = makeHooks({ store: s, tz: TZ }).start('a', {}).context;
  assert.match(st, /你对她的印象（夜里整理的，11-20；跟她说的对不上，以她为准）：\n【她是谁】她养猫/);
});

test('公开版：Key 没登记能发到这个地址就不让打开；真跑前再查一遍，查不过就不发', async () => {
  const { s: st, mm } = fresh();
  assert.throws(() => mm.set('a', { ...ON, url: 'https://evil.example.org' }), (e) => e.code === 400 && /HELPER_KEY_ORIGINS/.test(e.message));
  mm.set('a', ON);
  const s2 = makeSlotGuard({ net: { okSync() {}, async check() { throw Object.assign(new Error('地址指向局域网'), { safe: true }); } }, keyOrigins: 'SF_KEY=https://api.example.com' });
  const mm2 = makeMemModel({ store: st, tz: TZ, runnerOf: () => async () => assert.fail('查不过不该发'), keyOf: () => 'k', guard: s2 });
  assert.deepEqual(await mm2.prepare('a'), { text: '' });
});

test('v1.2.1：没单独设地址的 AI 用设置页那份（地址补 /chat/completions、Key 只给存 Key 时的地址）；页面没填不能打开；发之前地址要过 net 检查', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-mm-'));
  dirs.push(dir);
  const s = openStore({ dir, tz: TZ, now: () => local(2026, 11, 21, 3), talk: openTalk({ dir, now: () => 0 }) });
  let fm = {}, netOk = true;
  const made = [];
  const guard = makeSlotGuard({ net: { okSync() {}, async check() { if (!netOk) throw Object.assign(new Error('地址指向局域网'), { safe: true }); } } });
  const mm = makeMemModel({ store: s, tz: TZ, guard, svc: { read: () => ({ fm }) }, runnerOf: (o) => { made.push(o); return async () => '[]'; } });
  assert.throws(() => mm.set('a', { on: true }), (e) => e.code === 400);
  fm = { memo: { url: 'https://api.siliconflow.cn/v1', model: 'flash', key: 'pagek' } };
  mm.set('a', { on: true });
  assert.equal(mm.get('a').src, 'page');
  s.add('a', { text: '她今天去体检了' }, 'me');
  await mm.prepare('a');
  assert.equal(made[0].url, 'https://api.siliconflow.cn/v1/chat/completions');
  assert.equal(made[0].key, 'pagek');
  fm = { memo: { url: 'https://other.example.com/v1', model: 'flash', key: 'pagek', keyAt: 'https://api.siliconflow.cn' } };
  await mm.prepare('a');
  assert.equal(made[1].key, '', 'Key 是给硅基的，地址换了就不带');
  netOk = false;
  assert.deepEqual(await mm.prepare('a'), { text: '' });
  assert.equal(made.length, 2, '地址过不了检查就不发');
});
