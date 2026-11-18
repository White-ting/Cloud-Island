// 网页口令（可选）：.env 里写了 WEB_PASSWORD，网页和 /api/* 都要先登录；不写的话只有这台电脑自己能用（lib/server.mjs 管）。
// - 没登录打开网页：回一个极简的登录页（这里自己发，单文件，不引外面的东西）。没登录调 /api/*：401 { error, login: true }。
// - POST /api/login { password }：对了发一个签名的 cookie（HttpOnly、SameSite=Strict，30 天），错了记一次失败。
//   限速是渐进的：同一个来源头 3 次随便错，之后每错一次要等的时间翻倍（1 秒、2 秒、4 秒……最多 15 分钟），等的时候回 429。
//   所有来源加起来 10 分钟里错超过 30 次（像是有人在到处试），每个来源从第 1 次错起就开始等；不会把全站锁死，没错过的来源照样能登录。
//   一个来源最后一次错过了 1 小时，记录就清掉。
// - 「来源」默认是连进来的那个地址。前面有隧道、反代（它们连进来的地址都一样）时，在 .env 的 TRUST_PROXY 写上它们的地址，
//   才从 X-Forwarded-For 里取真正的来源；没写就不信这个头（谁都能伪造）。
// - POST /api/logout：清掉 cookie，并把这个 cookie 记进撤销表（DATA_DIR/auth-revoked.json）：复制走的同一个 cookie 也不能再用了。
// - cookie = v2.到期时间.会话编号（随机）.HMAC（密钥是 SESSION_SECRET，没写就启动时随机一个：重启后要重新登录）。
//   签名里掺了口令的摘要：改了口令，旧的 cookie 一起作废。
// - HOOK_TOKEN 不能当网页登录用：钩子那几个地址自己验口令（lib/server.mjs 里标了 hook 的路由），别的地址只认 cookie。网关 /gw/ 有自己的口令。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const COOKIE = 'yd_s';
const DAYS = 30;
const WIN = 10 * 60e3, ALL = 30, FREE = 3, MAX_WAIT = 15 * 60e3, FORGET = 60 * 60e3, KEEP = 5000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');
function same(a, b) { const x = sha(a), y = sha(b); return crypto.timingSafeEqual(x, y); } // 先取摘要，长度一样才比得了，也不漏长度
const plainIp = (s) => String(s || '').trim().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1').replace(/^\[|\]$/g, '');

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// cfg：{ webPassword, sessionSecret, cookieSecure, dir（放撤销表，不给就只记在内存里）, trustProxy（信得过的代理地址，数组或逗号隔开） }；now 可以注入（测试用）
export function makeAuth({ webPassword = '', sessionSecret = '', cookieSecure = false, now = Date.now, dir = '', trustProxy = [] } = {}) {
  const on = !!webPassword;
  const secret = sessionSecret || crypto.randomBytes(32).toString('hex');
  const pwTag = b64u(sha('pw:' + webPassword)).slice(0, 16);
  const sign = (exp, sid) => b64u(crypto.createHmac('sha256', secret).update(`v2.${exp}.${sid}.${pwTag}`).digest());
  function token() { const exp = now() + DAYS * 864e5, sid = b64u(crypto.randomBytes(16)); return `v2.${exp}.${sid}.${sign(exp, sid)}`; }

  // ---- 撤销表：{ 会话编号: 到期时间 }，过期的顺手清掉 ----
  const revFile = dir ? path.join(dir, 'auth-revoked.json') : '';
  let revoked = {};
  if (revFile) { try { const o = JSON.parse(fs.readFileSync(revFile, 'utf8')); if (o && typeof o === 'object' && !Array.isArray(o)) revoked = o; } catch { /* 还没有 */ } }
  function revoke(sid, exp) {
    const t = now();
    for (const [k, e] of Object.entries(revoked)) if (!(e > t)) delete revoked[k];
    revoked[sid] = exp;
    if (!revFile) return true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(revFile + '.tmp', JSON.stringify(revoked), { mode: 0o600 });
      fs.renameSync(revFile + '.tmp', revFile);
      return true;
    } catch { return false; } // 写不下：内存里还记着、重启前照样作废，但不能说重启后也作废
  }
  function parse(v) {
    const m = /^v2\.(\d{10,16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(String(v || ''));
    if (!m || Number(m[1]) <= now()) return null;
    const want = Buffer.from(sign(m[1], m[2])), got = Buffer.from(m[3]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    if (Object.hasOwn(revoked, m[2])) return null;
    return { exp: Number(m[1]), sid: m[2] };
  }
  const valid = (v) => !!parse(v);
  // 这个请求是不是登录了的网页（没开口令时由 server 另外管：只许这台电脑自己）
  const ok = (req) => on && valid(cookies(req)[COOKIE]);

  // ---- 来源：信得过的代理后面才看 X-Forwarded-For（从右往左，跳过代理自己，第一个就是真正的来源）----
  const trusted = new Set((Array.isArray(trustProxy) ? trustProxy : String(trustProxy || '').split(/[,\s]+/)).map(plainIp).filter(Boolean));
  const isTrustedProxy = (req) => trusted.has(plainIp(req.socket?.remoteAddress)); // 连进来的是 TRUST_PROXY 里写的隧道、反代
  function from(req) {
    const remote = plainIp(req.socket?.remoteAddress) || '?';
    if (!trusted.has(remote)) return remote;
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(plainIp).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) if (!trusted.has(hops[i])) return hops[i];
    return remote;
  }

  // ---- 失败退避 ----
  const recs = new Map(); // 来源 → { n: 错了几次, last: 最后一次 }
  let all = [], swept = 0;
  function sweep() {
    const t = now();
    all = all.filter((x) => t - x < WIN);
    if (t - swept < 60e3 && recs.size < KEEP) return;
    swept = t;
    for (const [k, r] of recs) if (t - r.last > FORGET) recs.delete(k);
    while (recs.size > KEEP) recs.delete(recs.keys().next().value); // 太多了：最久没动的先丢
  }
  const delay = (n, free) => (n < free ? 0 : Math.min(MAX_WAIT, 1000 * 2 ** (n - free)));
  function wait(ip) {
    sweep();
    const r = recs.get(ip);
    if (!r) return 0;
    return Math.max(0, r.last + delay(r.n, all.length > ALL ? 1 : FREE) - now());
  }
  function miss(ip) {
    const t = now(), r = recs.get(ip) || { n: 0, last: t };
    recs.delete(ip); recs.set(ip, { n: r.n + 1, last: t }); // 删了再放：Map 的顺序就是「最近动过的在后面」
    all.push(t);
    if (all.length > ALL + 1) all.shift(); // 全局只看窗口里是不是超过 ALL 次，多留没用
  }

  const secure = (req) => cookieSecure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const setCookie = (req, v, age) => `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure(req) ? '; Secure' : ''}`;

  // 登录：回 [状态码, 返回体, 额外的头]
  function login(req, body = {}) {
    if (!on) return [200, { ok: true, off: true }, {}];
    const ip = from(req);
    const w = wait(ip);
    if (w > 0) { const sec = Math.ceil(w / 1000); return [429, { error: `错太多次了，等 ${sec} 秒再试` }, { 'retry-after': String(sec) }]; }
    const pw = typeof body.password === 'string' ? body.password : '';
    if (!pw || !same(pw, webPassword)) { miss(ip); return [401, { error: '口令不对' }, {}]; }
    recs.delete(ip);
    return [200, { ok: true }, { 'set-cookie': setCookie(req, token(), DAYS * 86400) }];
  }
  // 退出：清 cookie；这个 cookie 记进撤销表（别处复制的同一个也作废）
  function logout(req) {
    const c = parse(cookies(req)[COOKIE]);
    const headers = { 'set-cookie': setCookie(req, '', 0) };
    if (c && !revoke(c.sid, c.exp)) return [503, { error: '这台手机已经退出了，但撤销记录没存下来：后端重启后，复制走的旧登录可能还能用。要彻底作废，换一个 SESSION_SECRET' }, headers];
    return [200, { ok: true }, headers];
  }

  return { on, ok, login, logout, valid, token, from, isTrustedProxy };
}

// 没登录时打开网页看到的那一页：单文件，中文，跟着系统深浅色
export const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>登录</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--fg:#222;--sub:#777;--line:#ddd;--acc:#3a6ea5;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#18191b;--card:#232427;--fg:#eee;--sub:#999;--line:#3a3b3f;--acc:#8ab4f8;--err:#f28b82}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif;display:flex;align-items:center;justify-content:center;padding:16px}
form{width:100%;max-width:320px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px 20px}
h1{font-size:18px;font-weight:600;margin:0 0 4px}p{margin:0 0 16px;color:var(--sub);font-size:14px}
input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg)}
input:focus{outline:2px solid var(--acc);outline-offset:1px}
button{width:100%;margin-top:12px;font:inherit;padding:10px;border:0;border-radius:10px;background:var(--acc);color:#fff;cursor:pointer}
button:disabled{opacity:.6}
#m{min-height:1.5em;margin:10px 0 0;color:var(--err);font-size:14px}
</style></head><body>
<form id="f" autocomplete="on">
<h1>要先登录</h1><p>输入网页口令（写在后端 .env 的 WEB_PASSWORD）</p>
<input id="p" type="password" name="password" autocomplete="current-password" placeholder="口令" required autofocus>
<button id="b" type="submit">进去</button>
<div id="m" role="alert"></div>
</form>
<script>
document.getElementById('f').addEventListener('submit', async function (e) {
  e.preventDefault();
  var b = document.getElementById('b'), m = document.getElementById('m');
  b.disabled = true; m.textContent = '';
  try {
    var r = await fetch('api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('p').value }) });
    var j = await r.json().catch(function () { return {}; });
    if (r.ok) { location.reload(); return; }
    m.textContent = j.error || ('没进去（' + r.status + '）');
  } catch (err) { m.textContent = '连不上后端'; }
  b.disabled = false;
});
</script>
</body></html>
`;
