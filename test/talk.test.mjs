import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTalk } from '../lib/talk.mjs';
import { openStore } from '../lib/store.mjs';
import { makeHooks } from '../lib/hooks.mjs';
import { createServer } from '../lib/server.mjs';

const HOUR = 3600e3;
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // 自己建的临时目录自己清
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-'));
  dirs.push(dir);
  const clock = { t: Date.UTC(2026, 10, 15, 4) };
  const now = () => clock.t;
  const talk = openTalk({ dir, now });
  const s = openStore({ dir, tz: 'Asia/Shanghai', now, talk });
  return { dir, clock, talk, s, h: makeHooks({ store: s, tz: 'Asia/Shanghai' }), file: path.join(dir, 'a', 'talk.jsonl') };
}
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 0; };
const N = (o) => `<!--note ${JSON.stringify(o)} -->`;

test('对话原文：存、按时间/场次/条数取、最后几个来回、清空；文件 600；一句超 8000 字截断；名字乱写不收', () => {
  const { talk, clock, file } = fresh();
  talk.add('a', { sid: 's1', role: 'me', text: '在吗' });
  clock.t += 1000;
  talk.add('a', { sid: 's1', role: 'ai', text: '在' });
  talk.add('a', { sid: 's2', role: 'me', text: '换了一场' });
  talk.add('a', { sid: 's2', role: 'me', text: '又说一句' });
  clock.t += 1000;
  talk.add('a', { sid: 's2', role: 'ai', text: '嗯' });
  assert.equal(talk.add('a', { role: 'me', text: '   ' }), null); // 空的不存
  assert.equal(code(() => talk.add('a', { role: 'x', text: 'y' })), 400);
  assert.equal(code(() => talk.add('../etc', { role: 'me', text: 'y' })), 400);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(talk.recent('a').length, 5);
  assert.deepEqual(talk.recent('a', { sid: 's1' }).map((r) => r.text), ['在吗', '在']);
  assert.deepEqual(talk.recent('a', { limit: 2 }).map((r) => r.text), ['又说一句', '嗯']);
  assert.deepEqual(talk.recent('a', { since: Date.UTC(2026, 10, 15, 4) }).map((r) => r.text), ['在', '换了一场', '又说一句', '嗯']);
  // 来回：她一句 + TA 一句；她连着说两句，前一句自己算一个没回的来回
  assert.deepEqual(talk.lastRounds('a', 5).map((r) => [r.me?.text ?? null, r.ai?.text ?? null]), [['在吗', '在'], ['换了一场', null], ['又说一句', '嗯']]);
  assert.equal(talk.lastRounds('a', 1).length, 1);
  const long = talk.add('a', { role: 'ai', text: '字'.repeat(9000) });
  assert.equal([...long.text].length, 8000);
  talk.wipe('a');
  assert.ok(!fs.existsSync(file));
  assert.deepEqual(talk.recent('a'), []);
});

test('对话原文：超过 48 小时的读不到，写的时候顺手清（一小时一次，先写旁边再换名）', () => {
  const { talk, clock, file } = fresh();
  talk.add('a', { sid: 's1', role: 'me', text: '很早以前的话' });
  clock.t += 30 * HOUR;
  talk.add('a', { sid: 's1', role: 'me', text: '一天多以前' });
  clock.t += 20 * HOUR; // 第一句已经 50 小时
  assert.deepEqual(talk.recent('a').map((r) => r.text), ['一天多以前']); // 读不到了
  assert.ok(fs.readFileSync(file, 'utf8').includes('很早以前的话')); // 还没到清的时候，文件里还在
  talk.add('a', { sid: 's2', role: 'me', text: '现在' }); // 离上次清超过一小时：这次写顺手清
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('很早以前的话') && raw.includes('一天多以前') && raw.includes('现在'));
  assert.ok(!fs.existsSync(file + '.tmp'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // 留多久可以改
  const short = openTalk({ dir: path.dirname(path.dirname(file)), now: () => clock.t, keepMs: HOUR });
  assert.deepEqual(short.recent('a').map((r) => r.text), ['现在']);
});

test('对话原文接进钩子：她的话、TA 摘掉小记的正文；开关关着不写并清掉；不进导出', async () => {
  const { s, h, talk, file } = fresh();
  await h.before('a', { text: '今天好冷', sid: 's1' });
  h.after('a', { sid: 's1', reply: '多穿点。' + N({ kind: 'note', text: '她怕冷' }) });
  h.after('a', { sid: 's1', reply: N({ state: { ease: '平' } }) }); // 只有小记：没有正文，不存
  assert.deepEqual(talk.recent('a').map((r) => [r.role, r.sid, r.text]), [['me', 's1', '今天好冷'], ['ai', 's1', '多穿点。']]);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('note'));
  assert.ok(!JSON.stringify(s.exportAll('a')).includes('今天好冷'));
  assert.equal(s.getCfg('a').talk, true);
  assert.equal(s.setCfg('a', { talk: false }).talk, false);
  assert.ok(!fs.existsSync(file)); // 关掉就清
  await h.before('a', { text: '关着说的', sid: 's1' });
  h.after('a', { sid: 's1', reply: '关着回的' });
  assert.deepEqual(talk.recent('a'), []);
  s.setCfg('a', { talk: true });
  await h.before('a', { text: '又开了', sid: 's2' });
  assert.equal(talk.recent('a').length, 1);
  // 原文写不进（比如磁盘坏了）也不耽误聊天
  const add = talk.add;
  talk.add = () => { throw new Error('磁盘满了'); };
  assert.ok((await h.before('a', { text: 'x' })).context.includes('今天第'));
  assert.equal(h.after('a', { reply: '嗯' }).ok, true);
  talk.add = add;
});

test('对话原文没有任何 HTTP 接口能读出去：网页的地址一律拿不到；钩子只在开场带最后几个来回给 TA，要口令', async () => {
  const { s, h, clock } = fresh();
  const OLD = '只在原文里的老话XYZ';
  await h.before('a', { text: OLD, sid: 's1' });
  h.after('a', { sid: 's1', reply: '老回复' });
  for (let i = 1; i <= 3; i++) { await h.before('a', { text: `新话${i}`, sid: 's1' }); h.after('a', { sid: 's1', reply: `新回${i}` }); }
  clock.t += HOUR;
  const m = s.add('a', { text: '你好' });
  const srv = createServer({ cfg: { port: 0, hookToken: 'tok' }, store: s, hooks: h });
  const { port } = await srv.listen();
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, text: await r.text() };
  };
  const tok = { authorization: 'Bearer tok' };
  try {
    // server.mjs 里的每一条路由都走一遍（钩子四个时机也带上口令）
    const reqs = [
      ['GET', '/api/ping'], ['GET', '/api/memory/a'], ['GET', '/api/memory/a?q=' + encodeURIComponent('新话')], ['GET', '/api/memory/a?gone=1'],
      ['POST', '/api/memory/a', { text: '她新写的' }], ['POST', '/api/memory/a/recall', { text: OLD }], ['POST', '/api/memory/a/recall', { text: '新话3' }],
      ['GET', '/api/memory/a/log'], ['GET', '/api/memory/a/export'], ['GET', '/api/memory/a/cfg'], ['PUT', '/api/memory/a/cfg', { priv: true }],
      ['GET', '/api/memory/a/mood?about=' + encodeURIComponent('新话3'), null, tok], ['PATCH', `/api/memory/a/${m.id}`, { text: '改' }],
      ['DELETE', `/api/memory/a/${m.id}`], ['POST', `/api/memory/a/${m.id}/restore`], ['GET', '/api/state/a'],
      ['POST', '/api/hook/a/before', { text: '新话3' }, tok], ['POST', '/api/hook/a/after', { reply: '好' }, tok], ['POST', '/api/hook/a/compact', {}, tok],
      ['PUT', '/api/memory/a/lock', { pass: 'p' }], ['POST', '/api/memory/a/unlock', { pass: 'p' }],
      ['GET', '/api/talk/a'], ['GET', '/api/memory/a/talk'],
    ];
    for (const [method, p, body, hd] of reqs) {
      const r = await call(method, p, body, hd);
      assert.ok(!r.text.includes(OLD) && !r.text.includes('新回3'), `${method} ${p} 带出了对话原文`);
    }
    assert.equal((await call('GET', '/api/talk/a')).code, 404);
    // 开场：要口令；带的是最后三个来回，更早的不带
    assert.equal((await call('POST', '/api/hook/a/start', { source: 'startup' })).code, 401);
    const st = await call('POST', '/api/hook/a/start', { source: 'startup' }, tok);
    assert.ok(st.text.includes('新回3') && !st.text.includes(OLD));
  } finally { await srv.close(); }
});
