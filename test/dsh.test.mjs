// dsh 的 TA：用 test/fixtures/fake-dsh.mjs 当 dsh（照协议回固定的东西），不需要装真的 dsh、不连模型。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDsh, cleanDsh, fixHomePatch, pubDsh } from '../lib/dsh.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-dsh.mjs');
const SECRET = 'SEKRIT-dsh-k3y-1a2b3c4d5e'; // 假 key：只许出现在 dsh 进程的环境里，不许出现在返回、数据文件里
const FAST = { stop: 300, eof: 300, term: 300, req: 5000, start: 10000 };
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
// 假 dsh 写日志跟测试读日志是两个进程：机器忙时最后一行可能还没落盘，要比的先等它写进来（最多 3 秒）
async function until(f, ms = 3000) { const t0 = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t0 > ms) return v; await new Promise((r) => setTimeout(r, 20)); } }
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yd-dsh-')); dirs.push(d); return d; }

// 一套：数据目录、dsh home、工作目录、一个 TA 的设置
function setup({ limits = {}, dsh = {} } = {}) {
  const root = tmp();
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  const conf = cleanDsh({ id: 'd', name: '小 d', kind: 'dsh', dsh: { home: path.join(root, 'home'), workspace: ws, bin: FAKE, keyEnv: 'FAKE_KEY', env: { EXTRA: 'e1' }, ...dsh } });
  const logs = [];
  const m = openDsh({ dir: path.join(root, 'data'), keyOf: (k) => (k === 'FAKE_KEY' ? SECRET : ''), log: (...a) => logs.push(a.join(' ')), limits: { ...FAST, ...limits } });
  const fakeLog = () => { try { return fs.readFileSync(path.join(conf.dsh.home, 'fake-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { root, conf, m, logs, fakeLog };
}

// 假的 http 回应：收 SSE 的 data 行，能等某个事件
function fakeRes() {
  const ev = [], waiters = [];
  let endOk;
  const ended = new Promise((ok) => { endOk = ok; });
  const res = {
    writableEnded: false, destroyed: false, headersSent: false, status: null,
    writeHead(s) { this.status = s; this.headersSent = true; },
    flushHeaders() {},
    write(s) {
      for (const l of String(s).split('\n')) {
        if (!l.startsWith('data: ')) continue;
        const o = JSON.parse(l.slice(6));
        ev.push(o);
        for (const w of [...waiters]) if (w.pred(o)) { waiters.splice(waiters.indexOf(w), 1); w.ok(o); }
      }
    },
    end() { this.writableEnded = true; endOk(); },
  };
  const waitFor = (pred, ms = 5000) => {
    const hit = ev.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((ok, no) => {
      const w = { pred, ok: (o) => { clearTimeout(h); ok(o); } };
      const h = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); no(new Error('等不到事件，已收到：' + JSON.stringify(ev))); }, ms);
      waiters.push(w);
    });
  };
  return { res, ev, ended, waitFor };
}

// 发一句：返回 SSE 事件、存下来的字段
async function say(m, conf, text, { job = { stopped: false, abort() {} }, during } = {}) {
  const r = fakeRes(), saved = [];
  const p = m.answer(conf.id, conf, r.res, job, { me: 'me1', text, save: (f) => { saved.push(f); return 'a' + saved.length; } });
  if (during) await during(r, job);
  await p;
  await r.ended;
  return { ev: r.ev, saved, done: r.ev.at(-1) };
}

test('设置：默认 workspace-write、profile sdk；key 不许写进 providers；home 不能在工作目录里', () => {
  const a = cleanDsh({ id: 'x', kind: 'dsh', dsh: { home: '/a/home', workspace: '/a/ws' } });
  assert.equal(a.dsh.permission, 'workspace-write');
  assert.equal(a.dsh.profile, 'sdk');
  assert.equal(a.dsh.bin, 'dsh');
  assert.deepEqual(pubDsh(a), { id: 'x', kind: 'dsh', model: 'deepseek-v4-flash', notes: false, permission: 'workspace-write' });
  assert.throws(() => cleanDsh({ id: 'x', dsh: { home: '/a/ws/h', workspace: '/a/ws' } }), /不能放在/);
  assert.throws(() => cleanDsh({ id: 'x', dsh: { home: 'rel', workspace: '/a/ws' } }), /绝对路径/);
  assert.throws(() => cleanDsh({ id: 'x', dsh: { home: '/h', workspace: '/w', permission: 'all' } }), /permission/);
  assert.throws(() => cleanDsh({ id: 'x', dsh: { home: '/h', workspace: '/w', providers: { sf: { apiKey: SECRET } } } }), (e) => /apiKeyEnv/.test(e.message) && !e.message.includes(SECRET));
  assert.throws(() => cleanDsh({ id: 'x', dsh: { home: '/h', workspace: '/w', keyEnv: 'HOOK_TOKEN' } }), /不能用/);
  assert.throws(() => cleanDsh({ id: 'x', dsh: { home: '/h', workspace: '/w', env: { DSH_HOME: '/x' } } }), /不能写/);
  const b = cleanDsh({ id: 'y', dsh: { home: '/h', workspace: '/w', providers: { sf: { baseUrl: 'https://x/v1', apiKeyEnv: 'SF_KEY' } }, keyEnv: ['SF_KEY'] } });
  assert.deepEqual(b.dsh.keyEnv, ['SF_KEY']);
});

test('日志上传：home 的补丁里补上关掉的那段，重复跑不变；她自己写的留着；uploadLog 时只拿掉我们那段', () => {
  const home = tmp(), f = path.join(home, 'cordis.patch.yml');
  assert.equal(fixHomePatch(home), true);
  assert.match(fs.readFileSync(f, 'utf8'), /- id: session-log-deepseek\n {2}config:\n {4}enabled: false/);
  assert.equal(fixHomePatch(home), false);
  fs.writeFileSync(f, '- id: some-plugin\n  config:\n    a: 1\n');
  assert.equal(fixHomePatch(home), true);
  const s = fs.readFileSync(f, 'utf8');
  assert.match(s, /some-plugin/);
  assert.match(s, /session-log-deepseek/);
  assert.equal(fixHomePatch(home, false), true);
  assert.equal(fs.readFileSync(f, 'utf8'), '- id: some-plugin\n  config:\n    a: 1\n');
  fs.writeFileSync(f, '[{ id: x }]\n');
  assert.throws(() => fixHomePatch(home), (e) => e.code === 503);
});

test('启动 + 发话：懒启动、握手、回执先到也认、思考和正文流式、存下来；第二句复用进程和会话', async () => {
  process.env.HOOK_TOKEN = 'hook-should-not-pass';
  process.env.SOMETHING_ELSE = 'nope';
  const { conf, m, fakeLog } = setup();
  try {
    const r1 = await say(m, conf, '你好');
    assert.deepEqual(r1.ev[0], { type: 'status', state: 'starting' });
    assert.ok(r1.ev.some((e) => e.type === 'think' && e.text === '她在打招呼'));
    assert.ok(r1.ev.some((e) => e.type === 'delta' && e.text === '你好呀，我是假的 dsh。'));
    assert.deepEqual(r1.done, { type: 'done', id: 'a1', me: 'me1' });
    assert.equal(r1.saved[0].text, '你好呀，我是假的 dsh。');
    assert.equal(r1.saved[0].think, '她在打招呼');
    assert.match(r1.saved[0].dsh.session, /^yd-d-/);

    const boot = fakeLog().find((x) => x.boot).boot;
    assert.deepEqual(boot.argv.slice(0, 2), ['--profile', 'sdk']);
    assert.equal(boot.argv[2], '--patch');
    assert.equal(boot.cwd, fs.realpathSync(conf.dsh.workspace));
    assert.equal(boot.env.DSH_HOME, conf.dsh.home);
    assert.equal(boot.env.DSH_PERMISSION_MODE, 'workspace-write');
    assert.equal(boot.env.DSH_TELEMETRY_DISABLED, '1');
    assert.equal(boot.env.FAKE_KEY, SECRET);
    assert.equal(boot.env.EXTRA, 'e1');
    assert.equal(boot.env.HOOK_TOKEN, undefined);
    assert.equal(boot.env.SOMETHING_ELSE, undefined);
    assert.match(fs.readFileSync(boot.argv[3], 'utf8'), /session-log-deepseek/);
    assert.match(fs.readFileSync(path.join(conf.dsh.home, 'cordis.patch.yml'), 'utf8'), /enabled: false/);
    const init = fakeLog().find((x) => x.req === 'initialize').params;
    assert.equal(init.approvalRequests, true);
    assert.equal(init.cwd, conf.dsh.workspace);

    const r2 = await say(m, conf, '随便说点');
    assert.ok(!r2.ev.some((e) => e.type === 'status'));
    assert.equal(r2.saved[0].text, '收到：随便说点');
    assert.equal(fakeLog().filter((x) => x.boot).length, 1);
    const ps = fakeLog().filter((x) => x.prompt);
    assert.equal(ps[0].prompt.sid, ps[1].prompt.sid);
    assert.equal(fakeLog().filter((x) => x.req === 'session/resume').length, 0);
    assert.deepEqual(m.state('d'), { kind: 'dsh', session: ps[0].prompt.sid, used: true, alive: true, busy: false });

    // 多步：说一句、跑工具、再说一句
    const r3 = await say(m, conf, '多步');
    const st = r3.ev.find((e) => e.type === 'step');
    assert.deepEqual(st, { type: 'step', i: 0, kind: 'tool', name: 'bash', input: { command: 'ls' } });
    assert.deepEqual(r3.ev.find((e) => e.type === 'step_end'), { type: 'step_end', i: 0, ok: true, out: 'a.txt' });
    assert.equal(r3.saved[0].text, '第一步\n\n第二步');
    assert.equal(r3.saved[0].steps[0].out, 'a.txt');
  } finally {
    delete process.env.HOOK_TOKEN;
    delete process.env.SOMETHING_ELSE;
    await m.closeAll();
  }
});

test('确认：发给前端、允许了 dsh 收到 allowed-once；拒绝收到 rejected；没答超时当拒绝', async () => {
  const { conf, m, fakeLog } = setup({ limits: { approvalMs: 400 } });
  try {
    const r1 = await say(m, conf, '建文件', { during: async (r) => {
      const a = await r.waitFor((e) => e.type === 'approval');
      assert.equal(a.tool, 'write');
      assert.equal(a.reason, '要在工作区写 a.txt');
      assert.deepEqual(a.input, { path: 'a.txt', content: 'hi' });
      assert.equal(a.i, 0);
      assert.equal(a.timeout, 400);
      const pend = m.pending('d').items;
      assert.equal(pend.length, 1);
      assert.equal(pend[0].id, a.id);
      assert.deepEqual(m.approve('d', a.id, true), { ok: true, outcome: 'allowed' });
      assert.throws(() => m.approve('d', a.id, true), (e) => e.code === 404); // 答过了
    } });
    assert.ok(r1.ev.some((e) => e.type === 'approval_end' && e.outcome === 'allowed'));
    assert.equal(r1.saved[0].text, '建好了。');
    assert.equal(r1.saved[0].steps[0].approval, 'allowed');
    assert.equal(r1.saved[0].steps[0].ok, true);

    const r2 = await say(m, conf, '建文件', { during: async (r) => {
      const a = await r.waitFor((e) => e.type === 'approval');
      m.approve('d', a.id, false);
    } });
    assert.ok(r2.ev.some((e) => e.type === 'approval_end' && e.outcome === 'rejected'));
    assert.equal(r2.saved[0].text, '好，不建了。');
    assert.equal(r2.saved[0].steps[0].ok, false);

    const r3 = await say(m, conf, '建文件'); // 不答
    assert.ok(r3.ev.some((e) => e.type === 'approval_end' && e.outcome === 'timeout'));
    assert.equal(r3.saved[0].text, '好，不建了。');
    await until(() => fakeLog().filter((x) => x.approval).length >= 3);
    assert.deepEqual(fakeLog().filter((x) => x.approval).map((x) => x.approval.outcome), ['allowed-once', 'rejected', 'rejected']);
    assert.deepEqual(m.pending('d').items, []);
  } finally { await m.closeAll(); }
});

test('停：说到一半按停，存下已说的（cut）、关掉进程；下一句重新拉起、接回原来的会话', async () => {
  const { conf, m, fakeLog } = setup();
  try {
    const job = { stopped: false, abort() {} };
    const r1 = await say(m, conf, '慢慢说', { job, during: async (r, j) => {
      await r.waitFor((e) => e.type === 'delta');
      j.abort();
    } });
    assert.deepEqual(r1.done, { type: 'done', id: 'a1', me: 'me1', cut: true });
    assert.equal(r1.saved[0].text, '我先说一半');
    assert.equal(r1.saved[0].cut, true);
    assert.ok(await until(() => fakeLog().some((x) => x.req === 'shutdown')));
    assert.equal(m.state('d').alive, false);

    const r2 = await say(m, conf, '你好');
    assert.equal(r2.saved[0].text, '你好呀，我是假的 dsh。');
    await until(() => fakeLog().filter((x) => x.prompt).length >= 2);
    assert.equal(fakeLog().filter((x) => x.boot).length, 2);
    const ps = fakeLog().filter((x) => x.prompt);
    const resume = fakeLog().find((x) => x.req === 'session/resume');
    assert.equal(resume.params.sessionId, ps[0].prompt.sid);
    assert.equal(ps[1].prompt.sid, ps[0].prompt.sid);

    // 不经过 chat 的停：stop(ai)
    const r = fakeRes();
    const p = m.answer('d', conf, r.res, { stopped: false }, { me: 'me2', text: '慢慢说', save: () => 'a9' });
    await r.waitFor((e) => e.type === 'delta');
    assert.equal(m.busy('d'), true);
    assert.deepEqual(await m.stop('d'), { ok: true, stopped: true });
    await p;
    assert.equal(r.ev.at(-1).cut, true);
    assert.deepEqual(await m.stop('d'), { ok: true, stopped: false });
  } finally { await m.closeAll(); }
});

test('进程挂了：这一句报错，下一句重新拉起、接回会话', async () => {
  const { conf, m, fakeLog, logs } = setup();
  try {
    await say(m, conf, '你好');
    const r1 = await say(m, conf, '崩');
    assert.equal(r1.done.type, 'error');
    assert.match(r1.done.msg, /退出/);
    assert.ok(logs.some((l) => /退出码 3/.test(l)));
    const r2 = await say(m, conf, '你好');
    assert.equal(r2.done.type, 'done');
    assert.equal(fakeLog().filter((x) => x.boot).length, 2);
    assert.equal(fakeLog().filter((x) => x.req === 'session/resume').length, 1);
  } finally { await m.closeAll(); }
});

test('出错的一轮报错；新会话换编号、不再 resume；dsh 找不到时说清楚；key 不出现在返回和数据里', async () => {
  const { root, conf, m, fakeLog } = setup();
  try {
    const r1 = await say(m, conf, '出错');
    assert.equal(r1.done.type, 'error');
    assert.match(r1.done.msg, /模型出错了/);
    const old = m.state('d').session;
    const n = m.reset('d');
    assert.notEqual(n.session, old);
    const r2 = await say(m, conf, '你好');
    assert.equal(r2.saved[0].dsh.session, n.session);
    assert.equal(fakeLog().filter((x) => x.prompt).at(-1).prompt.sid, n.session);
    assert.equal(fakeLog().filter((x) => x.req === 'session/resume').length, 0);

    // 没配 key、工作目录没建、bin 不存在：ready 先拦
    const m2 = openDsh({ dir: path.join(root, 'd2'), keyOf: () => '' });
    assert.throws(() => m2.ready(conf), (e) => e.code === 503 && /FAKE_KEY/.test(e.message));
    assert.throws(() => m.ready({ ...conf, dsh: { ...conf.dsh, workspace: path.join(root, 'nope') } }), /工作目录不存在/);
    assert.throws(() => m.ready({ ...conf, dsh: { ...conf.dsh, bin: path.join(root, 'no-dsh') } }), /找不到/);
    // 命令名在 PATH 里找不到：这一句报错
    const c3 = cleanDsh({ id: 'e', dsh: { home: path.join(root, 'h3'), workspace: conf.dsh.workspace, bin: 'no-such-dsh-cmd-xyz' } });
    const r3 = await say(m, c3, '你好');
    assert.equal(r3.done.type, 'error');
    assert.match(r3.done.msg, /找不到 dsh/);

    // 同一个 home 不许两个 TA 一起用
    const c4 = { ...conf, id: 'd4' };
    const r4 = await say(m, c4, '你好');
    assert.equal(r4.done.type, 'error');
    assert.equal(r4.done.status, 409);

    // key 只在 dsh 进程环境里：返回和数据目录里都没有
    const all = JSON.stringify([r1, r2, r3, r4]);
    assert.ok(!all.includes(SECRET));
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]));
    for (const f of walk(path.join(root, 'data'))) assert.ok(!fs.readFileSync(f, 'utf8').includes(SECRET), f);
    for (const f of walk(conf.dsh.home).filter((f) => !f.endsWith('fake-log.jsonl'))) assert.ok(!fs.readFileSync(f, 'utf8').includes(SECRET), f);
  } finally { await m.closeAll(); }
});
