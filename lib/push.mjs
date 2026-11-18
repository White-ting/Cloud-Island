// 推送：网页推送（Web Push）和 Bark（可选）。只用 node:crypto，不装别的。写法参考作者另一个私用项目。
//
// 网页推送：VAPID 签名（RFC 8292，ES256）+ 内容加密 aes128gcm（RFC 8291）。
//   VAPID 钥匙第一次用到时生成，存 data/push/vapid.json（600）；订阅存 data/push/subs.json（600），所有 AI 共用（一台设备一条）。
//   只往这几家推送服务的地址发（防有人拿订阅接口让后端去敲别的地址）：苹果、谷歌、火狐、微软。
//   推送服务回 404 / 410 说明订阅失效了，删掉。每条只发一次，不重试。
// Bark：设置里「推送」的 Bark 那几格（服务器、设备钥匙、加密钥匙），没填就看 .env 的 BARK_URL（带设备钥匙的完整地址）、BARK_AES。
//   填了加密钥匙（32 位）：整段用 AES-256-CBC 加密成 ciphertext，每条随机一个 16 位 iv（照 Bark 官方的加密推送）。
// 推送走哪边：设置里的 push.route（web / bark / both，默认 web）。
// 什么时候推：TA 主动找她（onWake）、她发一句以后网页不在前台时 TA 回完（onReply）。
//   网页在前台（POST /api/presence { visible: true }，PRESENCE_FRESH 以内报过）就不推；同一个 AI 同一类 60 秒内只推一次。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './store.mjs';

export const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];
const GAP = 60e3;
export const PRESENCE_FRESH = 75e3; // 前台的网页每 30 秒左右报一次「在看」；这么久没报就当不在看
const SUBS_MAX = 20;
const WAIT = 10e3;

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
function writePrivate(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f + '.tmp', data, { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
  try { fs.chmodSync(f, 0o600); } catch { /* 换名后权限跟着 tmp，这里再保险一次 */ }
}

// ---- 加密（RFC 8291）：回整个请求体 ----
export function encrypt(sub, plaintext) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const eph = crypto.createECDH('prime256v1');
  eph.generateKeys();
  const asPub = eph.getPublicKey();             // 65 字节，未压缩
  const shared = eph.computeSecret(uaPub);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), c.final(), c.getAuthTag()]); // 2 = 最后一段，不加填充
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, body]);
}

// ---- VAPID（RFC 8292） ----
export function vapidAuth(v, endpoint, subject, now = Date.now) {
  const u = new URL(endpoint);
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: `${u.protocol}//${u.host}`, exp: Math.floor(now() / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: v.jwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }); // r||s 各 32 字节
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${v.pub}`;
}

// Bark 加密推送：AES-256-CBC，钥匙 32 位、iv 16 位（都按字面当字节）
export function barkCipher(json, aes, iv) {
  const c = crypto.createCipheriv('aes-256-cbc', Buffer.from(aes, 'utf8'), Buffer.from(iv, 'utf8'));
  return Buffer.concat([c.update(Buffer.from(json, 'utf8')), c.final()]).toString('base64');
}
const IV_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const randIv = () => Array.from(crypto.randomBytes(16), (x) => IV_ABC[x % IV_ABC.length]).join('');

// svc：lib/svc.mjs；env：{ subject, barkUrl, barkAes }；nameOf(ai) → 显示的名字
// okHost(主机名) → 能不能往这个推送服务发（测试里换成认本机）；allowHttp 只给测试用
export function openPush({ dir, svc = null, env = {}, nameOf = (ai) => ai, fetchFn = fetch, log = () => {}, now = Date.now,
  okHost = (h) => PUSH_HOSTS.some((x) => h === x || h.endsWith('.' + x)), allowHttp = false } = {}) {
  const base = () => path.join(dir, 'push');
  const vapidFile = () => path.join(base(), 'vapid.json'), subsFile = () => path.join(base(), 'subs.json');
  const subject = env.subject || 'mailto:push@example.com';
  let vapid = null;
  function keys() {
    if (vapid) return vapid;
    try { const v = JSON.parse(fs.readFileSync(vapidFile(), 'utf8')); if (v?.pub && v?.jwk?.d) return (vapid = v); } catch { /* 还没有 */ }
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    vapid = { pub: b64u(raw), jwk, t: now() };
    writePrivate(vapidFile(), JSON.stringify(vapid));
    log('推送', '第一次用，生成了 VAPID 钥匙');
    return vapid;
  }
  const key = () => ({ key: keys().pub });

  // ---- 订阅 ----
  function subs() { try { const a = JSON.parse(fs.readFileSync(subsFile(), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
  const saveSubs = (a) => writePrivate(subsFile(), JSON.stringify(a, null, 1));
  function checkEp(ep) {
    let u; try { u = new URL(String(ep || '')); } catch { return false; }
    return (u.protocol === 'https:' || (allowHttp && u.protocol === 'http:')) && !u.username && !u.password && okHost(u.hostname);
  }
  function addSub(body = {}) {
    const s = body.sub || body.subscription || body;
    const ep = String(s?.endpoint || ''), k = s?.keys || {};
    if (!checkEp(ep)) throw fail(400, '订阅信息不对：endpoint 要是浏览器推送服务的 https 地址');
    const p = String(k.p256dh || ''), a = String(k.auth || '');
    if (!/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(p) || unb64u(p).length !== 65 || !/^[A-Za-z0-9_-]{16,32}={0,2}$/.test(a)) throw fail(400, '订阅信息不对：keys.p256dh、keys.auth 不对');
    keys(); // 第一次订阅时就把钥匙生成好
    const list = subs().filter((x) => x.endpoint !== ep);
    list.push({ endpoint: ep, keys: { p256dh: p.replace(/=+$/, ''), auth: a.replace(/=+$/, '') }, since: now() });
    saveSubs(list.slice(-SUBS_MAX));
    log('推送', '登记了一台设备：', new URL(ep).hostname);
    return { ok: true, n: Math.min(list.length, SUBS_MAX) };
  }
  function delSub(ep) {
    const list = subs(), left = list.filter((x) => x.endpoint !== String(ep || ''));
    if (left.length !== list.length) saveSubs(left);
    return { ok: true, removed: list.length - left.length };
  }

  // ---- 在不在看 ----
  let seen = { visible: false, t: 0 };
  function presence(body = {}) { seen = { visible: body.visible === true, t: now() }; return { ok: true }; }
  const watching = () => seen.visible && now() - seen.t < PRESENCE_FRESH;

  // ---- 发 ----
  async function sendWeb(payload, urgency = 'normal') {
    const list = subs(), gone = [];
    let sent = 0, failed = 0;
    if (!list.length) return { sent, failed, gone: 0 };
    const v = keys(), data = JSON.stringify(payload);
    await Promise.all(list.map(async (s) => {
      const host = (() => { try { return new URL(s.endpoint).hostname; } catch { return '?'; } })();
      try {
        const r = await fetchFn(s.endpoint, { method: 'POST', body: encrypt(s, data), signal: AbortSignal.timeout(WAIT),
          headers: { authorization: vapidAuth(v, s.endpoint, subject, now), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '3600', urgency } });
        if (r.ok) { sent++; return; }
        if (r.status === 404 || r.status === 410) { gone.push(s.endpoint); log('推送', '订阅失效了，删掉：', host, r.status); return; }
        failed++; log('推送', '没推出去：', host, r.status);
      } catch (e) { failed++; log('推送', '没推出去：', host, e.name); }
    }));
    if (gone.length) saveSubs(subs().filter((x) => !gone.includes(x.endpoint)));
    return { sent, failed, gone: gone.length };
  }
  function barkConf() {
    let b = {};
    try { b = svc?.read().push?.bark || {}; } catch { b = {}; }
    if (b.dev) return { url: String(b.url || 'https://api.day.app').replace(/\/+$/, '') + '/' + encodeURIComponent(b.dev), aes: b.aes || '' };
    if (env.barkUrl) return { url: String(env.barkUrl).replace(/\/+$/, ''), aes: env.barkAes || '' };
    return null;
  }
  async function sendBark({ title, body, group }) {
    const c = barkConf();
    if (!c) return { skip: '没配 Bark' };
    const payload = { title, body, group: group || '通知', level: 'active' };
    let opt;
    if (c.aes) {
      if (c.aes.length !== 32) return { skip: 'Bark 加密钥匙要 32 位' };
      const iv = randIv();
      opt = { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `ciphertext=${encodeURIComponent(barkCipher(JSON.stringify(payload), c.aes, iv))}&iv=${iv}` };
    } else opt = { headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) };
    try {
      const r = await fetchFn(c.url, { method: 'POST', ...opt, signal: AbortSignal.timeout(WAIT) });
      if (!r.ok) log('推送', 'Bark 没发出去：', r.status);
      return { status: r.status };
    } catch (e) { log('推送', 'Bark 没发出去：', e.name); return { status: 0 }; }
  }
  const route = () => { try { return svc?.read().push?.route || 'web'; } catch { return 'web'; } };

  // 推一条。kind：wake（TA 主动找她）、reply（回完了）、test。force：不看在不在前台、不看 60 秒
  const last = new Map();
  async function notify(ai, { kind = 'reply', text = '', force = false } = {}) {
    if (!force) {
      if (watching()) return { skip: '在看' };
      const k = ai + '\n' + kind, t = now();
      if (t - (last.get(k) || 0) < GAP) return { skip: '60 秒内推过' };
      last.set(k, t);
    }
    const name = ai ? nameOf(ai) || ai : '', r = route();
    const title = kind === 'test' ? (name ? `${name} 测试通知` : '测试通知') : name || '新消息';
    const body = [...String(text || '').replace(/\s+/g, ' ').trim()].slice(0, 120).join('') || (kind === 'wake' ? '找你' : '回复了');
    const out = {};
    if (r === 'bark' || r === 'both') out.bark = await sendBark({ title, body, group: name });
    if (r === 'web' || r === 'both') out.web = await sendWeb({ title, body, tag: `${ai}-${kind}`, url: `/?ai=${encodeURIComponent(ai)}`, ai, kind });
    return out;
  }
  // 试一下：所有订阅的设备 + Bark（按推送走哪边）都发一条
  async function test(body = {}) {
    const ai = typeof body.ai === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(body.ai) ? body.ai : '';
    const r = route();
    if ((r === 'web' || r === 'both') && !subs().length && !(r === 'both' && barkConf())) throw fail(400, '这台设备还没开通知（没有订阅）');
    if (r === 'bark' && !barkConf()) throw fail(400, 'Bark 还没配好');
    const out = await notify(ai, { kind: 'test', text: '这是一条测试通知，收到就说明锁屏也能收到。', force: true });
    return { ok: true, route: r, ...out };
  }

  return { key, addSub, delSub, subs, presence, watching, notify, test, sendWeb, sendBark };
}
