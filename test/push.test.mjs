// 推送：VAPID 钥匙、订阅、网页推送（加密和签名能解开、验得过）、失效订阅清掉、在前台不推、60 秒一次、Bark（明文和加密）。
// 推送服务、Bark 一律是这个测试进程里起的假 HTTP 服务，不发外网请求。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { openStore } from '../lib/store.mjs';
import { createServer } from '../lib/server.mjs';
import { openSvc } from '../lib/svc.mjs';
import { openPush, PRESENCE_FRESH } from '../lib/push.mjs';

const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const b64u = (b) => Buffer.from(b).toString('base64url');

// 假的浏览器订阅：自己有一对 ECDH 钥匙和 auth，收到的推送能解开
function fakeBrowser(endpoint) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
  // 照 RFC 8291 解：salt(16) rs(4) idlen(1) 发件方公钥(65) 密文+tag
  function open(body) {
    const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
    const uaPub = ecdh.getPublicKey(), shared = ecdh.computeSecret(asPub);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    assert.equal(plain.at(-1), 2, '最后一段的分隔符是 2');
    return JSON.parse(plain.subarray(0, -1).toString('utf8'));
  }
  return { sub, open, rs: (body) => body.readUInt32BE(16) };
}

// 验 VAPID：authorization = vapid t=JWT, k=公钥；JWT 用这个公钥（ES256）验得过
function checkVapid(h, pub, aud) {
  const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(h || '');
  assert.ok(m, 'authorization 是 vapid 形状');
  assert.equal(m[2], pub);
  const [head, claims, sig] = m[1].split('.');
  const raw = Buffer.from(pub, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), '签名验得过');
  const c = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  assert.equal(c.aud, aud);
  assert.match(c.sub, /^(mailto:|https:)/);
  return c;
}

async function setup({ env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-push-')); dirs.push(dir);
  let t = Date.UTC(2026, 10, 18, 4);
  const clock = { add: (ms) => { t += ms; } }, now = () => t;
  const up = { seen: [], status: () => 201 };
  up.server = http.createServer((req, res) => {
    const c = []; req.on('data', (x) => c.push(x));
    req.on('end', () => { const r = { method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(c) }; up.seen.push(r); res.writeHead(up.status(r)); res.end(); });
  });
  await new Promise((ok) => up.server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${up.server.address().port}`;
  const store = openStore({ dir, now }), svc = openSvc({ dir });
  const logs = [];
  const mk = () => openPush({ dir, svc, env, now, nameOf: (ai) => (ai === 'o' ? '小O' : ai), log: (...a) => logs.push(a.join(' ')),
    okHost: (h) => h === '127.0.0.1', allowHttp: true });
  const push = mk();
  const srv = createServer({ cfg: { port: 0 }, store, svc, push });
  const { port } = await srv.listen();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 空 */ }
    return { status: r.status, json };
  };
  const close = async () => { await srv.close(); up.server.closeAllConnections(); await new Promise((ok) => up.server.close(ok)); };
  return { dir, svc, push, mk, up, base, call, close, clock, logs };
}

test('VAPID 钥匙：第一次要公钥时生成，存 push/vapid.json（600）；重开还是那一把；公钥是 65 字节未压缩点', async () => {
  const g = await setup();
  try {
    assert.ok(!fs.existsSync(path.join(g.dir, 'push', 'vapid.json')));
    const r = await g.call('GET', '/api/push/key');
    assert.equal(r.status, 200);
    const raw = Buffer.from(r.json.key, 'base64url');
    assert.deepEqual([raw.length, raw[0]], [65, 4]);
    const f = path.join(g.dir, 'push', 'vapid.json');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(g.mk().key().key, r.json.key);
    assert.equal((await g.call('GET', '/api/push/key')).json.key, r.json.key);
  } finally { await g.close(); }
});

test('订阅：只收推送服务的地址、钥匙要对；同一个地址只留一条；DELETE 用请求体或 ?endpoint= 都能删；文件 600', async () => {
  const g = await setup();
  try {
    const b = fakeBrowser(g.base + '/push/a');
    assert.equal((await g.call('POST', '/api/push/sub', { endpoint: 'http://example.com/x', keys: b.sub.keys })).status, 400);
    assert.equal((await g.call('POST', '/api/push/sub', { endpoint: 'file:///etc/passwd', keys: b.sub.keys })).status, 400);
    assert.equal((await g.call('POST', '/api/push/sub', { endpoint: b.sub.endpoint, keys: { p256dh: 'abc', auth: b.sub.keys.auth } })).status, 400);
    assert.equal((await g.call('POST', '/api/push/sub', { endpoint: b.sub.endpoint })).status, 400);
    let r = await g.call('POST', '/api/push/sub', b.sub);
    assert.deepEqual(r.json, { ok: true, n: 1 });
    r = await g.call('POST', '/api/push/sub', { sub: b.sub }); // 包一层也认，同一个地址不重复
    assert.equal(r.json.n, 1);
    assert.equal(fs.statSync(path.join(g.dir, 'push', 'subs.json')).mode & 0o777, 0o600);
    const c = fakeBrowser(g.base + '/push/c');
    await g.call('POST', '/api/push/sub', c.sub);
    assert.equal(g.push.subs().length, 2);
    r = await g.call('DELETE', '/api/push/sub', { endpoint: b.sub.endpoint });
    assert.deepEqual(r.json, { ok: true, removed: 1 });
    r = await g.call('DELETE', '/api/push/sub?endpoint=' + encodeURIComponent(c.sub.endpoint));
    assert.deepEqual(r.json, { ok: true, removed: 1 });
    assert.equal(g.push.subs().length, 0);
    // 默认的白名单：只认几家浏览器的推送服务
    const real = openPush({ dir: g.dir });
    assert.throws(() => real.addSub({ endpoint: g.base + '/x', keys: b.sub.keys }), /endpoint/);
    assert.throws(() => real.addSub({ endpoint: 'https://evil.example.com/push.apple.com', keys: b.sub.keys }), /endpoint/);
    assert.equal(real.addSub({ endpoint: 'https://web.push.apple.com/abc', keys: b.sub.keys }).ok, true);
  } finally { await g.close(); }
});

test('试一下：没订阅报 400；有订阅发出去，内容按 aes128gcm 加密、浏览器那边解得开，VAPID 签名验得过，带 TTL', async () => {
  const g = await setup({ env: { subject: 'mailto:me@example.org' } });
  try {
    assert.equal((await g.call('POST', '/api/push/test', {})).status, 400);
    const b = fakeBrowser(g.base + '/push/a');
    await g.call('POST', '/api/push/sub', b.sub);
    const r = await g.call('POST', '/api/push/test', { ai: 'o' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.route, r.json.web.sent, r.json.web.failed], ['web', 1, 0]);
    const s = g.up.seen.at(-1);
    assert.equal(s.url, '/push/a');
    assert.equal(s.headers['content-encoding'], 'aes128gcm');
    assert.ok(Number(s.headers.ttl) > 0);
    assert.equal(b.rs(s.raw), 4096);
    const msg = b.open(s.raw);
    assert.equal(msg.title, '小O 测试通知');
    assert.match(msg.body, /测试通知/);
    assert.equal(msg.url, '/?ai=o');
    const c = checkVapid(s.headers.authorization, (await g.call('GET', '/api/push/key')).json.key, g.base);
    assert.equal(c.sub, 'mailto:me@example.org');
    assert.ok(c.exp > Date.UTC(2026, 10, 18, 4) / 1000);
  } finally { await g.close(); }
});

test('推送服务回 404/410：订阅失效，删掉；回 500：记一笔，订阅留着', async () => {
  const g = await setup();
  try {
    const a = fakeBrowser(g.base + '/push/gone'), b = fakeBrowser(g.base + '/push/bad');
    await g.call('POST', '/api/push/sub', a.sub);
    await g.call('POST', '/api/push/sub', b.sub);
    g.up.status = (r) => (r.url === '/push/gone' ? 410 : 500);
    const r = await g.call('POST', '/api/push/test', {});
    assert.deepEqual([r.json.web.sent, r.json.web.failed, r.json.web.gone], [0, 1, 1]);
    assert.deepEqual(g.push.subs().map((x) => x.endpoint), [b.sub.endpoint]);
  } finally { await g.close(); }
});

test('网页在前台不推；报过「在看」超过一阵子当不在看；同一个 AI 同一类 60 秒只推一次；主动找她和回完分开算', async () => {
  const g = await setup();
  try {
    const b = fakeBrowser(g.base + '/push/a');
    await g.call('POST', '/api/push/sub', b.sub);
    const n0 = g.up.seen.length;
    assert.deepEqual((await g.call('POST', '/api/presence', { visible: true })).json, { ok: true });
    assert.deepEqual(await g.push.notify('o', { kind: 'reply', text: '回了' }), { skip: '在看' });
    g.clock.add(PRESENCE_FRESH + 1000); // 太久没报：当不在看了
    let r = await g.push.notify('o', { kind: 'reply', text: '  回了\n一句  ' });
    assert.equal(r.web.sent, 1);
    assert.deepEqual([b.open(g.up.seen.at(-1).raw).title, b.open(g.up.seen.at(-1).raw).body], ['小O', '回了 一句']);
    assert.deepEqual(await g.push.notify('o', { kind: 'reply', text: '又回了' }), { skip: '60 秒内推过' });
    r = await g.push.notify('o', { kind: 'wake', text: '' });
    assert.equal(r.web.sent, 1);
    assert.equal(b.open(g.up.seen.at(-1).raw).body, '找你');
    g.clock.add(61e3);
    await g.call('POST', '/api/presence', { visible: false });
    assert.equal((await g.push.notify('o', { kind: 'reply', text: 'x'.repeat(300) })).web.sent, 1);
    assert.equal([...b.open(g.up.seen.at(-1).raw).body].length, 120);
    assert.equal(g.up.seen.length - n0, 3);
  } finally { await g.close(); }
});

test('Bark：设置里填了设备钥匙就发（明文 JSON）；填了 32 位加密钥匙就 AES-256-CBC 加密，解开是原文；Key 不进日志', async () => {
  const g = await setup();
  try {
    g.svc.putPush({ route: 'bark', bark: { url: g.base, dev: 'DEVKEY-SEKRIT' } });
    assert.equal(g.svc.view().push.bark.hasDev, true);
    let r = await g.call('POST', '/api/push/test', { ai: 'o' });
    assert.equal(r.status, 200);
    assert.equal(r.json.bark.status, 201);
    let s = g.up.seen.at(-1);
    assert.equal(s.url, '/DEVKEY-SEKRIT');
    const j = JSON.parse(s.raw.toString('utf8'));
    assert.deepEqual([j.title, j.group], ['小O 测试通知', '小O']);
    assert.equal(r.json.web, undefined);
    // 加密
    const aes = 'A'.repeat(16) + 'b'.repeat(16);
    g.svc.putPush({ bark: { aes } });
    r = await g.call('POST', '/api/push/test', { ai: 'o' });
    s = g.up.seen.at(-1);
    assert.match(s.headers['content-type'], /x-www-form-urlencoded/);
    const q = new URLSearchParams(s.raw.toString('utf8'));
    assert.equal(q.get('iv').length, 16);
    const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(aes), Buffer.from(q.get('iv')));
    const plain = JSON.parse(Buffer.concat([d.update(Buffer.from(q.get('ciphertext'), 'base64')), d.final()]).toString('utf8'));
    assert.equal(plain.title, '小O 测试通知');
    // both：两边都发（网页这边没订阅就是 0 条）
    g.svc.putPush({ route: 'both' });
    r = await g.call('POST', '/api/push/test', {});
    assert.deepEqual([r.json.route, r.json.web.sent, r.json.bark.status], ['both', 0, 201]);
    for (const l of g.logs) { assert.ok(!l.includes('DEVKEY-SEKRIT')); assert.ok(!l.includes(aes)); }
  } finally { await g.close(); }
});

test('Bark：设置里没填就用 .env 的 BARK_URL；都没有时 route=bark 试一下报 400；Bark 挂了不抛错', async () => {
  const g = await setup({ env: { barkUrl: '' } });
  try {
    g.svc.putPush({ route: 'bark' });
    assert.equal((await g.call('POST', '/api/push/test', {})).status, 400);
  } finally { await g.close(); }
  const h = await setup();
  try {
    const p = openPush({ dir: h.dir, svc: h.svc, env: { barkUrl: h.base + '/ENVDEV/' }, now: () => 0 });
    h.svc.putPush({ route: 'bark' });
    const r = await p.test({});
    assert.equal(r.bark.status, 201);
    assert.equal(h.up.seen.at(-1).url, '/ENVDEV');
    const dead = openPush({ dir: h.dir, svc: null, env: { barkUrl: 'http://127.0.0.1:1/x' } });
    assert.deepEqual(await dead.sendBark({ title: 't', body: 'b' }), { status: 0 });
  } finally { await h.close(); }
});

test('没传 push：这几个地址回 404', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-push-')); dirs.push(dir);
  const srv = createServer({ cfg: { port: 0 }, store: openStore({ dir }) });
  const { port } = await srv.listen();
  try {
    for (const [m, p] of [['GET', '/api/push/key'], ['POST', '/api/push/sub'], ['POST', '/api/push/test'], ['POST', '/api/presence']]) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'GET' ? undefined : '{}' });
      assert.equal(r.status, 404, p);
    }
  } finally { await srv.close(); }
});
