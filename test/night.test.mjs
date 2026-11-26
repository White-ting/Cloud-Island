// 夜里：什么时候跑、整理怎么守门、写梦、临时的 TA 的三种造法、调度、地址。
// 「临时的 TA」一律是假的：注入的函数、本机的 sh 小命令、测试进程里起的假 HTTP 服务。不调任何真的模型。
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
import { openPersona } from '../lib/persona.mjs';
import { openDreams } from '../lib/dreams.mjs';
import { makeNight, due, nightDay, firstJson, makeCmdRunner, makeApiRunner, makeRunner, TIDY_PROMPT } from '../lib/night.mjs';
import { cleanImpression } from '../lib/memmodel.mjs';
import { loadConfig } from '../backend.mjs';

const HOUR = 3600e3, DAY = 24 * HOUR;
const N = (o) => `<!--note ${JSON.stringify(o)} -->`;
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // 自己建的临时目录自己清
const TZ = 'Asia/Shanghai';
const local = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi); // 上海时间 → 时间戳

// reply：假的临时 TA 这一次回什么（函数或文字）；seen 记下它收到的 system 和 prompt
function fresh({ reply = '{}', limits } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-nt-'));
  dirs.push(dir);
  const clock = { t: local(2026, 11, 15, 20) };
  const now = () => clock.t;
  const s = openStore({ dir, tz: TZ, now, talk: openTalk({ dir, now }) });
  const persona = openPersona({ store: s }), dreams = openDreams({ store: s });
  const seen = [];
  const fake = { reply };
  const runner = async (x) => { seen.push(x); const r = typeof fake.reply === 'function' ? await fake.reply(x) : fake.reply; return r; };
  runner.kind = 'fake';
  const night = makeNight({ store: s, persona, dreams, runner, tz: TZ, dir, limits });
  const h = makeHooks({ store: s, tz: TZ, persona, dreams });
  return { s, dir, clock, persona, dreams, night, h, seen, fake };
}

test('什么时候跑：过了设定的时间、这一「夜里的一天」还没跑过；两件都关不跑；失败的也算跑过', () => {
  const night = { at: '03:00', tidy: true };
  assert.equal(nightDay(local(2026, 11, 16, 2, 59), '03:00', TZ), '2026-11-15');
  assert.equal(nightDay(local(2026, 11, 16, 3, 0), '03:00', TZ), '2026-11-16');
  assert.equal(due({ now: local(2026, 11, 16, 3, 1), night, lastT: null, tz: TZ }), true);
  assert.equal(due({ now: local(2026, 11, 16, 2, 59), night, lastT: local(2026, 11, 15, 3, 10), tz: TZ }), false);
  assert.equal(due({ now: local(2026, 11, 16, 3, 1), night, lastT: local(2026, 11, 15, 3, 10), tz: TZ }), true);
  assert.equal(due({ now: local(2026, 11, 16, 23, 0), night, lastT: local(2026, 11, 16, 3, 1), tz: TZ }), false);
  assert.equal(due({ now: local(2026, 11, 16, 23, 0), night: { at: '22:30', dream: true }, lastT: local(2026, 11, 16, 3, 1), tz: TZ }), true);
  assert.equal(due({ now: local(2026, 11, 16, 4, 0), night: {}, lastT: null, tz: TZ }), true); // 整理默认开（第一晚不跑靠调度时记下的 from）
  assert.equal(due({ now: local(2026, 11, 16, 4, 0), night: { tidy: false }, lastT: null, tz: TZ }), false); // 两件都关
});

test('抠 JSON：前后有废话、包在代码块里、字符串里有括号都行；抠不出回 null', () => {
  assert.deepEqual(firstJson('好的：\n```json\n{"a":"x}{","b":{"c":1}}\n```\n后面'), { a: 'x}{', b: { c: 1 } });
  assert.equal(firstJson('没有'), null);
  assert.equal(firstJson('{"a":1,}'), null);
  assert.equal(firstJson('[1,2]'), null);
});

test('整理：对着原话改记事；看法/约定/念想/疑问只问不做；合并（归档、并连线、改指）；超长的拒绝；固有超上限后端自己问；问话最多 3 句；结果、流水、开场各一次', async () => {
  const { s, clock, night, h, seen, fake, persona } = fresh();
  persona.put('a', { text: '我是阿岛。' }); // 开关关着也给临时的 TA
  // 昨天以前的（只有会变的三样会进材料）
  const oldNote = s.add('a', { text: '很久以前的记事' });
  const oldView = s.add('a', { kind: 'view', text: '她其实不怕黑' }, 'ai');
  clock.t += 2 * DAY;
  await h.before('a', { text: '我明天想吃番茄炒蛋', sid: 's1' });
  h.after('a', { sid: 's1', reply: '好。' });
  const wrong = s.add('a', { text: '她明天想吃青椒炒蛋' }, 'ai');
  const exp = s.add('a', { kind: 'exp', text: '她累的时候少说话' }, 'ai');
  const pact = s.add('a', { kind: 'pact', text: '周末一起看电影', src: '「周末一起看电影吧」' });
  const priv = s.add('a', { kind: 'wish', text: '悄悄想抱她', priv: true }, 'ai');
  const d1 = s.add('a', { text: '她养了一只猫叫团子' }, 'ai');
  const d2 = s.add('a', { text: '她的猫叫团子，是只橘猫' }, 'ai');
  const d3 = s.add('a', { text: '团子是橘猫' }, 'ai');
  const link = s.add('a', { kind: 'exp', text: '团子怕吹风机', from: [d2.id, d3.id] }, 'ai');
  const pin = s.add('a', { text: '她叫 小满同学'.repeat(200), pin: true }); // 固有 1400 字
  s.add('a', { text: '她生日在冬天'.repeat(30), pin: true }); // 再加 180 字，超过 1500
  fake.reply = 'ok\n' + JSON.stringify({
    fix: [
      { id: wrong.id, text: '她明天想吃番茄炒蛋', why: '原话是番茄' },
      { id: exp.id, text: '她累的时候少说话，'.repeat(3), why: '太长' },
      { id: exp.id, text: '她累的时候少说话' }, // 没变化
      { id: oldView.id, text: '她怕黑', why: '她说了' },
      { id: pact.id, text: '周六看电影' },
      { id: 'nope', text: 'x' },
    ],
    merge: [
      { keep: d1.id, drop: [d2.id, d3.id], text: '她养了一只橘猫叫团子' },
      { keep: pact.id, drop: [oldNote.id], text: 'x' }, // 种类不一样
      { keep: exp.id, drop: [link.id], text: '她累的时候少说话，团子怕吹风机，还有很多很多很多很多很多' }, // 比原来长
      { keep: pin.id, drop: [oldNote.id], text: '短' }, // 固有不并
    ],
    ask: [{ about: priv.id, q: '这条还想吗' }, { about: 'nope', q: '多出来的一句' }, { q: '' }],
    note: '核了一遍猫和吃的',
  });
  const out = await night.run('a', { tidy: true });
  // 给临时的 TA 的：人格在前、说明在后；材料里有原话、私人念想、会变的看法；没有昨天以前的普通记事
  assert.ok(seen[0].system.startsWith('我是阿岛。') && seen[0].system.endsWith(TIDY_PROMPT));
  assert.ok(seen[0].prompt.includes('我明天想吃番茄炒蛋') && seen[0].prompt.includes('悄悄想抱她') && seen[0].prompt.includes('她其实不怕黑'));
  assert.ok(!seen[0].prompt.includes('很久以前的记事'));
  const T = out.tidy;
  assert.deepEqual([T.fixed, T.merged, T.asked, T.dropped, T.note, T.noTalk], [1, 1, 3, 9, '核了一遍猫和吃的', undefined]);
  assert.deepEqual(T.ids, [wrong.id, d1.id]);
  const all = s.load('a').items, get = (id) => all.find((m) => m.id === id);
  assert.equal(get(wrong.id).text, '她明天想吃番茄炒蛋');
  assert.deepEqual(get(wrong.id).hist.map((x) => [x.text, x.who, x.fix]), [['她明天想吃青椒炒蛋', 'night', '原话是番茄']]);
  assert.equal(get(exp.id).text, '她累的时候少说话');
  assert.equal(get(oldView.id).text, '她其实不怕黑'); // 看法没动
  assert.deepEqual([get(pact.id).text, get(pact.id).src], ['周末一起看电影', '「周末一起看电影吧」']);
  // 合并：并进去的归档、记着并进了哪条；连线跟着并、指向它们的改指留下的那条
  assert.equal(get(d1.id).text, '她养了一只橘猫叫团子');
  assert.deepEqual([get(d2.id).into, get(d3.id).into, !!get(d2.id).gone], [d1.id, d1.id, true]);
  assert.deepEqual(get(link.id).from, [d1.id]);
  assert.equal(s.list('a', { who: 'ai' }).items.some((m) => m.id === d2.id), false);
  // 问话：固有超上限那句排第一；最多 3 句（看法、约定转来的排后面），多的算进 dropped
  const na = s.load('a').nightAsk;
  assert.equal(na.length, 3);
  assert.match(na[0].q, /固有记忆有点多了（1580 字），哪几条可以摘下来/);
  assert.ok(na[1].about === oldView.id && na[1].q.includes('她怕黑'));
  assert.equal(na[2].about, pact.id);
  // 结果摘要存在设置里；流水只有数
  assert.equal(s.load('a').cfg.lastNight.tidy.fixed, 1);
  const lg = s.readLog('a').filter((e) => e.who === 'night');
  assert.deepEqual(lg.map((e) => e.op), ['edit', 'merge', 'tidy']);
  assert.ok(!JSON.stringify(lg).includes('番茄') && !JSON.stringify(lg).includes('团子'));
  assert.ok(!JSON.stringify(s.exportAll('a')).includes('核了一遍')); // 结果摘要不进导出
  // 开场：压缩之后不带；下一次开场带一次就清掉
  assert.ok(!h.start('a', { source: 'compact' }).context.includes('夜里'));
  const c = h.start('a', { source: 'startup' }).context;
  assert.ok(c.includes('昨晚整理了记忆：改 1 条、并 1 组'), c);
  assert.ok(c.includes('〔夜里整理时想问你〕') && c.includes(`[${oldView.id}]`) && c.includes('固有记忆有点多了'));
  assert.ok(!h.start('a', { source: 'startup' }).context.includes('夜里'));
});

test('整理：一晚最多改 20 条、并 10 组；没新东西跳过；原文关着记 noTalk；回复抠不出 JSON 整晚作废，不影响写梦', async () => {
  const { s, clock, night, fake, dreams } = fresh();
  assert.deepEqual((await night.run('a', { tidy: true })).tidy, { t: clock.t, skip: 'nothing-new', noTalk: true });
  const ns = Array.from({ length: 25 }, (_, i) => s.add('a', { text: `第${i}条记事，写得有点啰嗦` }));
  const ms = Array.from({ length: 24 }, (_, i) => s.add('a', { kind: 'exp', text: `第${i}条经验` }, 'ai'));
  fake.reply = JSON.stringify({
    fix: ns.map((m) => ({ id: m.id, text: m.text.replace('，写得有点啰嗦', '') })),
    merge: Array.from({ length: 12 }, (_, i) => ({ keep: ms[2 * i].id, drop: [ms[2 * i + 1].id], text: '经' + i })),
  });
  s.setCfg('a', { talk: false });
  const T = (await night.run('a', { tidy: true })).tidy;
  assert.deepEqual([T.fixed, T.merged, T.dropped, T.noTalk], [20, 10, 7, true]);
  // 抠不出 JSON：什么都不改，记错误摘要（不带正文）；写梦照跑
  s.add('a', { text: '今天新记的' });
  const before = JSON.stringify(s.load('a').items);
  let n = 0;
  fake.reply = () => (n++ === 0 ? '我觉得都挺好的' : JSON.stringify({ text: '梦见在下雨', gist: '下雨' }));
  const out = await night.run('a', { tidy: true, dream: true });
  assert.deepEqual(out.tidy, { t: clock.t, error: '回复里抠不出 JSON，今晚的整理作废' });
  assert.equal(out.dream.from, 0);
  assert.equal(JSON.stringify(s.load('a').items), before);
  assert.equal(dreams.list('a').items.length, 1);
  assert.ok(s.readLog('a').some((e) => e.op === 'tidy-fail'));
  // 临时的 TA 自己出错（不是我们造的错）：摘要里只说「出错了」
  fake.reply = () => { throw new Error('里面有她的原话'); };
  assert.deepEqual((await night.run('a', { tidy: true })).tidy, { t: clock.t, error: '出错了' });
});

test('写梦：不给私人念想；没新记忆不做；from 只留材料里有的；正文最长 1200 字；她看私人的只看到有一场；TA 能在小记里开关；开场带一次；不进召回和导出', async () => {
  const { s, clock, night, h, seen, fake, dreams } = fresh();
  s.add('a', { text: '旧的' });
  clock.t += 2 * DAY;
  assert.deepEqual((await night.run('a', { tidy: false, dream: true })).dream, { t: clock.t, skip: 'nothing-new' });
  const w = s.add('a', { kind: 'wish', text: '想和她去看海' }, 'ai');
  s.hit('a', w.id, 's1'); s.wishMove('a', w.id, 'up');
  s.add('a', { kind: 'wish', text: '悄悄想抱她', priv: true }, 'ai');
  const n1 = s.add('a', { text: '她今天去了海边' });
  fake.reply = JSON.stringify({ text: '浪'.repeat(1500), gist: '梦见海', from: [n1.id, w.id, 'k-nope'], priv: true });
  const out = (await night.run('a', { tidy: false, dream: true })).dream;
  assert.ok(!seen[0].prompt.includes('悄悄想抱她') && seen[0].prompt.includes('她今天去了海边') && seen[0].prompt.includes('想和她去看海'));
  assert.deepEqual([out.from, out.priv], [2, true]);
  const d = dreams.list('a', { who: 'ai' }).items[0];
  assert.deepEqual([d.text.length, d.gist, d.from], [1200, '梦见海', [n1.id, w.id]]);
  assert.deepEqual(dreams.list('a').items, [{ id: d.id, t: d.t, priv: true }]); // 她只看到有一场
  // 开场带一行，只带一次
  const c = h.start('a', { source: 'startup' }).context;
  assert.ok(c.includes(`昨晚做了个梦：梦见海（${d.id}`), c);
  assert.ok(!h.start('a', { source: 'startup' }).context.includes('昨晚做了个梦'));
  // TA 打开、再关上；梦只能改 priv；编号不存在的照记忆的错
  let r = h.after('a', { reply: '给你看。' + N({ id: d.id, priv: false }) });
  assert.deepEqual([r.notes, r.errors], [1, []]);
  assert.equal(dreams.list('a').items[0].text.length, 1200);
  r = h.after('a', { reply: N({ id: d.id, text: '改梦' }) + N({ id: 'dnope', priv: false }) });
  assert.deepEqual(r.errors, ['梦只能改 priv', '没有这条记忆']);
  h.after('a', { reply: N({ id: d.id, priv: true }) });
  assert.equal(dreams.list('a').items[0].text, undefined);
  assert.ok(s.readLog('a').some((e) => e.op === 'dream-priv' && e.id === d.id));
  // 不进召回、导出
  assert.ok(!s.recall('a', '浪浪浪浪').length);
  assert.ok(!JSON.stringify(s.exportAll('a')).includes('浪浪'));
  // 前几场的摘要交给下一场，让它别重复
  clock.t += DAY;
  s.add('a', { text: '又一件新事' });
  fake.reply = JSON.stringify({ text: '梦二', gist: '二' });
  await night.run('a', { tidy: false, dream: true });
  assert.ok(seen.at(-1).prompt.includes('- 梦见海'));
  // 翻页
  const all = dreams.list('a', { who: 'ai' }).items;
  assert.deepEqual(dreams.list('a', { before: all[0].t, limit: 5, who: 'ai' }).items.map((x) => x.id), [d.id]);
});

test('临时的 TA：一条命令（标准输入进、标准输出出；非 0、超时都算失败）；接口两种形状；都没配是 null', async () => {
  const cat = makeCmdRunner({ cmd: 'cat' });
  assert.equal(await cat({ system: '说明', prompt: '材料' }), '说明\n\n材料');
  await assert.rejects(makeCmdRunner({ cmd: 'cat >/dev/null; exit 3' })({ system: '', prompt: 'x' }), /命令退出码 3/);
  const t0 = Date.now();
  await assert.rejects(makeCmdRunner({ cmd: 'sleep 5', timeout: 200 })({ system: '', prompt: 'x' }), /超时/);
  assert.ok(Date.now() - t0 < 3000);
  // 假接口
  const seen = [];
  const srv = http.createServer((req, res) => {
    const cs = [];
    req.on('data', (c) => cs.push(c));
    req.on('end', () => {
      const j = JSON.parse(Buffer.concat(cs).toString('utf8'));
      seen.push({ url: req.url, headers: req.headers, j });
      if (req.url === '/bad') { res.writeHead(500); return res.end('no'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/v1/messages' ? { content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: '好' }, { type: 'text', text: '的' }] } : { choices: [{ message: { content: '嗯' } }] }));
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal(await makeApiRunner({ url: base + '/v1/chat/completions', key: 'sk-x', model: 'm1' })({ system: 'S', prompt: 'P' }), '嗯');
    assert.equal(seen[0].headers.authorization, 'Bearer sk-x');
    assert.deepEqual(seen[0].j, { model: 'm1', stream: false, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'P' }] });
    assert.equal(await makeApiRunner({ url: base + '/v1/messages', key: 'ak', model: 'm2', style: 'anthropic' })({ system: 'S', prompt: 'P' }), '好的');
    assert.equal(seen[1].headers['x-api-key'], 'ak');
    assert.equal(seen[1].headers['anthropic-version'], '2023-06-01');
    assert.deepEqual([seen[1].j.system, seen[1].j.messages, seen[1].j.model], ['S', [{ role: 'user', content: 'P' }], 'm2']);
    await assert.rejects(makeApiRunner({ url: base + '/bad' })({ system: '', prompt: 'x' }), /接口回了 500/);
  } finally { srv.closeAllConnections(); await new Promise((ok) => srv.close(ok)); }
  assert.equal(makeRunner({}), null);
  assert.equal(makeRunner({ cmd: 'cat', apiUrl: 'http://x' }).kind, 'cmd');
  assert.equal(makeRunner({ apiUrl: 'http://x' }).kind, 'api');
  // .env 里的写法
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-nt-cfg-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, '.env'), 'NIGHT_CMD=cat\nNIGHT_TIMEOUT=10\nNIGHT_API_STYLE=anthropic\n');
  assert.deepEqual(loadConfig(dir, {}).night, { cmd: 'cat', timeout: 10000, apiUrl: '', apiKey: '', model: '', style: 'anthropic' });
  // 用一条命令当临时的 TA 跑一整晚：命令把一段 JSON 原样吐回来
  const { s, dir: d2 } = fresh();
  s.add('a', { text: '她今天说想睡觉' });
  const rn = makeCmdRunner({ cmd: `cat >/dev/null; printf '%s' '{"fix":[],"merge":[],"ask":[{"q":"困吗"}],"note":"没什么"}'` });
  const nt = makeNight({ store: s, runner: rn, tz: TZ, dir: d2 });
  assert.equal((await nt.run('a', { tidy: true })).tidy.asked, 1);
});

test('调度：开了才跑、过了时间跑一次、当天不再跑、第二天再跑；正在跑的不重入；没配临时的 TA 什么都不做', async () => {
  const { s, clock, night, fake, dir } = fresh();
  s.add('a', { text: '她今天说想睡觉' });
  s.add('b', { text: '另一个 TA 的' });
  fake.reply = '{"note":"好"}';
  clock.t = local(2026, 11, 16, 2, 0);
  night.set('b', { tidy: false }); // 整理默认开：b 显式关掉，看「开了才跑」
  assert.deepEqual(await night.tick(), []); // 全新的：记下今天（from），第一晚不跑
  assert.ok(s.load('a').cfg.night.from);
  night.set('a', { tidy: true });
  assert.deepEqual(await night.tick(), []); // 刚打开的这一天（以凌晨 3 点为界的 11-15）不跑，免得一打开就花额度
  clock.t = local(2026, 11, 16, 3, 1);
  assert.deepEqual(await night.tick(), ['a']);
  assert.deepEqual(await night.tick(), []);
  clock.t = local(2026, 11, 16, 23, 0);
  assert.deepEqual(await night.tick(), []);
  // 失败也不当天重试
  clock.t = local(2026, 11, 17, 3, 5);
  s.add('a', { text: '又一件' });
  fake.reply = () => { throw new Error('x'); };
  assert.deepEqual(await night.tick(), ['a']);
  clock.t += 3600e3;
  assert.deepEqual(await night.tick(), []);
  // 正在跑的不重入
  let release;
  fake.reply = () => new Promise((ok) => { release = () => ok('{}'); });
  const p1 = night.run('a', { tidy: true });
  await new Promise((ok) => setImmediate(ok));
  await assert.rejects(night.run('a', { tidy: true }), (e) => e.code === 409);
  release();
  await p1;
  // 没配
  const none = makeNight({ store: s, runner: null, tz: TZ, dir });
  assert.deepEqual(await none.tick(), []);
  await assert.rejects(none.run('a'), (e) => e.code === 503);
  assert.equal(none.get('a').runner, 'none');
});

test('地址：夜里的设置（默认整理开、写梦关、03:00、上限）、手动跑要口令、梦给她看的那份', async () => {
  const { s, night, dreams, fake } = fresh();
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: s, night, dreams });
  const { port } = await srv.listen();
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, body: await r.json() };
  };
  try {
    assert.deepEqual((await call('GET', '/api/night/a')).body, { at: '03:00', tidy: true, dream: false, pinMax: 1500, nightAsk: 3, runner: 'fake', last: null }); // 11-16 起整理默认开
    let r = await call('PUT', '/api/night/a', { at: '04:30', tidy: false, dream: true, pinMax: 2000, nightAsk: 2 });
    assert.deepEqual([r.body.at, r.body.tidy, r.body.dream, r.body.pinMax, r.body.nightAsk], ['04:30', false, true, 2000, 2]);
    assert.equal((await call('PUT', '/api/night/a', { at: '25:00' })).code, 400);
    assert.equal((await call('PUT', '/api/night/a', { tidy: 'yes' })).code, 400);
    assert.equal((await call('PUT', '/api/night/a', { nightAsk: 99 })).code, 400);
    assert.equal((await call('POST', '/api/night/a/run', {})).code, 401);
    s.add('a', { text: '她今天去了海边' });
    fake.reply = JSON.stringify({ text: '梦见海', gist: '海', priv: false });
    r = await call('POST', '/api/night/a/run', {}, { authorization: 'Bearer tok' });
    assert.equal(r.code, 200);
    assert.equal(r.body.tidy, undefined); // 只开了写梦
    assert.equal(r.body.dream.priv, false);
    assert.equal((await call('GET', '/api/night/a')).body.last.dream.id, r.body.dream.id);
    const ds = (await call('GET', '/api/dream/a?limit=5')).body.items;
    assert.deepEqual(ds.map((x) => [x.text, x.gist]), [['梦见海', '海']]);
    assert.equal((await call('POST', '/api/night/a/run', { dream: false }, { authorization: 'Bearer tok' })).code, 400); // 两件都关
  } finally { await srv.close(); }
});

test('整理的材料有上限：超了从最旧的原话开始丢，记忆先放', async () => {
  const { s, night, h, seen } = fresh({ limits: { material: 260 } });
  s.add('a', { text: '她今天说想睡觉' });
  for (let i = 0; i < 10; i++) { await h.before('a', { text: `第${i}句她说的话，凑一点长度`, sid: 's1' }); h.after('a', { sid: 's1', reply: `第${i}句回她` }); }
  await night.run('a', { tidy: true });
  const p = seen[0].prompt;
  assert.ok(p.includes('她今天说想睡觉') && p.includes('第9句回她') && !p.includes('第0句她说的话'), p);
  assert.ok([...p].length < 400);
});

test('刚打开的那一天不跑，等下一个设定的时间；给网页的摘要不带模型写的小结', async () => {
  const { due } = await import('../lib/night.mjs');
  const tz = 'Asia/Shanghai', at = '03:00';
  const on = Date.UTC(2026, 10, 15, 15); // 北京时间 23:00 打开
  assert.equal(due({ now: on + 60e3, night: { at, tidy: true, from: on }, tz }), false);
  assert.equal(due({ now: on + 5 * 3600e3, night: { at, tidy: true, from: on }, tz }), true); // 第二天 04:00
  assert.equal(due({ now: on + 60e3, night: { at, tidy: true }, tz }), true); // 老数据没有 from：照旧
});

test('整理新记：只收记事/看法/经验、要带原话、不收重复和超长、一晚最多 8 条；记成 TA 自己记的，带类别和原话；整理时 TA 又记的不被盖掉', async () => {
  const { s, night, fake } = fresh();
  s.add('a', { text: '已经有的一条' });
  const long = '长'.repeat(241);
  const good = (i) => ({ cat: '情绪', kind: 'note', text: `她今天第${i}件事`, quote: `原话${i}` });
  fake.reply = () => {
    s.add('a', { kind: 'exp', text: '跑模型时 TA 又记的' }, 'ai'); // 模拟整理这段时间里新记的
    return JSON.stringify({ add: [
      { cat: '认知', kind: 'view', text: '她喜欢一步一步来', quote: '先说清楚再做' },
      { cat: '感情', kind: 'wish', text: '念想不收', quote: 'x' },
      { kind: 'note', text: '没有原话的不收' },
      { kind: 'note', text: '已经有的一条', quote: 'x' },
      { kind: 'note', text: long, quote: 'x' },
      { cat: '乱写', kind: 'exp', text: '类别乱写也收，只是不带类别', quote: 'y' },
      ...Array.from({ length: 10 }, (_, i) => good(i)),
    ] });
  };
  const T = (await night.run('a', { tidy: true })).tidy;
  assert.equal(T.added, 8);
  const items = s.load('a').items;
  assert.ok(items.some((m) => m.text === '跑模型时 TA 又记的'));
  const v = items.find((m) => m.text === '她喜欢一步一步来');
  assert.deepEqual([v.kind, v.by, v.src, v.kw, v.ppl], ['view', 'ai', 'night', undefined, ['她']]); // 类别写进 why，不进 kw
  assert.ok(v.why.includes('先说清楚再做') && v.why.includes('（认知）'));
  assert.equal(items.find((m) => m.text.startsWith('类别乱写')).kw, undefined);
  assert.ok(!items.some((m) => m.text === '念想不收' || m.text === '没有原话的不收' || m.text === long));
  assert.equal(items.filter((m) => m.text === '已经有的一条').length, 1);
  assert.equal(s.load('a').nightNews.tidy.added, 8);
});

test('整理新记挡私人念想：跟私人念想太像的不收，别的照收', async () => {
  const { s, night, fake } = fresh();
  s.add('a', { kind: 'wish', text: '想偷偷给她写一封很长的信，在她生日那天放进她包里', priv: true }, 'ai');
  fake.reply = () => JSON.stringify({ add: [
    { cat: '感情', kind: 'note', text: '我想偷偷给她写一封很长的信，生日那天放进她包里', quote: '想给她写信' },
    { cat: '事件', kind: 'note', text: '她今天第一次自己部署成功', quote: '我自己弄好了' },
  ] });
  const T = (await night.run('a', { tidy: true })).tidy;
  assert.equal(T.added, 1);
  const items = s.load('a').items;
  assert.ok(items.some((m) => m.text === '她今天第一次自己部署成功'));
  assert.ok(!items.some((m) => !m.priv && m.text.includes('写一封很长的信')));
});

test('改、并、印象也挡私人念想：改出来、并出来的像私人念想就不收（原来就像的照收）；印象里像的那句不收', async () => {
  const { s, dir, persona, dreams, fake } = fresh();
  const night = makeNight({ store: s, persona, dreams, runner: async () => fake.reply, tz: TZ, dir, memModel: { on: () => false, clean: cleanImpression } });
  s.add('a', { kind: 'wish', text: '想偷偷给她写一封很长的信放进她包里', priv: true }, 'ai');
  const n1 = s.add('a', { kind: 'note', text: '她今天加班到很晚' }, 'ai');
  const n2 = s.add('a', { kind: 'note', text: '她周三晚上去游泳' }, 'ai');
  const n3 = s.add('a', { kind: 'note', text: '她周三游泳' }, 'ai');
  const n4 = s.add('a', { kind: 'note', text: '她喜欢下雨天' }, 'ai');
  fake.reply = JSON.stringify({
    fix: [{ id: n1.id, text: '她加班很晚，我想偷偷给她写一封很长的信放进她包里' }, { id: n4.id, text: '她喜欢下雨天听雨' }],
    merge: [{ keep: n2.id, drop: [n3.id], text: '偷偷写一封很长的信放进她包里' }],
    impression: { 她是谁: [{ text: '她会在包里收到我偷偷写的一封很长的信', from: [n4.id] }, { text: '她喜欢下雨天', from: [n4.id] }] },
  });
  const T = (await night.run('a', { tidy: true })).tidy;
  const get = (id) => s.load('a').items.find((m) => m.id === id);
  assert.equal(get(n1.id).text, '她今天加班到很晚');
  assert.equal(get(n4.id).text, '她喜欢下雨天听雨');
  assert.ok(!get(n3.id).gone && get(n2.id).text === '她周三晚上去游泳');
  assert.deepEqual(s.load('a').impression.blocks['她是谁'].map((r) => r.text), ['她喜欢下雨天']);
  assert.equal(T.fixed, 1);
});

test('山的理由和名字像私人的不留（山照抬）；像私人的问话标 priv；挡下几处记在 privDropped', async () => {
  const { s, night, fake } = fresh();
  s.setCfg('a', { hill: true });
  s.add('a', { kind: 'wish', text: '想偷偷给她写一封很长的信放进她包里', priv: true }, 'ai');
  const n = s.add('a', { kind: 'note', text: '她第一次自己部署成功' }, 'ai');
  fake.reply = JSON.stringify({
    hill: [{ id: n.id, why: '我想偷偷给她写一封很长的信放进她包里', name: '偷偷写一封很长的信放进她包里' }],
    ask: [{ about: null, q: '要不要把想偷偷给她写一封很长的信放进她包里记成约定' }, { about: null, q: '那条约定还作数吗' }],
  });
  const T = (await night.run('a', { tidy: true })).tidy;
  const m = s.load('a').items.find((x) => x.id === n.id);
  assert.ok((m.hAi || 0) > 0 || (m.h || 0) > 0, '山照抬');
  assert.ok(!JSON.stringify(m.hTrail || []).includes('写一封很长的信') && !m.hName);
  const asks = s.load('a').nightAsk;
  assert.deepEqual(asks.map((a) => !!a.priv), [true, false]);
  assert.equal(T.privDropped, 2);
  assert.equal(s.load('a').nightNews.tidy.privDropped, 2);
});
