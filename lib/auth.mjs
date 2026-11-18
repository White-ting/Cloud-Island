// 网页口令（可选）：.env 里写了 WEB_PASSWORD，网页和 /api/* 都要先登录；不写就跟以前一样不验（只听本机、前面另有一道门）。
// - 没登录打开网页：回一个极简的登录页（这里自己发，单文件，不引外面的东西）。没登录调 /api/*：401 { error, login: true }。
// - POST /api/login { password }：对了发一个签名的 cookie（HttpOnly、SameSite=Strict，30 天），错了记一次失败；
//   同一个来源 10 分钟里错 5 次（或者所有来源加起来错 30 次）就先锁到这 10 分钟过完，回 429。
// - POST /api/logout：清掉 cookie。
// - cookie = 到期时间 + HMAC（密钥是 SESSION_SECRET，没写就启动时随机一个：重启后要重新登录）。
//   签名里掺了口令的摘要：改了口令，旧的 cookie 一起作废。
// - 钩子、守门人那些本来就带 HOOK_TOKEN 的请求：带对了口令就不要 cookie（那些地址自己照旧验口令）。网关 /gw/ 有自己的口令，不经过这里。
import crypto from 'node:crypto';

export const COOKIE = 'yd_s';
const DAYS = 30;
const WIN = 10 * 60e3, PER_IP = 5, ALL = 30;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');
function same(a, b) { const x = sha(a), y = sha(b); return crypto.timingSafeEqual(x, y); } // 先取摘要，长度一样才比得了，也不漏长度

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// cfg：{ webPassword, sessionSecret, hookToken, cookieSecure }；now 可以注入（测试用）
export function makeAuth({ webPassword = '', sessionSecret = '', hookToken = '', cookieSecure = false, now = Date.now } = {}) {
  const on = !!webPassword;
  const secret = sessionSecret || crypto.randomBytes(32).toString('hex');
  const pwTag = b64u(sha('pw:' + webPassword)).slice(0, 16);
  const sign = (exp) => b64u(crypto.createHmac('sha256', secret).update(`v1.${exp}.${pwTag}`).digest());
  function token() { const exp = now() + DAYS * 864e5; return `${exp}.${sign(exp)}`; }
  function valid(v) {
    const m = /^(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(String(v || ''));
    if (!m || Number(m[1]) < now()) return false;
    const want = Buffer.from(sign(m[1])), got = Buffer.from(m[2]);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }
  function hasHook(req) {
    if (!hookToken) return false;
    const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return !!got && same(got, hookToken);
  }
  // 这个请求放不放过（没开口令一律放过）
  const ok = (req) => !on || valid(cookies(req)[COOKIE]) || hasHook(req);

  // ---- 失败限速 ----
  const fails = new Map(); // 来源 → [时间…]
  let all = [];
  const from = (req) => String(req.socket?.remoteAddress || '?');
  function locked(ip) {
    const t = now();
    all = all.filter((x) => t - x < WIN);
    const mine = (fails.get(ip) || []).filter((x) => t - x < WIN);
    if (mine.length) fails.set(ip, mine); else fails.delete(ip);
    return mine.length >= PER_IP || all.length >= ALL;
  }
  function miss(ip) { const t = now(); fails.set(ip, [...(fails.get(ip) || []), t]); all.push(t); }

  const secure = (req) => cookieSecure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const setCookie = (req, v, age) => `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure(req) ? '; Secure' : ''}`;

  // 登录：回 [状态码, 返回体, 额外的头]
  function login(req, body = {}) {
    if (!on) return [200, { ok: true, off: true }, {}];
    const ip = from(req);
    if (locked(ip)) return [429, { error: '错太多次了，过 10 分钟再试' }, {}];
    const pw = typeof body.password === 'string' ? body.password : '';
    if (!pw || !same(pw, webPassword)) { miss(ip); return [401, { error: '口令不对' }, {}]; }
    fails.delete(ip);
    return [200, { ok: true }, { 'set-cookie': setCookie(req, token(), DAYS * 86400) }];
  }
  const logout = (req) => [200, { ok: true }, { 'set-cookie': setCookie(req, '', 0) }];

  return { on, ok, login, logout, valid, token };
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
