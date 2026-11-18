// 网页口令：没设时只许本机；设了以后网页回登录页、接口 401、登录发 cookie、错多了渐进退避、钩子带 HOOK_TOKEN 只进钩子的地址。
// 还有：Host 白名单、会改东西的请求查 Origin 和 Content-Type、坏请求不把后端带走、网页文件不跟链接出去、退出撤销
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { openStore } from '../lib/store.mjs';
import { createServer } from '../lib/server.mjs';
import { makeHooks } from '../lib/hooks.mjs';
import { makeAuth, COOKIE } from '../lib/auth.mjs';

const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function setup(cfgMore = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-auth-')); dirs.push(dir);
  const web = path.join(dir, 'web'), data = path.join(dir, 'data'); fs.mkdirSync(web); fs.mkdirSync(data);
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>页面</title>');
  fs.writeFileSync(path.join(web, 'app.js'), 'console.log(1)');
  const store = openStore({ dir: data });
  const hooks = makeHooks({ store });
  const srv = createServer({ cfg: { port: 0, hookToken: 'hook-tok', webDir: web, dataDir: data, ...cfgMore }, store, hooks });
  const { port } = await srv.listen();
  // 自己写 Host、Origin 这些头（fetch 不让改 Host）
  const raw = (method, p, { headers = {}, body } = {}) => new Promise((ok, no) => {
    const rq = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: '127.0.0.1:' + port, ...headers } }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (c) => (t += c)); res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch { /* 网页 */ } ok({ status: res.statusCode, text: t, json, headers: res.headers }); });
    });
    rq.on('error', no); rq.end(body);
  });
  const call = async (method, p, { body, headers = {} } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 网页 */ }
    return { status: r.status, text, json, headers: r.headers };
  };
  return { call, raw, port, dir, web, data, close: () => srv.close() };
}

test('没设网页口令：这台电脑上（localhost / 127.0.0.1）照常用；用白名单里的别的名字打开（隧道、局域网）一律 403', async () => {
  const g = await setup({ allowedHosts: 'island.example.com' });
  try {
    assert.equal((await g.call('GET', '/')).text, '<!doctype html><title>页面</title>');
    assert.equal((await g.call('GET', '/api/memory/a')).status, 200);
    const r = await g.call('POST', '/api/login', { body: { password: 'x' } });
    assert.deepEqual(r.json, { ok: true, off: true });
    assert.equal((await g.call('GET', '/api/ping')).json.login, undefined);
    assert.equal((await g.raw('GET', '/api/memory/a', { headers: { host: 'localhost:' + g.port } })).status, 200);
    let x = await g.raw('GET', '/api/memory/a', { headers: { host: 'island.example.com' } });
    assert.deepEqual([x.status, /WEB_PASSWORD/.test(x.json.error)], [403, true]);
    x = await g.raw('GET', '/', { headers: { host: 'island.example.com' } });
    assert.deepEqual([x.status, /text\/html/.test(x.headers['content-type']), x.text.includes('页面')], [403, true, false]);
    assert.equal((await g.raw('GET', '/api/ping', { headers: { host: 'island.example.com' } })).status, 200); // ping 不用登录
  } finally { await g.close(); }
});

test('Host 白名单：不认得的名字回 421（DNS 重绑定）；ALLOWED_HOSTS 里写了端口只认那个端口', async () => {
  const g = await setup({ allowedHosts: 'island.example.com, lan.example.com:8443', webPassword: 'pw' });
  try {
    for (const h of ['evil.example.com', 'evil.example.com:' + g.port, 'lan.example.com:9999', '127.0.0.1.evil.com', 'localhost.evil.com']) {
      const r = await g.raw('GET', '/api/ping', { headers: { host: h } });
      assert.equal(r.status, 421, h);
    }
    const page = await g.raw('GET', '/', { headers: { host: 'evil.example.com' } });
    assert.deepEqual([page.status, page.text.includes('ALLOWED_HOSTS'), page.text.includes('页面')], [421, true, false]);
    for (const h of ['island.example.com', 'ISLAND.example.com:443', 'lan.example.com:8443', 'localhost', '[::1]:' + g.port]) assert.equal((await g.raw('GET', '/api/ping', { headers: { host: h } })).status, 200, h);
    // 钩子和网关也一样先看 Host
    assert.equal((await g.raw('POST', '/api/hook/a/start', { headers: { host: 'evil.example.com', authorization: 'Bearer hook-tok', 'content-type': 'application/json' }, body: '{}' })).status, 421);
  } finally { await g.close(); }
});

test('会改东西的网页请求：Origin 要是同一个站、Sec-Fetch-Site 跨站的拦下；带请求体要是 JSON；钩子的地址不查这两样', async () => {
  const g = await setup();
  try {
    const H = { 'content-type': 'application/json' }, body = JSON.stringify({ text: 'x' });
    const me = 'http://127.0.0.1:' + g.port;
    assert.equal((await g.raw('POST', '/api/memory/a', { headers: { ...H, origin: 'https://evil.example' }, body })).status, 403);
    assert.equal((await g.raw('POST', '/api/memory/a', { headers: { ...H, origin: 'null' }, body })).status, 403);
    assert.equal((await g.raw('POST', '/api/memory/a', { headers: { ...H, 'sec-fetch-site': 'cross-site' }, body })).status, 403);
    assert.equal((await g.raw('POST', '/api/login', { headers: { ...H, origin: 'https://evil.example' }, body: '{}' })).status, 403);
    assert.equal((await g.raw('POST', '/api/memory/a', { headers: { ...H, origin: me, 'sec-fetch-site': 'same-origin' }, body })).status, 200);
    assert.equal((await g.raw('POST', '/api/memory/a', { headers: H, body })).status, 200); // 没带 Origin：不是浏览器
    // 11-19 sol 复审：同一台机器别的端口不算这个站；同站的别的子域（same-site）也拦；Host 白名单不当成能来改东西的名单
    assert.equal((await g.raw('POST', '/api/memory/a', { headers: { ...H, origin: 'http://127.0.0.1:1' }, body })).status, 403);
    assert.equal((await g.raw('POST', '/api/memory/a', { headers: { ...H, 'sec-fetch-site': 'same-site' }, body })).status, 403);
    assert.equal((await g.raw('POST', '/api/memory/a', { headers: { ...H, origin: 'http://localhost:' + g.port }, body })).status, 403);
    // 不是 JSON 的请求体：415（表单能跨站发 text/plain、x-www-form-urlencoded，不收）
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
      assert.equal((await g.raw('POST', '/api/memory/a', { headers: ct ? { 'content-type': ct } : {}, body })).status, 415, ct);
    }
    assert.equal((await g.raw('POST', '/api/memory/a', { headers: { 'content-type': 'application/json; charset=utf-8' }, body })).status, 200);
    // 没有请求体的（前端的 DELETE、停下这类）不用带 Content-Type
    assert.notEqual((await g.raw('DELETE', '/api/memory/a/nope')).status, 415);
    // 钩子：守门人可能不带 Content-Type、也可能从别的地方发，照样收（靠 HOOK_TOKEN）
    assert.equal((await g.raw('POST', '/api/hook/a/start', { headers: { authorization: 'Bearer hook-tok', origin: 'https://elsewhere.example' }, body: '{}' })).status, 200);
  } finally { await g.close(); }
});

test('坏请求：地址解析不了回 400，后端不倒，下一个请求照常', async () => {
  const g = await setup();
  try {
    const bad = (line) => new Promise((ok) => {
      const s = net.connect(g.port, '127.0.0.1', () => s.write(line + '\r\nHost: 127.0.0.1:' + g.port + '\r\nConnection: close\r\n\r\n'));
      let t = ''; s.on('data', (c) => (t += c)); s.on('close', () => ok(t)); s.on('error', () => ok(t));
    });
    assert.match(await bad('GET // HTTP/1.1'), /^HTTP\/1\.1 400/);
    assert.match(await bad('GET //[ HTTP/1.1'), /^HTTP\/1\.1 400/);
    assert.match(await bad('GET /api/chat/%E0%A4%A HTTP/1.1'), /^HTTP\/1\.1 (400|404)/);
    assert.equal((await g.call('GET', '/api/ping')).status, 200);
  } finally { await g.close(); }
});

test('网页文件：链接指到网页文件夹外面的不发；网页文件夹和数据文件夹重叠就不启动', async () => {
  const g = await setup();
  try {
    fs.writeFileSync(path.join(g.data, 'svc.json'), '{"secret":"x"}');
    fs.symlinkSync(path.join(g.data, 'svc.json'), path.join(g.web, 'leak.json'));
    assert.equal((await g.call('GET', '/leak.json')).status, 404);
    assert.equal((await g.call('GET', '/app.js')).text, 'console.log(1)');
    const r = await g.call('GET', '/app.js');
    assert.equal((await g.call('GET', '/app.js', { headers: { 'if-none-match': r.headers.get('etag') } })).status, 304);
    assert.equal((await g.call('HEAD', '/app.js')).status, 200);
  } finally { await g.close(); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-auth-')); dirs.push(dir);
  const store = openStore({ dir });
  assert.throws(() => createServer({ cfg: { port: 0, webDir: dir, dataDir: dir }, store }), /WEB_DIR/);
  assert.throws(() => createServer({ cfg: { port: 0, webDir: dir, dataDir: path.join(dir, 'data') }, store }), /WEB_DIR/);
  assert.throws(() => createServer({ cfg: { port: 0, webDir: path.join(dir, 'w'), dataDir: dir }, store }), /WEB_DIR/);
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
    assert.match(sc, new RegExp(`^${COOKIE}=v2\\.\\d+\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000$`));
    const cookie = sc.split(';')[0];
    assert.equal((await g.call('GET', '/', { headers: { cookie } })).text, '<!doctype html><title>页面</title>');
    assert.equal((await g.call('GET', '/api/memory/a', { headers: { cookie } })).status, 200);
    // 改一个字就不认
    const bad = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A');
    assert.equal((await g.call('GET', '/api/memory/a', { headers: { cookie: bad } })).status, 401);
    // 退出：cookie 清掉，而且这个 cookie 作废（别处复制的同一个也进不去了），撤销表记在数据文件夹里
    r = await g.call('POST', '/api/logout', { headers: { cookie } });
    assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await g.call('GET', '/api/memory/a', { headers: { cookie } })).status, 401);
    assert.ok(fs.existsSync(path.join(g.data, 'auth-revoked.json')));
    assert.equal(fs.statSync(path.join(g.data, 'auth-revoked.json')).mode & 0o777, 0o600);
  } finally { await g.close(); }
});

test('HOOK_TOKEN 只进钩子的地址：钩子带对了照样进、带错的不行；拿它当网页登录一律 401（改名单、发话、批确认都不行）', async () => {
  const g = await setup({ webPassword: 'pw' });
  try {
    const T = { authorization: 'Bearer hook-tok' };
    let r = await g.call('POST', '/api/hook/a/start', { body: {}, headers: T });
    assert.equal(r.status, 200);
    r = await g.call('POST', '/api/hook/a/start', { body: {}, headers: { authorization: 'Bearer nope' } });
    assert.equal(r.status, 401);
    assert.equal(r.json.login, undefined); // 钩子的地址：是口令不对，不是要登录
    for (const [m, p, body] of [['GET', '/api/memory/a'], ['PUT', '/api/ais', []], ['POST', '/api/chat/d/send', { text: 'x' }], ['POST', '/api/chat/d/approve', { id: 'ap1', allow: true }],
      ['GET', '/api/chat/d/approvals'], ['PUT', '/api/helper/a', { on: false }], ['GET', '/'], ['GET', '/app.js']]) {
      r = await g.call(m, p, { body, headers: T });
      assert.equal(r.status, 401, m + ' ' + p);
    }
  } finally { await g.close(); }
  const g2 = await setup(); // 没开口令：钩子的地址照样只认 HOOK_TOKEN
  try {
    assert.equal((await g2.call('POST', '/api/hook/a/start', { body: {} })).status, 401);
    assert.equal((await g2.call('POST', '/api/wake/a', { body: { why: 'x' } })).status, 401);
  } finally { await g2.close(); }
});

test('登录退避：头 3 次随便错，之后每次等的时间翻倍（等的时候对的也先不收）；等够了就能进；1 小时没再错就忘掉', async () => {
  const g = await setup({ webPassword: 'pw' });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await g.call('POST', '/api/login', { body: { password: 'x' + i } })).status, 401);
    const r = await g.call('POST', '/api/login', { body: { password: 'pw' } });
    assert.equal(r.status, 429);
    assert.match(r.json.error, /等 \d+ 秒/);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
  } finally { await g.close(); }
  // 时间往后拨（直接测 makeAuth）
  let t = 1e12;
  const a = makeAuth({ webPassword: 'pw', now: () => t });
  const req = { socket: { remoteAddress: '1.2.3.4' }, headers: {} };
  for (let i = 0; i < 3; i++) assert.equal(a.login(req, { password: 'no' })[0], 401);
  assert.equal(a.login(req, { password: 'pw' })[0], 429); // 要等 1 秒
  t += 1001;
  assert.equal(a.login(req, { password: 'no' })[0], 401); // 第 4 次错：要等 2 秒
  t += 1500;
  assert.equal(a.login(req, { password: 'pw' })[0], 429);
  t += 600;
  assert.equal(a.login(req, { password: 'pw' })[0], 200);
  // 等的时间有上限（15 分钟），不会锁死
  const c = makeAuth({ webPassword: 'pw', now: () => t });
  for (let i = 0; i < 40; i++) { c.login(req, { password: 'no' }); t += 16 * 60e3; }
  assert.equal(c.login(req, { password: 'pw' })[0], 200);
  // 别的来源不受影响；所有来源加起来错了很多次也不全站锁：没错过的来源照样一次就进
  const b = makeAuth({ webPassword: 'pw', now: () => t });
  for (let i = 0; i < 40; i++) b.login({ socket: { remoteAddress: '10.0.0.' + i }, headers: {} }, { password: 'no' });
  assert.equal(b.login({ socket: { remoteAddress: '9.9.9.9' }, headers: {} }, { password: 'pw' })[0], 200);
  // 这时候到处都有人在试：错过一次的来源马上就要等
  b.login({ socket: { remoteAddress: '8.8.8.8' }, headers: {} }, { password: 'no' });
  assert.equal(b.login({ socket: { remoteAddress: '8.8.8.8' }, headers: {} }, { password: 'pw' })[0], 429);
  // 1 小时以后忘掉
  t += 61 * 60e3;
  assert.equal(b.login({ socket: { remoteAddress: '10.0.0.1' }, headers: {} }, { password: 'pw' })[0], 200);
});

test('来源：只有 TRUST_PROXY 里的代理才看 X-Forwarded-For；隧道后面的两个人不会互相锁住；没写 TRUST_PROXY 就不信这个头', () => {
  let t = 1e12;
  const tunnel = (ip) => ({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-for': ip } });
  const a = makeAuth({ webPassword: 'pw', now: () => t, trustProxy: '127.0.0.1' });
  assert.equal(a.from(tunnel('203.0.113.5')), '203.0.113.5');
  assert.equal(a.from(tunnel('6.6.6.6, 203.0.113.5')), '203.0.113.5'); // 最右边那个是代理亲眼看到的；左边的谁都能写
  for (let i = 0; i < 5; i++) a.login(tunnel('203.0.113.5'), { password: 'no' });
  assert.equal(a.login(tunnel('203.0.113.5'), { password: 'pw' })[0], 429);
  assert.equal(a.login(tunnel('198.51.100.9'), { password: 'pw' })[0], 200);
  const b = makeAuth({ webPassword: 'pw', now: () => t });
  assert.equal(b.from(tunnel('203.0.113.5')), '127.0.0.1');
});

test('退出撤销：撤销表存在数据文件夹，重启（同一个 SESSION_SECRET）后旧 cookie 还是不认；没退出的照样认', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-auth-')); dirs.push(dir);
  const a = makeAuth({ webPassword: 'pw', sessionSecret: 's', dir });
  const t1 = a.token(), t2 = a.token();
  a.logout({ socket: {}, headers: { cookie: `${COOKIE}=${t1}` } });
  assert.ok(!a.valid(t1));
  const b = makeAuth({ webPassword: 'pw', sessionSecret: 's', dir });
  assert.ok(!b.valid(t1));
  assert.ok(b.valid(t2));
  assert.ok(!b.valid('1234567890123.' + 'A'.repeat(43))); // 旧格式（v1）不认：升级后要重新登录一次
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
