// 网页口令：没设时跟以前一样；设了以后网页回登录页、接口 401、登录发 cookie、错多了限速、钩子带 HOOK_TOKEN 照样进
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { createServer } from '../lib/server.mjs';
import { makeHooks } from '../lib/hooks.mjs';
import { makeAuth, COOKIE } from '../lib/auth.mjs';

const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function setup(cfgMore = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-auth-')); dirs.push(dir);
  const web = path.join(dir, 'web'); fs.mkdirSync(web);
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>页面</title>');
  fs.writeFileSync(path.join(web, 'app.js'), 'console.log(1)');
  const store = openStore({ dir });
  const hooks = makeHooks({ store });
  const srv = createServer({ cfg: { port: 0, hookToken: 'hook-tok', webDir: web, ...cfgMore }, store, hooks });
  const { port } = await srv.listen();
  const call = async (method, p, { body, headers = {} } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 网页 */ }
    return { status: r.status, text, json, headers: r.headers };
  };
  return { call, close: () => srv.close() };
}

test('没设网页口令：网页和接口跟以前一样不验', async () => {
  const g = await setup();
  try {
    assert.equal((await g.call('GET', '/')).text, '<!doctype html><title>页面</title>');
    assert.equal((await g.call('GET', '/api/memory/a')).status, 200);
    const r = await g.call('POST', '/api/login', { body: { password: 'x' } });
    assert.deepEqual(r.json, { ok: true, off: true });
    assert.equal((await g.call('GET', '/api/ping')).json.login, undefined);
  } finally { await g.close(); }
});

test('设了口令：页面回登录页，接口 401；登录对了发 HttpOnly + SameSite=Strict 的 cookie，带上就进得去', async () => {
  const g = await setup({ webPassword: 'open sesame' });
  try {
    let r = await g.call('GET', '/');
    assert.equal(r.status, 401);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.text, /要先登录/);
    assert.ok(!r.text.includes('页面'));
    r = await g.call('GET', '/app.js');
    assert.equal(r.status, 401);
    assert.ok(!r.text.includes('console'));
    r = await g.call('GET', '/api/memory/a');
    assert.deepEqual([r.status, r.json.login], [401, true]);
    assert.equal((await g.call('POST', '/api/memory/a', { body: { text: 'x' } })).status, 401);
    assert.deepEqual((await g.call('GET', '/api/ping')).json, { ok: true, name: 'cloud-island', login: true });

    r = await g.call('POST', '/api/login', { body: { password: 'wrong' } });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('set-cookie'), null);
    r = await g.call('POST', '/api/login', { body: { password: 'open sesame' } });
    assert.equal(r.status, 200);
    const sc = r.headers.get('set-cookie');
    assert.match(sc, new RegExp(`^${COOKIE}=\\d+\\.[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000$`));
    const cookie = sc.split(';')[0];
    assert.equal((await g.call('GET', '/', { headers: { cookie } })).text, '<!doctype html><title>页面</title>');
    assert.equal((await g.call('GET', '/api/memory/a', { headers: { cookie } })).status, 200);
    // 改一个字就不认
    const bad = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A');
    assert.equal((await g.call('GET', '/api/memory/a', { headers: { cookie: bad } })).status, 401);
    // 退出：cookie 清掉
    r = await g.call('POST', '/api/logout', { headers: { cookie } });
    assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  } finally { await g.close(); }
});

test('设了口令：钩子带对了 HOOK_TOKEN 照样进（那些地址自己照旧验口令）；带错的不行', async () => {
  const g = await setup({ webPassword: 'pw' });
  try {
    let r = await g.call('POST', '/api/hook/a/start', { body: {}, headers: { authorization: 'Bearer hook-tok' } });
    assert.equal(r.status, 200);
    r = await g.call('POST', '/api/hook/a/start', { body: {}, headers: { authorization: 'Bearer nope' } });
    assert.equal(r.status, 401);
    assert.equal(r.json.login, true);
  } finally { await g.close(); }
});

test('登录限速：同一个来源错 5 次就锁 10 分钟，这时对的也进不去；时间过了再试', async () => {
  const g = await setup({ webPassword: 'pw' });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await g.call('POST', '/api/login', { body: { password: 'x' + i } })).status, 401);
    const r = await g.call('POST', '/api/login', { body: { password: 'pw' } });
    assert.equal(r.status, 429);
    assert.match(r.json.error, /10 分钟/);
  } finally { await g.close(); }
  // 时间往后拨（直接测 makeAuth）
  let t = 1e12;
  const a = makeAuth({ webPassword: 'pw', now: () => t });
  const req = { socket: { remoteAddress: '1.2.3.4' }, headers: {} };
  for (let i = 0; i < 5; i++) assert.equal(a.login(req, { password: 'no' })[0], 401);
  assert.equal(a.login(req, { password: 'pw' })[0], 429);
  t += 10 * 60e3 + 1;
  assert.equal(a.login(req, { password: 'pw' })[0], 200);
  // 别的来源不受影响；所有来源加起来错 30 次才全锁
  const b = makeAuth({ webPassword: 'pw', now: () => t });
  for (let i = 0; i < 30; i++) b.login({ socket: { remoteAddress: '10.0.0.' + i }, headers: {} }, { password: 'no' });
  assert.equal(b.login({ socket: { remoteAddress: '9.9.9.9' }, headers: {} }, { password: 'pw' })[0], 429);
});

test('cookie：过期的不认；改了口令旧的作废；SESSION_SECRET 一样就跨重启认；https 后面加 Secure', () => {
  let t = 1e12;
  const a = makeAuth({ webPassword: 'pw', sessionSecret: 's1', now: () => t });
  const tok = a.token();
  assert.ok(a.valid(tok));
  assert.ok(makeAuth({ webPassword: 'pw', sessionSecret: 's1', now: () => t }).valid(tok));
  assert.ok(!makeAuth({ webPassword: 'pw2', sessionSecret: 's1', now: () => t }).valid(tok));
  assert.ok(!makeAuth({ webPassword: 'pw', sessionSecret: 's2', now: () => t }).valid(tok));
  t += 31 * 864e5;
  assert.ok(!a.valid(tok));
  const [, , h] = a.login({ socket: {}, headers: { 'x-forwarded-proto': 'https' } }, { password: 'pw' });
  assert.match(h['set-cookie'], /; Secure$/);
  assert.equal(a.login({ socket: {}, headers: {} }, {})[0], 401);
});
