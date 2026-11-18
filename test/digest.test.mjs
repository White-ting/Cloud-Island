// 第⑨批：待整理、日记、散场记（第五个时机）、旁听的小模型、夜里先写日记、范例脚本。
// 「临时的 TA」「旁听的小模型」一律是假的：注入的函数、测试进程里起的假 HTTP 服务。不调任何真的模型，不跑真的 claude。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/store.mjs';
import { createServer } from '../lib/server.mjs';
import { makeHooks } from '../lib/hooks.mjs';
import { openTalk } from '../lib/talk.mjs';
import { openPersona } from '../lib/persona.mjs';
import { openDreams } from '../lib/dreams.mjs';
import { openDigest } from '../lib/digest.mjs';
import { openDiary } from '../lib/diary.mjs';
import { openPat } from '../lib/pat.mjs';
import { makeHelper } from '../lib/helper.mjs';
import { makeNet } from '../lib/net.mjs';
import { makeMcp } from '../lib/mcp.mjs';
import { makeNight, DIARY_PROMPT, TIDY_PROMPT, DREAM_PROMPT } from '../lib/night.mjs';

const HOUR = 3600e3, DAY = 24 * HOUR;
const N = (o) => `<!--note ${JSON.stringify(o)} -->`;
const TZ = 'Asia/Shanghai';
const local = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi); // 上海时间 → 时间戳
const SECRET = 'HELPER-s3cret-key-0a9b8c7d'; // 假 key：跑完遍历数据和日志，不许出现
const here = path.dirname(fileURLToPath(import.meta.url));
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // 自己建的临时目录自己清

function fresh({ reply = '{}', keyOrigins = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-dg-'));
  dirs.push(dir);
  const clock = { t: local(2026, 11, 15, 20) };
  const now = () => clock.t;
  const s = openStore({ dir, tz: TZ, now, talk: openTalk({ dir, now }) });
  const persona = openPersona({ store: s }), dreams = openDreams({ store: s });
  const digest = openDigest({ store: s }), diary = openDiary({ store: s }), pat = openPat({ store: s });
  const logs = [];
  const log = (...a) => logs.push(a.join(' '));
  const helper = makeHelper({ store: s, digest, keyOf: (n) => (n === 'HELPER_KEY' ? SECRET : ''), log, timeout: 2000, net: makeNet({ allow: 'http://127.0.0.1' }), keyOrigins });
  const h = makeHooks({ store: s, tz: TZ, persona, dreams, digest, diary, pat, helper });
  const seen = [], fake = { reply };
  const runner = async (x) => { seen.push(x); return typeof fake.reply === 'function' ? fake.reply(x) : fake.reply; };
  runner.kind = 'fake';
  const night = makeNight({ store: s, persona, dreams, digest, diary, runner, tz: TZ, dir, log });
  return { dir, clock, s, digest, diary, pat, helper, h, night, seen, fake, logs };
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('待整理：小记存下（day 按时区、最长 1500 字、记谁写的）；不是记忆（列表、搜索、召回都没有，也不混进导出的记忆 items）；没注入报错；done 以后留 30 天', () => {
  const g = fresh();
  g.clock.t = local(2026, 11, 16, 0, 30); // 上海 0:30 已经是 11-16（UTC 还是 11-15）
  let r = g.h.after('a', { sid: 's1', reply: '嗯。' + N({ digest: '下午她说周三要去体检，有点怕抽血。' }) + N({ digest: '长'.repeat(2000) }) + N({ digest: '' }) });
  assert.deepEqual([r.notes, r.errors], [2, ['待整理要写成一段话']]);
  const xs = g.digest.pending('a');
  assert.deepEqual(xs.map((x) => [x.day, x.by, x.sid, [...x.text].length]), [['2026-11-16', 'ai', 's1', 17], ['2026-11-16', 'ai', 's1', 1500]]);
  assert.equal(fs.statSync(path.join(g.dir, 'a', 'digest.json')).mode % 0o1000, 0o600);
  // 不是记忆
  assert.equal(g.s.list('a', { who: 'ai' }).items.length, 0);
  assert.equal(g.s.list('a', { q: '体检' }).items.length, 0);
  assert.equal(g.s.recall('a', '周三去体检抽血').length, 0);
  assert.ok(!JSON.stringify(g.s.exportAll('a')).includes('体检'));
  assert.ok(!g.h.start('a', { source: 'startup' }).context.includes('体检')); // 不带给聊天中的 TA
  // 流水只记一笔，不带内容
  assert.ok(g.s.readLog('a').some((e) => e.op === 'digest' && e.who === 'ai' && !JSON.stringify(e).includes('体检')));
  // 没注入：照人格那样报错
  const bare = makeHooks({ store: g.s, tz: TZ });
  assert.deepEqual(bare.after('b', { reply: N({ digest: 'x' }) }).errors, ['这里没有待整理']);
  // 网页只看得到每天几条
  assert.deepEqual(g.digest.days('a'), { days: [{ day: '2026-11-16', n: 2 }] });
  // 标 done 以后不再算待整理；留 30 天再清掉
  assert.equal(g.digest.markDone('a', '2026-11-16'), 2);
  assert.deepEqual(g.digest.days('a'), { days: [] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(g.dir, 'a', 'digest.json'), 'utf8')).length, 2);
  g.clock.t += 31 * DAY;
  g.digest.add('a', { text: '新的一条' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(g.dir, 'a', 'digest.json'), 'utf8')).map((x) => x.text), ['新的一条']);
});

test('日记：小记追加一段（day 不写是今天、kind 四种、priv）；她看的私人段只给个数；钩子口令给全文和那天没写成日记的待整理；开场带「昨天：gist」和没写成日记的日子', async () => {
  const g = fresh();
  g.digest.add('a', { text: '今天她加班到很晚' }); // 11-15
  let r = g.h.after('a', { reply: N({ diary: { kind: '事', text: '她加班到十点' } }) + N({ diary: { kind: '我', text: '有点心疼', priv: true } })
    + N({ diary: { kind: '别的', text: 'x' } }) + N({ diary: { day: '11-15', kind: '事', text: 'x' } }) });
  assert.deepEqual([r.notes, r.errors], [2, ['diary 的 kind 只能是 事、她、我、我们，text 不能空', 'day 要写成 2026-11-16 这样']]);
  assert.equal(g.digest.pending('a').length, 1); // 补的是今天：今天的待整理还在攒，不标 done
  const e = g.diary.get('a', '2026-11-15');
  assert.deepEqual(e.parts, [{ text: '她加班到十点', kind: '事' }, { text: '有点心疼', kind: '我', priv: true }]);
  // 第二天开场：昨天的日记没有 gist（醒着的 TA 补的），就不带「昨天」；有一天的待整理没写成日记，提醒一句
  g.clock.t = local(2026, 11, 16, 10);
  let c = g.h.start('a', { source: 'startup' }).context;
  assert.ok(!c.includes('昨天：'), c);
  assert.ok(c.includes('有 1 天的待整理还没写成日记（11-15），方便时补一下'), c);
  // 夜里写过、带 gist 的：交接里带一行
  g.diary.write('a', '2026-11-15', { gist: '她加班，我陪着', parts: [{ kind: '她', text: '她很累' }] });
  g.digest.markDone('a', '2026-11-15');
  c = g.h.start('a', { source: 'startup' }).context;
  assert.ok(c.includes('〔交接〕') && c.includes('昨天：她加班，我陪着'), c);
  assert.ok(!c.includes('待整理还没写成日记'));
  // 只往回提 7 天、今天的不算；醒着的 TA 补了以前那天，那天的待整理就算写成日记了
  g.clock.t = local(2026, 11, 8, 12); g.digest.add('a', { text: '太早的' });
  g.clock.t = local(2026, 11, 12, 12); g.digest.add('a', { text: '12 号的' });
  g.clock.t = local(2026, 11, 16, 12); g.digest.add('a', { text: '今天的' });
  c = g.h.start('a', { source: 'startup' }).context;
  assert.ok(c.includes('有 1 天的待整理还没写成日记（11-12）'), c);
  g.h.after('a', { reply: N({ diary: { day: '2026-11-12', kind: '事', text: '补上 12 号' } }) });
  assert.deepEqual(g.digest.pending('a').map((x) => x.text), ['太早的', '今天的']);
  // 地址：她看的那份、钩子口令那份、MCP
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: g.s, hooks: g.h, digest: g.digest, diary: g.diary, mcp: makeMcp({ hooks: g.h }) });
  const { port } = await srv.listen();
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { code: res.status, body: await res.json() };
  };
  try {
    const mine = (await call('GET', '/api/diary/a')).body;
    assert.deepEqual(mine.items.map((x) => x.day), ['2026-11-15', '2026-11-12']);
    assert.deepEqual(mine.items[0], { day: '2026-11-15', t: e.t, gist: '她加班，我陪着', parts: [{ text: '她加班到十点', kind: '事' }, { text: '她很累', kind: '她' }], privN: 1 });
    assert.ok(!JSON.stringify(mine).includes('心疼'));
    assert.deepEqual((await call('GET', '/api/diary/a?before=2026-11-15&limit=5')).body.items.map((x) => x.day), ['2026-11-12']);
    // 11-16 改：她看得到正文了（每天几条照旧给，另加 items）
    const dg = (await call('GET', '/api/digest/a')).body;
    assert.deepEqual(dg.days, [{ day: '2026-11-08', n: 1 }, { day: '2026-11-16', n: 1 }]);
    assert.deepEqual(dg.items.map((x) => [x.day, x.text]), [['2026-11-08', '太早的'], ['2026-11-16', '今天的']]);
    assert.equal((await call('GET', '/api/hook/a/diary?day=2026-11-15')).code, 401);
    const full = (await call('GET', '/api/hook/a/diary?day=2026-11-15', null, { authorization: 'Bearer tok' })).body;
    assert.equal(full.diary.parts[1].text, '有点心疼');
    assert.deepEqual((await call('GET', '/api/hook/a/diary?day=2026-11-16', null, { authorization: 'Bearer tok' })).body.digest.map((x) => x.text), ['今天的']);
    assert.equal((await call('GET', '/api/hook/a/diary?day=nope', null, { authorization: 'Bearer tok' })).code, 400);
    const rpc = async (args) => (await call('POST', '/mcp/a', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_diary', arguments: args } }, { authorization: 'Bearer tok' })).body.result;
    const t1 = (await rpc({ day: '2026-11-15' })).content[0].text;
    assert.ok(t1.startsWith('2026-11-15：她加班，我陪着') && t1.includes('[我]（你自己留着的）有点心疼'), t1);
    assert.ok((await rpc({})).content[0].text.startsWith('2026-11-15')); // 不写 day 就是最近的一篇
    assert.ok((await rpc({ day: '2026-11-16' })).content[0].text.includes('还没有日记') && (await rpc({ day: '2026-11-16' })).content[0].text.includes('- 今天的'));
  } finally { await srv.close(); }
});

test('散场记（钩子）：她说过话才问，问过一次后没新对话回 null；why 不对回 400；③ quiet 不进原文、不算想起一次、小记照存、回 kinds', async () => {
  const g = fresh();
  assert.deepEqual(g.h.idle('a', { sid: 's1' }), { ask: null }); // 还没聊过
  const w = g.s.add('a', { kind: 'wish', text: '想和她去看海' }, 'ai');
  await g.h.before('a', { text: '我们去看海吧', sid: 's1' });
  g.h.after('a', { sid: 's1', reply: '好。' });
  const { ask } = g.h.idle('a', { sid: 's1', why: 'idle' });
  assert.ok(ask.includes('散场记') && ask.includes('"digest"') && ask.includes('只回一个字'), ask);
  assert.ok([...ask].length < 400); // 短
  assert.deepEqual(g.h.idle('a', { sid: 's1' }), { ask: null }); // 没有新的对话
  assert.throws(() => g.h.idle('a', { why: 'nap' }), (e) => e.code === 400);
  assert.ok(g.h.idle('a', { why: 'compact' }).ask === null);
  g.clock.t += 60e3;
  await g.h.before('a', { text: '还在吗', sid: 's1' });
  assert.ok(g.h.idle('a', { why: 'compact' }).ask.includes('快压缩了'));
  // TA 的回答：quiet
  const talkN = g.s.talk.recent('a').length, hits = g.s.load('a').items.find((m) => m.id === w.id).hits;
  const r = g.h.after('a', { sid: 's1', quiet: true, reply: '想和她去看海。' + N({ digest: '她想去看海，我也想。' }) + N({ kind: 'wish', text: '悄悄的', priv: true }) });
  assert.deepEqual([r.notes, r.hits, r.kinds], [2, 0, ['digest', 'wish']]);
  assert.equal(g.s.talk.recent('a').length, talkN);
  assert.equal(g.s.load('a').items.find((m) => m.id === w.id).hits, hits);
  // 地址：要口令
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: g.s, hooks: g.h });
  const { port } = await srv.listen();
  try {
    const post = (body, auth = 'Bearer tok') => fetch(`http://127.0.0.1:${port}/api/hook/a/idle`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify(body) });
    assert.equal((await post({}, 'Bearer x')).status, 401);
    g.clock.t += 60e3;
    await g.h.before('a', { text: '晚安', sid: 's2' });
    assert.ok((await (await post({ sid: 's2', why: 'end' })).json()).ask.includes('这一场结束了'));
    assert.deepEqual(await (await post({ sid: 's2' })).json(), { ask: null });
  } finally { await srv.close(); }
});

test('旁听的小模型：默认关；改设置要口令、key 只存变量名、不给网页看地址和变量名；打开后散场记回 null、由它读原文写一条 by:helper；拒绝/出错/回空跳过，日志不带原文', async () => {
  const seen = [];
  const up = { reply: (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '她说想去看海，我听着也想去。' } }] })); } };
  const srv0 = http.createServer((req, res) => {
    const cs = [];
    req.on('data', (c) => cs.push(c));
    req.on('end', () => { seen.push({ url: req.url, headers: req.headers, j: JSON.parse(Buffer.concat(cs).toString('utf8')) }); up.reply(res); });
  });
  await new Promise((ok) => srv0.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv0.address().port}`;
  const g = fresh({ keyOrigins: 'HELPER_KEY=' + base }); // 11-19：旁听用的 Key 要在 .env 的 HELPER_KEY_ORIGINS 登记能发到哪
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: g.s, hooks: g.h, helper: g.helper });
  const { port } = await srv.listen();
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { code: res.status, body: await res.json() };
  };
  try {
    assert.deepEqual((await call('GET', '/api/helper/a')).body, { on: false, model: '', local: null, key: false, talk: true });
    // 11-18 起：网页里改（跟别的设置一样），HOOK_TOKEN 不再需要、也不算数
    const T = {};
    assert.equal((await call('PUT', '/api/helper/a', { on: true }, T)).code, 400); // 没填地址和模型
    assert.equal((await call('PUT', '/api/helper/a', { keyEnv: SECRET }, T)).code, 400); // 不是变量名
    for (const k of ['HOOK_TOKEN', 'WEB_PASSWORD', 'SESSION_SECRET', 'TRANSLATE_KEY']) assert.equal((await call('PUT', '/api/helper/a', { keyEnv: k }, T)).code, 400, k); // 后端自己的口令
    assert.equal((await call('PUT', '/api/helper/a', { url: 'http://10.0.0.8:8000' }, T)).code, 400); // 没放行的私网地址
    assert.equal((await call('PUT', '/api/helper/a', { url: base + '/?key=x' }, T)).code, 400);
    // 登记过的 Key 换一个没登记的地址（同一台机器另一个端口也算另一个地址）：不让打开
    assert.equal((await call('PUT', '/api/helper/a', { on: true, url: 'http://127.0.0.1:1', model: 'qwen-small', keyEnv: 'HELPER_KEY' }, T)).code, 400);
    const r = await call('PUT', '/api/helper/a', { on: true, url: base, model: 'qwen-small', keyEnv: 'HELPER_KEY' }, T);
    assert.deepEqual(r.body, { on: true, model: 'qwen-small', local: true, key: true, talk: true });
    // 打开后：散场记回 null，旁听的那个去写
    await g.h.before('a', { text: '我们去看海吧', sid: 's1' });
    g.h.after('a', { sid: 's1', reply: '好，我也想去。' });
    assert.deepEqual(g.h.idle('a', { sid: 's1' }), { ask: null });
    await g.helper.idle();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/v1/chat/completions');
    assert.equal(seen[0].headers.authorization, 'Bearer ' + SECRET);
    assert.equal(seen[0].j.model, 'qwen-small');
    assert.ok(seen[0].j.messages[1].content.includes('她：我们去看海吧') && seen[0].j.messages[1].content.includes('TA：好，我也想去。'));
    assert.deepEqual(g.digest.pending('a').map((x) => [x.by, x.text]), [['helper', '她说想去看海，我听着也想去。']]);
    assert.equal(g.digest.pending('a')[0].why, 'idle'); // 11-16：记下是哪个时机
    // 只读上次散场记以后的
    g.clock.t += 60e3;
    await g.h.before('a', { text: '明天几点出发', sid: 's1' });
    up.reply = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '抱歉，我不能帮忙处理这段对话。' } }] })); };
    g.h.idle('a', { sid: 's1' });
    await g.helper.idle();
    assert.ok(seen[1].j.messages[1].content.includes('明天几点出发') && !seen[1].j.messages[1].content.includes('我们去看海吧'));
    // 拒绝、回空、〔跳过〕、出错：都跳过，不存
    for (const fn of [
      (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '  ' } }] })); },
      (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '〔跳过〕' } }] })); },
      (res) => { res.writeHead(500); res.end('她说的原话 ' + SECRET); },
    ]) {
      up.reply = fn;
      g.clock.t += 60e3;
      await g.h.before('a', { text: '她又说了一句很私密的话', sid: 's1' });
      g.h.idle('a', { sid: 's1' });
      await g.helper.idle();
    }
    assert.equal(g.digest.pending('a').length, 1);
    assert.ok(g.logs.some((l) => l.includes('接口回了 500')));
    for (const l of g.logs) assert.ok(!l.includes('私密') && !l.includes('看海') && !l.includes(SECRET), l);
    for (const f of walk(g.dir)) assert.ok(!fs.readFileSync(f, 'utf8').includes(SECRET), '数据里有 key：' + f);
    assert.ok(!JSON.stringify((await call('GET', '/api/helper/a')).body).includes('HELPER_KEY'));
    assert.ok(!JSON.stringify(g.s.exportAll('a')).includes('qwen-small')); // 设置不进导出
    // 对话原文关着：小模型读不到，跳过（散场记照样回 null，不改成问 TA）
    g.s.setCfg('a', { talk: false });
    g.clock.t += 60e3;
    await g.h.before('a', { text: '再一句', sid: 's1' });
    assert.deepEqual(g.h.idle('a', { sid: 's1' }), { ask: null });
    await g.helper.idle();
    assert.equal(seen.length, 5);
    assert.ok(g.logs.some((l) => l.includes('对话原文没开')));
  } finally { await srv.close(); srv0.closeAllConnections(); await new Promise((ok) => srv0.close(ok)); }
});

test('夜里：整理默认开；全新安装第一晚不跑（调度时记下 from）；没配临时的 TA 不跑也不报错', async () => {
  const g = fresh();
  g.s.add('a', { text: '她今天说想睡觉' });
  assert.equal(g.night.get('a').tidy, true);
  assert.equal(g.night.get('a').dream, false);
  g.clock.t = local(2026, 11, 15, 23);
  assert.deepEqual(await g.night.tick(), []); // 全新：记下今天
  assert.equal(g.s.load('a').cfg.night.from, g.clock.t);
  g.clock.t = local(2026, 11, 16, 3, 5);
  assert.deepEqual(await g.night.tick(), ['a']);
  const none = makeNight({ store: g.s, digest: g.digest, diary: g.diary, runner: null, tz: TZ, dir: g.dir });
  g.clock.t = local(2026, 11, 17, 3, 5);
  assert.deepEqual(await none.tick(), []);
});

test('夜里先写日记：读没写成日记的那几天（最多往回 3 天，今天的不写）的待整理 + 原文，一天一篇，写完标 done；坏了跳过那天；摘要不带正文；再整理记忆；写梦带当天日记的非私人段', async () => {
  const g = fresh();
  // 11-13：只有待整理（模型回坏的）；11-15：待整理 + 原文；11-11：太早；11-16 凌晨的：今天的
  g.clock.t = local(2026, 11, 11, 20); g.digest.add('a', { text: '十一号的事' });
  g.clock.t = local(2026, 11, 13, 20); g.digest.add('a', { text: '十三号的事' });
  g.clock.t = local(2026, 11, 15, 20);
  g.digest.add('a', { text: '她说周三要去体检，有点怕抽血' });
  await g.h.before('a', { text: '我有点怕抽血', sid: 's1' });
  g.h.after('a', { sid: 's1', reply: '我陪你。' + N({ kind: 'note', text: '她周三体检' }) });
  g.clock.t = local(2026, 11, 16, 1); g.digest.add('a', { text: '凌晨一点的' });
  g.clock.t = local(2026, 11, 16, 3, 5);
  g.fake.reply = (x) => {
    if (x.system.endsWith(DIARY_PROMPT)) {
      if (x.prompt.includes('十三号')) return '我不想写';
      return 'ok ' + JSON.stringify({ gist: '她怕抽血，我陪着', parts: [{ kind: '事', text: '她周三体检' }, { kind: '我', text: '心里软软的', priv: true }, { kind: '别的', text: 'x' }] });
    }
    if (x.system.endsWith(TIDY_PROMPT)) return JSON.stringify({ note: '没什么要改' });
    return JSON.stringify({ text: '梦见陪她排队', gist: '排队', priv: false });
  };
  g.night.set('a', { dream: true });
  const out = await g.night.run('a');
  // 先日记（两天，按日期），再整理，再写梦
  const kinds = g.seen.map((x) => (x.system.endsWith(DIARY_PROMPT) ? 'diary' : x.system.endsWith(TIDY_PROMPT) ? 'tidy' : x.system.endsWith(DREAM_PROMPT) ? 'dream' : '?'));
  assert.deepEqual(kinds, ['diary', 'diary', 'tidy', 'dream']);
  assert.ok(g.seen[0].prompt.includes('2026-11-13') && g.seen[1].prompt.includes('她说周三要去体检') && g.seen[1].prompt.includes('她：我有点怕抽血') && g.seen[1].prompt.includes('你：我陪你。'));
  assert.ok(!g.seen.some((x) => x.prompt.includes('十一号') || x.prompt.includes('凌晨一点')));
  assert.deepEqual(out.tidy.diary, { days: ['2026-11-15'], skip: 1 });
  // 写成的那天标 done；坏了的那天留着
  assert.deepEqual(g.digest.pending('a').map((x) => x.text), ['十一号的事', '十三号的事', '凌晨一点的']);
  const e = g.diary.get('a', '2026-11-15');
  assert.deepEqual([e.gist, e.parts.length, e.parts[1].priv], ['她怕抽血，我陪着', 2, true]);
  assert.equal(g.diary.has('a', '2026-11-13'), false);
  // 整理的材料里有刚写好的日记
  assert.ok(g.seen[2].prompt.includes('## 刚写好的日记') && g.seen[2].prompt.includes('[事]她周三体检'));
  // 写梦：当天日记的非私人段（只读），私人段不给
  assert.ok(g.seen[3].prompt.includes('[事] 她周三体检') && !g.seen[3].prompt.includes('心里软软的'));
  // 给网页的摘要不带模型写的正文；日志也不带
  const web = JSON.stringify(g.night.get('a'));
  assert.ok(web.includes('2026-11-15') && !web.includes('抽血') && !web.includes('软软'));
  for (const l of g.logs) assert.ok(!l.includes('十三号') && !l.includes('不想写'), l);
  assert.ok(!JSON.stringify(g.s.readLog('a')).includes('抽血'));
  // 只有原文、没有待整理的日子也写；已经有日记的日子不再写；两样都没有的不写
  g.clock.t = local(2026, 11, 16, 21);
  await g.h.before('a', { text: '今天好累', sid: 's2' });
  g.clock.t = local(2026, 11, 17, 3, 5);
  g.seen.length = 0;
  g.night.set('a', { dream: false });
  g.fake.reply = (x) => (x.system.endsWith(DIARY_PROMPT) ? JSON.stringify({ gist: '累', parts: [{ kind: '她', text: '她很累' }] }) : '{}');
  const o2 = await g.night.run('a');
  assert.deepEqual(o2.tidy.diary, { days: ['2026-11-16'], skip: 0 }); // 13 号已经超过往回 3 天：不再写，留着等醒着的 TA 补
  const dp = g.seen.filter((x) => x.system.endsWith(DIARY_PROMPT));
  assert.ok(dp.length === 1 && dp[0].prompt.includes('凌晨一点的') && dp[0].prompt.includes('她：今天好累'));
  assert.deepEqual(g.digest.pending('a').map((x) => x.text), ['十一号的事', '十三号的事']);
  // 开场：昨天的 gist
  g.clock.t = local(2026, 11, 17, 9);
  assert.ok(g.h.start('a', { source: 'startup' }).context.includes('昨天：累'));
  // 没有 digest / diary 的老写法照旧（没有 diary 这一项）
  const old = makeNight({ store: g.s, runner: async () => '{}', tz: TZ, dir: g.dir });
  assert.equal((await old.run('a', { tidy: true })).tidy.diary, undefined);
});

test('Claude Code 范例：MEM_FORK=1 时 hook.sh 什么都不做；digest.sh 问 idle → 分叉问（假的 claude）→ 交给 after(quiet)，没有问话就不分叉', async () => {
  const g = fresh();
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: g.s, hooks: g.h, digest: g.digest });
  const { port } = await srv.listen();
  const envf = path.join(g.dir, 'env'), logf = path.join(g.dir, 'hook.log');
  fs.writeFileSync(envf, `MEM_URL=http://127.0.0.1:${port}\nMEM_AI=a\nMEM_TOKEN=tok\n`);
  // 假的 claude：记下参数和 MEM_FORK，回一句带小记的话
  const fake = path.join(g.dir, 'fake-claude.sh'), argf = path.join(g.dir, 'args.txt');
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "MEM_FORK=$MEM_FORK" "$@" > '${argf}'\nprintf '%s' '无${N({ digest: '她想去看海' }).replace(/'/g, '')}'\n`, { mode: 0o700 });
  const { spawn } = await import('node:child_process');
  const run = (script, args, env = {}, stdin = '') => new Promise((ok) => {
    const p = spawn('/bin/sh', [path.join(here, '../examples/claude-code', script), ...args], { env: { ...process.env, MEM_ENV: envf, MEM_LOG: logf, MEM_CLAUDE: fake, ...env } });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('close', (status) => ok({ status, out }));
    p.stdin.on('error', () => {}); // 脚本不读输入就先退了（比如 MEM_FORK=1）：写进去会 EPIPE，不算错
    p.stdin.end(stdin);
  });
  try {
    // hook.sh：分叉出去的那份不交任何东西
    const f = await run('hook.sh', ['before'], { MEM_FORK: '1' }, JSON.stringify({ prompt: '不该记', session_id: 's1' }));
    assert.deepEqual([f.status, f.out], [0, '']);
    assert.equal(g.s.talk.recent('a').length, 0);
    // digest.sh：还没聊过，后端回 null，不分叉
    let d = await run('digest.sh', ['s1']);
    assert.deepEqual([d.status, d.out, fs.existsSync(argf)], [0, '', false]);
    await g.h.before('a', { text: '我们去看海吧', sid: 's1' });
    d = await run('digest.sh', ['s1', 'idle']);
    assert.deepEqual([d.status, d.out], [0, '']);
    const args = fs.readFileSync(argf, 'utf8').split('\n');
    assert.deepEqual(args.slice(0, 5), ['MEM_FORK=1', '-p', '--resume', 's1', '--fork-session']);
    assert.ok(args.slice(5).join('\n').includes('散场记'));
    assert.deepEqual(g.digest.pending('a').map((x) => x.text), ['她想去看海']);
    assert.deepEqual(g.s.talk.recent('a').map((x) => x.role), ['me']); // quiet：TA 那句不进原文
    // 自己就在分叉里：什么都不做；没给会话编号：什么都不做
    assert.deepEqual((await run('digest.sh', ['s1'], { MEM_FORK: '1' })).out, '');
    assert.equal((await run('digest.sh', [])).status, 0);
  } finally { await srv.close(); }
});

test('Claude Code 范例：hook.sh 在 compact、end 时后台调 digest.sh（快压缩了 / 一场结束），不等它、立刻返回、退出码 0；没有会话编号、MEM_FORK=1 不调', async () => {
  const g = fresh();
  g.s.add('a', { kind: 'pact', text: '周末一起看电影' });
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: g.s, hooks: g.h, digest: g.digest });
  const { port } = await srv.listen();
  const envf = path.join(g.dir, 'env'), logf = path.join(g.dir, 'hook.log');
  fs.writeFileSync(envf, `MEM_URL=http://127.0.0.1:${port}\nMEM_AI=a\nMEM_TOKEN=tok\n`);
  // 假的 digest.sh：先睡 1 秒（看钩子等不等它），再记下参数
  const fake = path.join(g.dir, 'fake-digest.sh'), rec = path.join(g.dir, 'digest-args.txt');
  fs.writeFileSync(fake, `sleep 1\nprintf '%s\\n' "$*" >> '${rec}'\n`, { mode: 0o700 });
  const { spawn } = await import('node:child_process');
  const run = (when, ev, env = {}) => new Promise((ok) => {
    const t0 = Date.now();
    const p = spawn('/bin/sh', [path.join(here, '../examples/claude-code/hook.sh'), when], { env: { ...process.env, MEM_ENV: envf, MEM_LOG: logf, MEM_DIGEST: fake, ...env } });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('close', (status) => ok({ status, out, ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify(ev));
  });
  const lines = () => (fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').trim().split('\n') : []);
  const wait = async (n) => { for (let i = 0; i < 100 && lines().length < n; i++) await new Promise((ok) => setTimeout(ok, 50)); };
  try {
    const c = await run('compact', { hook_event_name: 'PreCompact', session_id: 's9' });
    assert.equal(c.status, 0);
    assert.ok(c.out.includes('周末一起看电影')); // 压缩前那段照旧打印
    assert.ok(c.ms < 900, `钩子等了 ${c.ms} 毫秒`);
    const e = await run('end', { hook_event_name: 'SessionEnd', session_id: 's9' });
    assert.deepEqual([e.status, e.out], [0, '']);
    assert.ok(e.ms < 900, `钩子等了 ${e.ms} 毫秒`);
    await wait(2);
    assert.deepEqual(lines().sort(), ['s9 compact', 's9 end']);
    // 没有会话编号、分叉出去的那份：不调
    assert.equal((await run('end', {})).status, 0);
    assert.equal((await run('compact', { session_id: 's9' }, { MEM_FORK: '1' })).out, '');
    await new Promise((ok) => setTimeout(ok, 1300));
    assert.equal(lines().length, 2);
  } finally { await srv.close(); }
});

test('导出 / 导入：日记、待整理各单独一项（不混进 items）；日记私人段不带只给个数，待整理带正文；导入带回来，同一天的日记两边的段都留；旧文件照样能导', async () => {
  const g = fresh();
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: g.s, hooks: g.h, digest: g.digest, diary: g.diary });
  const { port } = await srv.listen();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, body: await r.json() };
  };
  try {
    g.s.add('a', { text: '她喜欢海' });
    g.h.after('a', { sid: 's1', reply: N({ digest: '她说周三体检，怕抽血。' }) });
    g.diary.write('a', '2026-11-14', { gist: '去了海边', parts: [{ kind: '事', text: '我们聊了海' }, { kind: '我', text: '我偷偷开心', priv: true }] });
    g.diary.write('a', '2026-11-15', { gist: '体检前一天', parts: [{ kind: '她', text: '她有点怕' }] });
    g.digest.markDone('a', '2026-11-15');
    g.clock.t += 60e3;
    g.h.after('a', { sid: 's1', reply: N({ digest: '晚上她睡得早。' }) });
    const ex = (await call('GET', '/api/memory/a/export')).body;
    assert.deepEqual(ex.items.map((m) => m.text), ['她喜欢海']); // 日记、待整理不混进记忆
    assert.deepEqual(ex.diary.map((x) => [x.day, x.gist, x.parts.length, x.privN]), [['2026-11-14', '去了海边', 1, 1], ['2026-11-15', '体检前一天', 1, undefined]]);
    assert.ok(!JSON.stringify(ex).includes('偷偷开心'));
    assert.deepEqual(ex.digest.map((x) => [x.text, x.by, !!x.done]), [['她说周三体检，怕抽血。', 'ai', true], ['晚上她睡得早。', 'ai', false]]);
    // 导进另一个 AI：全带回来
    const r1 = (await call('POST', '/api/memory/b/import', ex)).body;
    assert.deepEqual(r1, { added: 1, diary: { added: 2, merged: 0 }, digest: { added: 2 } });
    assert.deepEqual(g.digest.pending('b').map((x) => x.text), ['晚上她睡得早。']); // done 的还是 done
    assert.equal(g.diary.get('b', '2026-11-14').parts.length, 1);
    // 再导一次：编号一样的待整理不重复，日记一字不差的段不重复
    assert.deepEqual((await call('POST', '/api/memory/b/import', ex)).body, { added: 0, diary: { added: 0, merged: 0 }, digest: { added: 0 } });
    // 同一天已经有日记：两边的段都留，这边的 gist 不被换掉；这边 gist 空着才用导进来的
    g.diary.write('a', '2026-11-16', { parts: [{ kind: '事', text: 'A 这边写的' }] });
    g.diary.write('b', '2026-11-14', { parts: [{ kind: '我们', text: 'B 这边先有的' }] });
    const r2 = (await call('POST', '/api/memory/b/import', { items: [], diary: [
      { day: '2026-11-14', gist: '别的说法', parts: [{ kind: '事', text: '我们聊了海' }, { kind: '她', text: '她晒黑了' }] },
      ...(await call('GET', '/api/memory/a/export')).body.diary.filter((x) => x.day === '2026-11-16').map((x) => ({ ...x, gist: '十六号' })),
      { day: '坏日子', parts: [{ kind: '事', text: 'x' }] }, { day: '2026-11-17', parts: [{ kind: '不认识', text: 'x' }] } ] })).body;
    assert.deepEqual(r2.diary, { added: 1, merged: 1 });
    const d14 = g.diary.get('b', '2026-11-14');
    assert.equal(d14.gist, '去了海边');
    assert.deepEqual(d14.parts.map((p) => p.text), ['我们聊了海', 'B 这边先有的', '她晒黑了']);
    assert.equal(g.diary.has('b', '2026-11-17'), false);
    // 旧的导出文件（没有 diary、digest 两项）：照样导，回的也没有这两项
    const old = { v: 1, ai: 'a', items: [{ id: 'old1', text: '旧文件里的一条' }], dreams: [], handoff: null };
    assert.deepEqual((await call('POST', '/api/memory/c/import', old)).body, { added: 1 });
    // 日志不带内容
    assert.ok(!JSON.stringify(g.s.readLog('b')).includes('晒黑'));
  } finally { await srv.close(); }
});

// 第⑩批
test('导入：diary、digest 写坏了（不是数组、一条里缺东西）跳过不报错，记忆照导；后端没开日记和待整理时，导出没有这两项、导入不理它们', async () => {
  const g = fresh();
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: g.s, hooks: g.h, digest: g.digest, diary: g.diary });
  const bare = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: g.s, hooks: g.h }); // 没注入日记、待整理
  const { port } = await srv.listen(), { port: p2 } = await bare.listen();
  const call = async (pt, method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${pt}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, body: await r.json() };
  };
  try {
    const bad = { items: [{ id: 'm1', text: '她喜欢海' }], diary: '不是数组', digest: { id: 'x' } };
    assert.deepEqual(await call(port, 'POST', '/api/memory/a/import', bad), { code: 200, body: { added: 1, diary: { added: 0, merged: 0 }, digest: { added: 0 } } });
    const half = { items: [], diary: [null, { day: '2026-11-14' }, { day: '2026-11-14', parts: 'x' }], digest: [null, { id: 'g1', text: '没写日期', by: 'ai' }, { id: 'g2', day: '2026-11-14', text: '谁写的不对', by: 'x' }, { id: 'g3', day: '2026-11-14', text: '好的一条', by: 'ai' }] };
    assert.deepEqual((await call(port, 'POST', '/api/memory/a/import', half)).body, { added: 0, diary: { added: 0, merged: 0 }, digest: { added: 1 } });
    assert.deepEqual(g.digest.pending('a').map((x) => x.text), ['好的一条']);
    // 没开日记和待整理的后端
    const ex = (await call(p2, 'GET', '/api/memory/a/export')).body;
    assert.deepEqual([ex.diary, ex.digest, ex.items.length], [undefined, undefined, 1]);
    assert.deepEqual((await call(p2, 'POST', '/api/memory/b/import', { items: [{ id: 'm2', text: '一条' }], diary: [{ day: '2026-11-14', parts: [{ kind: '事', text: 'x' }] }], digest: [{ id: 'g9', day: '2026-11-14', text: 'y', by: 'ai' }] })).body, { added: 1 });
    assert.equal(g.diary.has('b', '2026-11-14'), false);
    assert.equal(g.digest.pending('b').length, 0);
  } finally { await srv.close(); await bare.close(); }
});

test('快压缩 / 一场结束（钩子口）：② 跌进 10% 那次回 digest:true（走 HTTP 也带着）；调用方拿 why 去问 idle，问话写明是哪个时机；问过以后没新对话回 null', async () => {
  const g = fresh();
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: g.s, hooks: g.h, digest: g.digest });
  const { port } = await srv.listen();
  const hook = async (when, body) => (await fetch(`http://127.0.0.1:${port}/api/hook/a/${when}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok' }, body: JSON.stringify(body) })).json();
  try {
    assert.equal((await hook('before', { text: '嗯', sid: 's1', ctxLeft: 0.5 })).digest, undefined);
    g.clock.t += 60e3;
    assert.equal((await hook('before', { text: '还在说', sid: 's1', ctxLeft: 0.08 })).digest, true);
    g.clock.t += 60e3;
    assert.equal((await hook('before', { text: '嗯嗯', sid: 's1', ctxLeft: 0.05 })).digest, undefined); // 同一轮不再给
    const a = await hook('idle', { sid: 's1', why: 'compact' });
    assert.ok(a.ask.startsWith('〔散场记：快压缩了。'), a.ask);
    assert.equal((await hook('idle', { sid: 's1', why: 'end' })).ask, null); // 刚问过，没有新的话
    g.clock.t += 60e3;
    await hook('before', { text: '我睡了', sid: 's1' });
    assert.ok((await hook('idle', { sid: 's1', why: 'end' })).ask.startsWith('〔散场记：这一场结束了。'));
  } finally { await srv.close(); }
});

// 11-16：待整理她看得到正文，能加更正、收走
test('待整理她看得到：GET 带正文、时机（散场记的 why；聊天当中写的没有）、不带会话编号；加更正不动原话、能改能删；收走标 gone 不真删、哪儿都当不存在、30 天后清；锁着要开锁；流水不带内容；写成日记的动不了', async () => {
  const g = fresh();
  await g.h.before('a', { text: '我周四去体检', sid: 's1' });
  g.h.after('a', { sid: 's1', reply: '好。' + N({ digest: '聊天当中顺手记的一条' }) });
  assert.ok(g.h.idle('a', { sid: 's1', why: 'compact' }).ask);
  g.h.after('a', { sid: 's1', quiet: true, reply: N({ digest: '她说周三要去体检，有点怕抽血。' }) });
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: g.s, hooks: g.h, digest: g.digest, mcp: makeMcp({ hooks: g.h }) });
  const { port } = await srv.listen();
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { code: res.status, body: await res.json() };
  };
  const file = () => JSON.parse(fs.readFileSync(path.join(g.dir, 'a', 'digest.json'), 'utf8'));
  try {
    let v = (await call('GET', '/api/digest/a')).body;
    assert.deepEqual(v.days, [{ day: '2026-11-15', n: 2 }]);
    assert.deepEqual(v.items.map((x) => [x.text, x.why, x.by]), [['聊天当中顺手记的一条', undefined, 'ai'], ['她说周三要去体检，有点怕抽血。', 'compact', 'ai']]);
    assert.ok(v.items.every((x) => !('sid' in x)));
    const id = v.items[1].id, other = v.items[0].id;
    // 加更正：空的 400、没有这条 404；原话不动
    assert.equal((await call('PUT', `/api/digest/a/${id}/fix`, { text: '  ' })).code, 400);
    assert.equal((await call('PUT', '/api/digest/a/nope/fix', { text: 'x' })).code, 404);
    let r = await call('PUT', `/api/digest/a/${id}/fix`, { text: '是周三，不对，是周四去体检' });
    assert.equal(r.body.fix.text, '是周三，不对，是周四去体检');
    r = await call('PUT', `/api/digest/a/${id}/fix`, { text: '是周四，不是周三' + '长'.repeat(600) }); // 能再改；最长 500 字
    assert.equal([...r.body.fix.text].length, 500);
    r = await call('PUT', `/api/digest/a/${id}/fix`, { text: '是周四，不是周三' });
    assert.deepEqual([r.body.text, r.body.fix.text], ['她说周三要去体检，有点怕抽血。', '是周四，不是周三']);
    assert.equal(file().find((x) => x.id === id).text, '她说周三要去体检，有点怕抽血。');
    // TA 翻那天的日记（钩子口令、MCP）时带着更正
    assert.deepEqual(g.h.diary('a', '2026-11-15').digest.map((x) => x.fix), [undefined, '是周四，不是周三']);
    const t1 = (await call('POST', '/mcp/a', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_diary', arguments: { day: '2026-11-15' } } }, { authorization: 'Bearer tok' })).body.result.content[0].text;
    assert.ok(t1.includes('- 她说周三要去体检，有点怕抽血。\n  她更正：是周四，不是周三（以她的为准）'), t1);
    // 删更正；再删一次也不报错
    assert.equal((await call('DELETE', `/api/digest/a/${other}/fix`)).body.fix, undefined);
    await call('PUT', `/api/digest/a/${other}/fix`, { text: '这条先加后删' });
    assert.equal((await call('DELETE', `/api/digest/a/${other}/fix`)).body.fix, undefined);
    assert.equal(file().find((x) => x.id === other).fix, undefined);
    // 设了记忆锁：加更正、删更正、收走都要开锁
    g.s.setLock('a', { pass: '0420' });
    assert.equal((await call('PUT', `/api/digest/a/${other}/fix`, { text: 'x' })).code, 423);
    assert.equal((await call('DELETE', `/api/digest/a/${id}/fix`)).code, 423);
    assert.equal((await call('DELETE', `/api/digest/a/${other}`)).code, 423);
    const tok = (await call('POST', '/api/memory/a/unlock', { pass: '0420' })).body.token;
    const U = { 'x-mem-unlock': tok };
    // 收走：标 gone、不真删
    r = await call('DELETE', `/api/digest/a/${other}`, null, U);
    assert.deepEqual(r.body, { ok: true, gone: g.clock.t });
    assert.equal(file().find((x) => x.id === other).gone, g.clock.t);
    v = (await call('GET', '/api/digest/a')).body;
    assert.deepEqual([v.days, v.items.map((x) => x.id)], [[{ day: '2026-11-15', n: 1 }], [id]]);
    assert.deepEqual(g.digest.pending('a').map((x) => x.id), [id]);
    assert.ok(!JSON.stringify(g.digest.exportAll('a')).includes('顺手记的'));
    assert.ok(!JSON.stringify(g.h.diary('a', '2026-11-15')).includes('顺手记的'));
    assert.equal((await call('PUT', `/api/digest/a/${other}/fix`, { text: 'x' }, U)).code, 404); // 收走的动不了
    assert.equal((await call('DELETE', `/api/digest/a/${other}`, null, U)).code, 404);
    // 流水只记做了什么，不带内容
    const ops = g.s.readLog('a').filter((e) => e.op.startsWith('digest-')).map((e) => e.op);
    assert.deepEqual(ops, ['digest-fix', 'digest-fix', 'digest-fix', 'digest-fix', 'digest-unfix', 'digest-gone']);
    assert.ok(!JSON.stringify(g.s.readLog('a')).includes('周四'));
    // 写成日记以后：不再列出、动不了；收走的那条不算进去
    assert.equal(g.digest.markDone('a', '2026-11-15'), 1);
    assert.equal((await call('PUT', `/api/digest/a/${id}/fix`, { text: 'x' }, U)).code, 404);
    assert.deepEqual((await call('GET', '/api/digest/a')).body, { days: [], items: [] });
    // 30 天后连收走的一起清掉
    g.clock.t += 31 * DAY;
    g.digest.add('a', { text: '新的一条' });
    assert.deepEqual(file().map((x) => x.text), ['新的一条']);
  } finally { await srv.close(); }
});

test('夜里写日记：她更正过的待整理，原文下面跟一行更正，提示词写明以她的为准；整理记忆时也带上；收走的不带', async () => {
  const g = fresh();
  g.clock.t = local(2026, 11, 15, 20);
  const a = g.digest.add('a', { text: '她说周三要去体检' });
  g.digest.add('a', { text: '没更正的一条' });
  const c = g.digest.add('a', { text: '她收走的一条' });
  g.digest.setFix('a', a.id, '是周四');
  g.digest.remove('a', c.id);
  g.s.add('a', { text: '她要去体检' }); // 有新记忆，整理才跑
  g.clock.t = local(2026, 11, 16, 3, 5);
  g.fake.reply = (x) => (x.system.endsWith(DIARY_PROMPT) ? JSON.stringify({ gist: '体检', parts: [{ kind: '事', text: '她周四体检' }] }) : '{}');
  const out = await g.night.run('a', { tidy: true });
  assert.deepEqual(out.tidy.diary, { days: ['2026-11-15'], skip: 0 });
  assert.ok(DIARY_PROMPT.includes('以她的为准') && TIDY_PROMPT.includes('以她的为准'));
  const [dp, tp] = g.seen.map((x) => x.prompt);
  assert.ok(dp.includes('- 她说周三要去体检\n  她更正：是周四\n- 没更正的一条'), dp);
  assert.ok(!dp.includes('收走的'));
  assert.ok(tp.includes('## 她更正过的待整理') && tp.includes('- 她说周三要去体检\n  她更正：是周四') && !tp.includes('没更正的一条'), tp);
  // 给网页的摘要不带正文
  assert.ok(!JSON.stringify(g.night.get('a')).includes('周四'));
});

test('导出 / 导入：待整理带时机和她的更正、不带收走的；导入带回来；更正写坏了只丢更正；收走的、旧文件没有这两项的照样处理', async () => {
  const g = fresh();
  await g.h.before('a', { text: '嗯', sid: 's1' });
  g.h.idle('a', { sid: 's1', why: 'end' });
  g.h.after('a', { sid: 's1', quiet: true, reply: N({ digest: '她说周三体检' }) });
  const [x] = g.digest.pending('a');
  g.digest.setFix('a', x.id, '是周四');
  const y = g.digest.add('a', { text: '要收走的' });
  g.digest.remove('a', y.id);
  const ex = g.digest.exportAll('a');
  assert.deepEqual(ex.map((z) => [z.text, z.why, z.fix?.text]), [['她说周三体检', 'end', '是周四']]);
  assert.deepEqual(g.digest.importAll('b', ex), { added: 1 });
  assert.deepEqual(g.digest.list('b').items.map((z) => [z.text, z.why, z.fix.text]), [['她说周三体检', 'end', '是周四']]);
  const r = g.digest.importAll('c', [
    { id: 'g1', day: '2026-11-14', text: '旧文件的一条', by: 'ai' },
    { id: 'g2', day: '2026-11-14', text: '更正坏了', by: 'ai', fix: { text: '' }, why: 'nap' },
    { id: 'g3', day: '2026-11-14', text: '别处收走的', by: 'ai', gone: 1 },
  ]);
  assert.deepEqual(r, { added: 2 });
  assert.deepEqual(g.digest.list('c').items.map((z) => [z.text, z.why, z.fix]), [['旧文件的一条', undefined, undefined], ['更正坏了', undefined, undefined]]);
});
