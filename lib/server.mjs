// 对外的地址。分三种：
// - 不用登录的：ping、登录、退出。
// - 钩子用的（路由上标了 hook）：只认 HOOK_TOKEN（Authorization: Bearer …），不认网页登录。只有这几个：钩子的四个时机和散场记、
//   TA 翻日记、心情、敲门、收件箱放东西、夜里手动跑一次、MCP。HOOK_TOKEN 在别的地址上一律不算数（改不了名单、发不了 dsh 的话、批不了确认）。
// - 别的都是网页用的：.env 写了 WEB_PASSWORD 就要先登录（lib/auth.mjs）；没写的话只许这台电脑自己用（连进来的是本机、地址也是 localhost 这类）。
// 每个请求先看 Host：只认本机的名字、HOST 设的地址和 .env 的 ALLOWED_HOSTS（防 DNS 重绑定：别的网站把自己的域名解析到你电脑上）。
// 网页用的、会改东西的请求（POST、PUT、PATCH、DELETE）：浏览器带了 Origin 就要是同一个站；带请求体的要是 application/json（上传文件、录音那几个除外）。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fail } from './store.mjs';
import { makeGateway } from './gateway.mjs';
import { importPersona } from './persona.mjs';
import { makeAuth, LOGIN_PAGE } from './auth.mjs';
import { NOFOLLOW } from './files.mjs';

const MAX_BODY = 1024 * 1024;
const BIG = { max: 5 * 1024 * 1024 }; // 人格导入（带卡的 PNG）放宽到 5 MB
const SSE = { max: 32 * 1024 * 1024, sse: true }; // 聊天发一句：可能带 base64 的图；回的是 SSE，处理函数自己写回复
const OWN = { sse: true };
const RAW = { sse: true, raw: true }; // 请求体是文件本身：处理函数自己读、自己回 // 处理函数自己写回复（MCP：202 空着、JSON-RPC）
const H = { hook: true };             // 钩子用的：只认 HOOK_TOKEN（处理函数里 bearer(req) 验），不走网页登录、不查 Origin 和 Content-Type
const HOWN = { sse: true, hook: true };
// 网页（可选，.env 里写了 WEB_DIR 才发）：只发这个文件夹里第一层的这几种文件，/ 发 WEB_INDEX。跟接口同一个地址，网页就不用跨域
const WEB_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const inside = (a, b) => { const r = path.relative(b, a); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); }; // a 在 b 里面（或就是 b）
// 真实路径：还不存在的就找最近一层存在的上级，再接上后面那段（macOS 的 /var 其实是 /private/var，要比得对）
function real(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { const up = path.dirname(abs); return up === abs ? abs : path.join(real(up), path.basename(abs)); }
}
// 网页文件：名字只许第一层；真实路径（顺着链接走到底）也得在网页文件夹里；用打开的那个文件描述符读，不再按名字找第二遍
function webFile(cfg, root, pathname) {
  if (!root || /^\/(api|gw|mcp)(\/|$)/.test(pathname)) return null;
  let name; try { name = decodeURIComponent(pathname.slice(1)); } catch { return null; }
  if (!name) name = cfg.webIndex || 'index.html';
  if (!/^[\w\u4e00-\u9fff][\w\u4e00-\u9fff.-]*$/.test(name) || name.includes('..')) return null; // 只要第一层的文件，不许带斜杠、不许点开头
  const type = WEB_TYPES[path.extname(name).toLowerCase()]; if (!type) return null;
  let fd = null;
  try {
    const f = fs.realpathSync(path.join(root, name));
    if (!inside(f, root)) return null;
    if (!fs.lstatSync(f).isFile()) return null;
    fd = fs.openSync(f, NOFOLLOW | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) { fs.closeSync(fd); return null; }
    return { fd, type, size: st.size, etag: `W/"${st.size}-${Math.floor(st.mtimeMs)}"` };
  } catch { if (fd != null) try { fs.closeSync(fd); } catch { /* 已经关了 */ } return null; }
}
// 网页文件夹和数据文件夹不能重叠：不然网页就能把 svc.json 这类文件当静态文件发出去。回网页文件夹的真实路径（没开网页回空）
export function checkDirs(cfg) {
  const webRoot = cfg.webDir ? real(cfg.webDir) : '';
  if (webRoot && cfg.dataDir) {
    const d = real(cfg.dataDir);
    if (inside(webRoot, d) || inside(d, webRoot)) throw new Error('WEB_DIR 和 DATA_DIR 不能是同一个文件夹，也不能一个放在另一个里面：改一下 .env');
  }
  return webRoot;
}
// Host 头 → { name, port }（IPv6 去掉方括号，都转小写）
function hostOf(h) {
  const m = /^(\[[^\]]+\]|[^:\[\]]+)(?::(\d{1,5}))?$/.exec(String(h || '').trim().toLowerCase());
  return m ? { name: m[1].replace(/^\[|\]$/g, '').replace(/\.$/, ''), port: m[2] || '' } : null;
}
const LOCAL_NAMES = ['localhost', '127.0.0.1', '::1'];
const isLoop = (ip) => { const s = String(ip || '').replace(/^::ffff:/i, ''); return s === '::1' || /^127\./.test(s); };
const cut = (s, n) => [...String(s ?? '').trim()].slice(0, n).join('');
const json = (res, code, obj, extra = {}) => {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s), ...extra });
  res.end(s);
};
// 没登录也能用的：登录、退出、ping（网页靠它认出后端）
const OPEN = /^\/api\/(login|logout|ping)$/;

// 敲门（POST /api/wake/{ai}）带来的东西：只留认得的几项。why 是 idle 的算「空下来」，别的算外面的事
function wakeItem(body = {}) {
  if (body.why != null && typeof body.why !== 'string') throw fail(400, 'why 要是一句话');
  if (body.brief != null && typeof body.brief !== 'string') throw fail(400, 'brief 要是一段文字');
  const kind = body.why === 'idle' ? 'idle' : 'knock';
  const b = { ...(body.why ? { why: cut(body.why, 100) } : {}), ...(body.brief ? { brief: cut(body.brief, 4000) } : {}),
    ...(Number.isFinite(Number(body.ts)) && body.ts != null ? { ts: Number(body.ts) } : {}), ...(body.care === true ? { care: true } : {}) };
  if (kind === 'knock' && !b.why && !b.brief) throw fail(400, '要写 why 或 brief：为什么叫醒');
  // 去重编号：来源给了 key 就用它；没给就用 ts（守门人重发同一次敲门时一样）
  const key = body.key != null && body.key !== '' ? String(body.key) : b.ts ? 'ts:' + b.ts : undefined;
  return { kind, key, body: b };
}

function readJson(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { reject(fail(413, '内容太大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!n) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(fail(400, '不是合法的 JSON')); }
    });
    req.on('error', reject);
  });
}

// persona、night、dreams、chat：lib/persona.mjs、lib/night.mjs、lib/dreams.mjs、lib/chat.mjs，没传的那一块地址回 404
// inbox、knock、mcp：lib/inbox.mjs、lib/knock.mjs、lib/mcp.mjs 的 makeMcp(…)，同样没传就 404
// digest、diary、pat、helper：待整理、日记、拍一拍、旁听的小模型（lib/digest.mjs、diary.mjs、pat.mjs、helper.mjs），同样没传就 404
// lockwords、voice、push：开屏字幕、声音（出声和认字）、推送（lib/lockwords.mjs、voice.mjs、push.mjs），同样没传就 404
export function createServer({ cfg, store, hooks, persona = null, night = null, dreams = null, chat = null, inbox = null, knock = null, mcp = null,
  digest = null, diary = null, pat = null, helper = null, svc = null, files = null, translate = null, lockwords = null, voice = null, push = null, log = () => {} }) {
  const auth = makeAuth({ webPassword: cfg.webPassword, sessionSecret: cfg.sessionSecret, cookieSecure: cfg.cookieSecure, now: cfg.authNow,
    dir: cfg.dataDir || '', trustProxy: cfg.trustProxy || [] });
  const webRoot = checkDirs(cfg);
  // ---- Host 白名单：本机的名字（任何端口）、HOST 设的地址（设成 0.0.0.0 / :: 时是这台电脑现在的所有地址）、ALLOWED_HOSTS ----
  const extra = (Array.isArray(cfg.allowedHosts) ? cfg.allowedHosts : String(cfg.allowedHosts || '').split(/[,\s]+/)).map(hostOf).filter(Boolean);
  let names = null, namesAt = 0;
  function hostNames() {
    if (names && Date.now() - namesAt < 30e3) return names; // 网卡地址会变（比如 Tailscale 后连上）：半分钟重查一次
    const set = new Set(LOCAL_NAMES), h = String(cfg.host || '127.0.0.1').toLowerCase().replace(/^\[|\]$/g, '');
    if (!h || h === '0.0.0.0' || h === '::') { for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) set.add(String(a.address).toLowerCase().replace(/%.*$/, '')); }
    else set.add(h);
    names = set; namesAt = Date.now();
    return set;
  }
  const hostOk = (v) => { const h = hostOf(v); return !!h && (hostNames().has(h.name) || extra.some((e) => e.name === h.name && (!e.port || e.port === h.port))); };
  // 会改东西的网页请求：浏览器说了是跨站／同站别的子域（Sec-Fetch-Site），一律拦；带了 Origin，主机和端口要跟这次请求的 Host 一模一样。
  // Host 白名单只管「这个名字能不能打开」，不当成「这些站能来改东西」（11-19 sol 复审）。
  // 协议（http/https）不比：经隧道、反代进来时后端看到的是 http，比了会把正常用的人全拦下；冒充同一个主机名的 http 站本来就做不到。
  // 没带 Origin、也没带 Sec-Fetch-Site 的当不是浏览器发的（浏览器发 POST、PUT、PATCH、DELETE 都会带 Origin）。
  function originOk(req) {
    const sf = req.headers['sec-fetch-site'];
    if (sf && sf !== 'same-origin' && sf !== 'none') return false;
    const o = req.headers.origin;
    if (o == null) return true;
    let u; try { u = new URL(String(o)); } catch { return false; } // Origin: null 也在这里拦下
    if (!/^https?:$/.test(u.protocol)) return false;
    const want = hostOf(req.headers.host), got = hostOf(u.host);
    return !!want && !!got && want.name === got.name && (want.port || '') === (got.port || '');
  }
  const hasBody = (req) => !!req.headers['transfer-encoding'] || (req.headers['content-length'] != null && req.headers['content-length'] !== '0');
  const isJson = (req) => /^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''));
  // 没设网页口令时：只许这台电脑自己（连进来的是本机，Host 也是 localhost / 127.0.0.1 / ::1）。隧道、局域网、Tailscale 都要先设口令
  // 隧道、反代也是从本机连进来的，它们要是把 Host 改成了 localhost 就分不出来；写进 TRUST_PROXY 的就不算本机（所以用隧道一定要设口令）
  const localOnly = (req) => { const h = hostOf(req.headers.host); return !auth.isTrustedProxy(req) && isLoop(req.socket?.remoteAddress) && !!h && LOCAL_NAMES.includes(h.name); };
  function bearer(req) {
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(got), b = Buffer.from(cfg.hookToken || '');
    if (!b.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw fail(401, '口令不对');
  }

  const need = (x) => { if (!x) throw fail(404, '没有这个地址'); return x; };
  const unlockTok = (req) => req.headers['x-mem-unlock'];

  // [方法, 路径的正则, 处理函数(捕获到的…, { req, body, url }), { max: 请求体上限 }?]
  const routes = [
    ['GET', /^\/api\/ping$/, () => ({ ok: true, name: 'cloud-island', ...(auth.on ? { login: true } : {}) })], // name：网页靠它认出「这是我的后端」（别的服务也可能有 /api/ping）；login：开了网页口令
    // 网页口令（没开时登录直接回 ok）：对了发 cookie
    ['POST', /^\/api\/login$/, ({ req, res, body }) => { const [code, out, h] = auth.login(req, body); json(res, code, out, h); }, { sse: true, max: 4096 }],
    ['POST', /^\/api\/logout$/, ({ req, res }) => { const [code, out, h] = auth.logout(req); json(res, code, out, h); }, { sse: true, max: 4096 }],
    ['GET', /^\/api\/memory\/([^/]+)$/, (ai, { url }) => store.list(ai, { q: url.searchParams.get('q') || '', after: url.searchParams.get('after'), gone: url.searchParams.get('gone') === '1' })],
    ['POST', /^\/api\/memory\/([^/]+)$/, (ai, { body }) => store.add(ai, body, 'me')],
    ['POST', /^\/api\/memory\/([^/]+)\/unlock$/, (ai, { body }) => store.unlock(ai, body.pass)],
    ['PUT', /^\/api\/memory\/([^/]+)\/lock$/, (ai, { body }) => store.setLock(ai, body)],
    ['POST', /^\/api\/memory\/([^/]+)\/recall$/, async (ai, { body }) => ({ items: await store.recallAsync(ai, body.text, body.k || 5, { who: 'me' }) })],
    ['GET', /^\/api\/memory\/([^/]+)\/log$/, (ai) => store.readLog(ai)],
    // 导出是整库备份：记忆（不带私人念想）之外，日记（私人段不带，只给个数）和待整理各单独一项，不混进 items。
    // 待整理带正文和她的更正（她收走的不带）：导出的文件本来就交到她手里，不带正文就恢复不了
    ['GET', /^\/api\/memory\/([^/]+)\/export$/, (ai) => ({ ...store.exportAll(ai), ...(diary ? { diary: diary.exportAll(ai) } : {}), ...(digest ? { digest: digest.exportAll(ai) } : {}) })],
    // 导入：旧的导出文件没有 diary、digest 这两项，照样能导
    ['POST', /^\/api\/memory\/([^/]+)\/import$/, (ai, { body }) => {
      const r = store.importAll(ai, body);
      if (diary && body?.diary !== undefined) r.diary = diary.importAll(ai, body.diary);
      if (digest && body?.digest !== undefined) r.digest = digest.importAll(ai, body.digest);
      return r;
    }, BIG], // 带上日记和待整理以后可能超过 1 MB
    ['GET', /^\/api\/memory\/([^/]+)\/cfg$/, (ai) => store.getCfg(ai)],
    ['PUT', /^\/api\/memory\/([^/]+)\/cfg$/, (ai, { body }) => store.setCfg(ai, body)],
    ['GET', /^\/api\/memory\/([^/]+)\/mood$/, (ai, { req, url }) => { bearer(req); return store.mood(ai, url.searchParams.get('about') || ''); }, H],
    ['PATCH', /^\/api\/memory\/([^/]+)\/([^/]+)$/, (ai, id, { req, body }) => store.patch(ai, id, body, { who: 'me', token: req.headers['x-mem-unlock'] })],
    // 删 = 归档；?purge=1 = 彻底删（只能删已经归档的）
    ['DELETE', /^\/api\/memory\/([^/]+)\/([^/]+)$/, (ai, id, { req, url }) =>
      store[url.searchParams.get('purge') === '1' ? 'purge' : 'remove'](ai, id, { who: 'me', token: req.headers['x-mem-unlock'] })],
    ['POST', /^\/api\/memory\/([^/]+)\/([^/]+)\/restore$/, (ai, id, { req }) => store.restore(ai, id, { who: 'me', token: req.headers['x-mem-unlock'] })],
    ['GET', /^\/api\/state\/([^/]+)$/, (ai) => store.getState(ai) || {}],
    // 人格 md：改正文、改引用文件、退回，设了记忆锁要开锁；开关不用
    ['GET', /^\/api\/persona\/([^/]+)$/, (ai) => need(persona).get(ai)],
    ['PUT', /^\/api\/persona\/([^/]+)$/, (ai, { req, body }) => need(persona).put(ai, body, unlockTok(req))],
    ['GET', /^\/api\/persona\/([^/]+)\/export$/, (ai) => need(persona).exportMd(ai)],
    ['POST', /^\/api\/persona\/([^/]+)\/back$/, (ai, { req, body }) => need(persona).back(ai, body.t, unlockTok(req))],
    ['POST', /^\/api\/persona\/([^/]+)\/import$/, (ai, { body }) => { need(persona); store.folder(ai); return importPersona(body); }, BIG], // 只转不存
    ['GET', /^\/api\/persona\/([^/]+)\/files\/([^/]+)$/, (ai, name) => need(persona).getFile(ai, name)],
    ['PUT', /^\/api\/persona\/([^/]+)\/files\/([^/]+)$/, (ai, name, { req, body }) => need(persona).putFile(ai, name, body.text, unlockTok(req))],
    ['DELETE', /^\/api\/persona\/([^/]+)\/files\/([^/]+)$/, (ai, name, { req }) => need(persona).delFile(ai, name, unlockTok(req))],
    // 夜里：设置、手动跑一次（要口令）；梦：她看的那份
    ['GET', /^\/api\/night\/([^/]+)$/, (ai) => need(night).get(ai)],
    ['PUT', /^\/api\/night\/([^/]+)$/, (ai, { body }) => need(night).set(ai, body)],
    ['POST', /^\/api\/night\/([^/]+)\/run$/, (ai, { req, body }) => {
      bearer(req);
      if (inbox?.doing(ai)) throw fail(409, '收件箱正在做一件事，等它做完再试');
      return need(night).run(ai, { tidy: body.tidy, dream: body.dream });
    }, H],
    // 待整理：她看得到正文，能加一句更正（TA 的原话不动）、删更正、收走一条；后三样设了记忆锁要开锁。日记：私人段只给个数
    ['GET', /^\/api\/digest\/([^/]+)$/, (ai) => need(digest).list(ai)],
    ['PUT', /^\/api\/digest\/([^/]+)\/([^/]+)\/fix$/, (ai, id, { req, body }) => need(digest).setFix(ai, id, body.text, unlockTok(req))],
    ['DELETE', /^\/api\/digest\/([^/]+)\/([^/]+)\/fix$/, (ai, id, { req }) => need(digest).dropFix(ai, id, unlockTok(req))],
    ['DELETE', /^\/api\/digest\/([^/]+)\/([^/]+)$/, (ai, id, { req }) => need(digest).remove(ai, id, unlockTok(req))],
    ['GET', /^\/api\/diary\/([^/]+)$/, (ai, { url }) => need(diary).list(ai, { before: url.searchParams.get('before'), limit: url.searchParams.get('limit') })],
    // 拍一拍的设置；旁听的小模型的设置（网页里改；地址要过 lib/net.mjs 的检查，keyEnv 不能用后端自己的口令）
    ['GET', /^\/api\/pat\/([^/]+)$/, (ai) => { store.folder(ai); return need(pat).get(ai); }],
    ['PUT', /^\/api\/pat\/([^/]+)$/, (ai, { body }) => { store.folder(ai); return need(pat).set(ai, body); }],
    ['GET', /^\/api\/helper\/([^/]+)$/, (ai) => { store.folder(ai); return need(helper).get(ai); }],
    ['PUT', /^\/api\/helper\/([^/]+)$/, (ai, { body }) => { store.folder(ai); return need(helper).set(ai, body); }],
    ['GET', /^\/api\/dream\/([^/]+)$/, (ai, { url }) => need(dreams).list(ai, { before: url.searchParams.get('before'), limit: url.searchParams.get('limit'), who: 'me' })],
    // 聊天：有哪几个 AI。名单（data/ais.json）只能由这台电脑的管理员手改：里面有用哪个环境变量当 key、往哪发、dsh 拉起什么程序
    // 她传的图和文件（lib/files.mjs）：收的是文件本身（不是 JSON），发的时候认文件头、不认后缀
    ['POST', /^\/api\/upload$/, ({ req, res, url }) => need(files).save(req, url.searchParams.get('name') || '').then((r) => { const s = JSON.stringify(r); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) }); res.end(s); }), RAW],
    ['GET', /^\/api\/file\/([^/]+)$/, (id, { req, res }) => {
      const { file, meta } = need(files).get(id);
      const inline = ['img', 'audio'].includes(meta.kind) || meta.ext === 'pdf';
      res.writeHead(200, { 'content-type': meta.mime, 'content-length': meta.size, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable',
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`, 'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'" });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { flags: NOFOLLOW }).on('error', () => res.destroy()).pipe(res); // 不跟链接（files.get 已经查过是普通文件）
    }, OWN],
    // 设置里要填的服务（lib/svc.mjs）：Key 只进不出
    ['GET', /^\/api\/svc$/, () => need(svc).view()],
    ['PUT', /^\/api\/svc\/fm\/([^/]+)$/, (k, { body }) => need(svc).putFm(k, body)],
    ['PUT', /^\/api\/svc\/vec$/, ({ body }) => need(svc).putVec(body)],
    ['PUT', /^\/api\/svc\/push$/, ({ body }) => need(svc).putPush(body)],
    ['PUT', /^\/api\/svc\/opts$/, ({ body }) => need(svc).putOpts(body)],
    ['GET', /^\/api\/ais$/, () => need(chat).ais()],
    ['PUT', /^\/api\/ais$/, () => { need(chat); throw fail(403, 'AI 名单不能从网页或接口改：请在这台电脑上直接编辑 data/ais.json（改完刷新网页就行）'); }],
    // 聊天记录、发一句（SSE）、停下、重新生成、上下文带多少。跟 /api/memory 一样不另加口令
    ['GET', /^\/api\/translate$/, () => need(translate).status()],        // 思考翻译：配没配
    ['POST', /^\/api\/translate$/, ({ body }) => need(translate).run(body)], // 思考翻译：设置里的「翻译」或 .env 的 TRANSLATE_*，都没配回 503
    // 开屏字幕：读、存、让 TA 自己写一套（只回草稿，save: true 才顺手存）
    ['GET', /^\/api\/lockwords$/, ({ url }) => need(lockwords).get(url.searchParams.get('ai') || '')],
    ['PUT', /^\/api\/lockwords$/, ({ url, body }) => need(lockwords).put(url.searchParams.get('ai') || '', body)],
    ['POST', /^\/api\/lockwords\/write$/, ({ body }) => need(lockwords).write(body)],
    // 声音：TA 说话（回音频字节）、她发语音（请求体是录音字节，回 { text, file }）、每个 AI 的声音设置
    ['POST', /^\/api\/voice\/tts$/, async ({ res, body }) => {
      const { buf, type } = await need(voice).tts(body);
      res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(buf);
    }, OWN],
    ['POST', /^\/api\/voice\/stt$/, async ({ req, res, url }) => json(res, 200, await need(voice).stt(req, { call: url.searchParams.get('call') === '1' })), RAW],
    ['GET', /^\/api\/voice\/([^/]+)$/, (ai) => need(voice).get(ai)],
    ['PUT', /^\/api\/voice\/([^/]+)$/, (ai, { body }) => need(voice).put(ai, body)],
    // 推送：公钥、订阅、退订、试一下；网页在不在前台（在前台就不推）
    ['GET', /^\/api\/push\/key$/, () => need(push).key()],
    ['POST', /^\/api\/push\/sub$/, ({ body }) => need(push).addSub(body)],
    ['DELETE', /^\/api\/push\/sub$/, ({ body, url }) => need(push).delSub(body.endpoint || url.searchParams.get('endpoint'))],
    ['POST', /^\/api\/push\/test$/, ({ body }) => need(push).test(body)],
    ['POST', /^\/api\/presence$/, ({ body }) => need(push).presence(body)],
    ['GET', /^\/api\/usage$/, ({ url }) => need(chat).usage({ days: url.searchParams.get('days') })],
    ['GET', /^\/api\/chat\/([^/]+)\/ctx$/, (ai) => need(chat).getCtx(ai)],
    ['PUT', /^\/api\/chat\/([^/]+)\/ctx$/, (ai, { body }) => need(chat).setCtx(ai, body)],
    ['POST', /^\/api\/chat\/([^/]+)\/send$/, (ai, { body, res }) => need(chat).send(ai, body, res), SSE],
    ['POST', /^\/api\/chat\/([^/]+)\/stop$/, (ai) => need(chat).stop(ai)],
    // dsh 的 TA：回答确认、还在等的确认、新会话、状态（docs/接口-dsh.md）
    ['POST', /^\/api\/chat\/([^/]+)\/approve$/, (ai, { body }) => need(chat).dsh.approve(ai, body.id, body.allow === true)],
    ['GET', /^\/api\/chat\/([^/]+)\/approvals$/, (ai) => need(chat).dsh.pending(ai)],
    ['POST', /^\/api\/chat\/([^/]+)\/dsh\/new$/, (ai) => need(chat).dsh.reset(ai)],
    ['GET', /^\/api\/chat\/([^/]+)\/dsh$/, (ai) => need(chat).dsh.state(ai)],
    ['POST', /^\/api\/chat\/([^/]+)\/pat$/, (ai) => need(chat).pat(ai)],
    ['POST', /^\/api\/chat\/([^/]+)\/regen$/, (ai, { body, res }) => need(chat).again(ai, String(body.id ?? ''), body, res), SSE], // 说明里写的那个名字
    ['GET', /^\/api\/chat\/([^/]+)$/, (ai, { url }) => need(chat).list(ai, { before: url.searchParams.get('before'), limit: url.searchParams.get('limit'), turns: url.searchParams.get('turns'), gone: url.searchParams.get('gone') === '1' })],
    ['PATCH', /^\/api\/chat\/([^/]+)\/([^/]+)$/, (ai, id, { body }) => need(chat).edit(ai, id, body)],
    ['DELETE', /^\/api\/chat\/([^/]+)\/([^/]+)$/, (ai, id) => need(chat).remove(ai, id)],
    ['POST', /^\/api\/chat\/([^/]+)\/([^/]+)\/restore$/, (ai, id) => need(chat).restore(ai, id)],
    ['POST', /^\/api\/chat\/([^/]+)\/([^/]+)\/again$/, (ai, id, { body, res }) => need(chat).again(ai, id, body, res), SSE],
    // 收件箱：会叫醒 TA 的事先放进来。放要口令；设置页看的那份不带内容
    ['POST', /^\/api\/inbox\/([^/]+)$/, (ai, { req, body }) => { bearer(req); return need(inbox).put(ai, { kind: body.kind, key: body.key, body: body.body }); }, H],
    ['GET', /^\/api\/inbox\/([^/]+)$/, (ai) => need(inbox).list(ai)],
    // 敲门：守门人来敲，地址照说明不变，内部转进收件箱
    ['POST', /^\/api\/wake\/([^/]+)$/, (ai, { req, body }) => { bearer(req); return need(inbox).put(ai, wakeItem(body)); }, H],
    // 主动找我的设置；TA 自己定的回头看（她能看、能取消）
    ['GET', /^\/api\/knock\/([^/]+)$/, (ai) => need(knock).get(ai)],
    ['PUT', /^\/api\/knock\/([^/]+)$/, (ai, { body }) => need(knock).set(ai, body)],
    ['GET', /^\/api\/timers\/([^/]+)$/, (ai) => need(knock).timers.list(ai)],
    ['DELETE', /^\/api\/timers\/([^/]+)\/([^/]+)$/, (ai, id) => need(knock).timers.cancel(ai, id, 'me')],
    // MCP（给 Grok 这类钩子塞不了话的）：要口令；只收 POST
    ['POST', /^\/mcp\/([^/]+)$/, (ai, { req, res, body }) => { bearer(req); store.folder(ai); return need(mcp)(ai, body, res); }, HOWN],
    ['GET', /^\/mcp\/([^/]+)$/, () => { throw fail(405, '这里只收 POST（不开 SSE）'); }, H],
    ['DELETE', /^\/mcp\/([^/]+)$/, () => { throw fail(405, '这里没有会话可关'); }, H],
    // TA 翻日记：全文（连私人段），要口令
    ['GET', /^\/api\/hook\/([^/]+)\/diary$/, (ai, { req, url }) => { bearer(req); if (!hooks) throw fail(404, '没有这个地址'); return hooks.diary(ai, url.searchParams.get('day')); }, H],
    // 四个时机 + 散场记：钩子和网关来调，要口令
    ['POST', /^\/api\/hook\/([^/]+)\/(start|before|after|compact|idle)$/, async (ai, when, { req, body }) => {
      bearer(req);
      if (!hooks) throw fail(404, '没有这个地址');
      const r = await hooks[when](ai, body);
      if (when === 'after') delete r.clean;
      return r;
    }, H],
  ];

  // 网关：/gw/ 开头的请求自己读原始请求体、自己处理流式，不走下面的 JSON 路由
  const gateway = makeGateway({ key: cfg.gatewayKey, upstream: cfg.upstream || {}, hooks, log, now: store?.now || Date.now, maxBody: cfg.gwMaxBody,
    persona: persona ? (ai) => persona.inject(ai) : null });

  const deny = (res, code, msg, page = false) => {
    if (!page) return json(res, code, { error: msg });
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>打不开</title><p style="font:16px/1.6 sans-serif;margin:24px">${msg}</p>`;
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(html);
  };
  const isPage = (req, p) => ['GET', 'HEAD'].includes(req.method) && !/^\/(api|mcp)(\/|$)/.test(p);
  const decode = (s) => { try { return decodeURIComponent(s); } catch { throw fail(400, '地址写得不对'); } };

  async function handle(req, res) {
    const send = (code, obj) => json(res, code, obj);
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { req.resume(); return send(400, { error: '地址写得不对' }); }
    // Host 不认得：多半是别的网站把自己的域名解析到了这台电脑（DNS 重绑定），或者隧道、局域网的地址还没写进 ALLOWED_HOSTS
    if (!hostOk(req.headers.host)) { req.resume(); return deny(res, 421, '这个地址（Host）不在白名单里：用隧道、局域网或 Tailscale 的名字打开的，要在 .env 的 ALLOWED_HOSTS 里加上它', isPage(req, url.pathname)); }
    if (url.pathname.startsWith('/gw/')) {
      return gateway(req, res).catch((e) => {
        log('网关出错', e.stack || e.message);
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: { message: '网关出错了' } })); } else res.destroy();
      });
    }
    let hit = null, m = null;
    for (const r of routes) { if (req.method === r[0] && (m = r[1].exec(url.pathname))) { hit = r; break; } }
    const opt = hit?.[3] || {};
    const open = OPEN.test(url.pathname);
    if (!opt.hook) {
      // 网页用的：开了口令要登录；没开口令只许这台电脑自己
      if (!open) {
        if (auth.on && !auth.ok(req)) {
          req.resume();
          if (/^\/(api|mcp)(\/|$)/.test(url.pathname) || !['GET', 'HEAD'].includes(req.method)) return send(401, { error: '要先登录', login: true });
          if (url.pathname === '/' || /\.html?$/i.test(url.pathname) || !/\.[a-z0-9]+$/i.test(url.pathname)) {
            res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' });
            return res.end(req.method === 'HEAD' ? undefined : LOGIN_PAGE);
          }
          return send(401, { error: '要先登录', login: true });
        }
        if (!auth.on && !localOnly(req)) { req.resume(); return deny(res, 403, '没设网页口令（.env 的 WEB_PASSWORD），只能在这台电脑上用 localhost 或 127.0.0.1 打开。要从手机、别的电脑、隧道打开，先设口令', isPage(req, url.pathname)); }
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (!originOk(req)) { req.resume(); return send(403, { error: '不是从这个网页发来的请求，没收' }); }
        if (hit && !opt.raw && hasBody(req) && !isJson(req)) { req.resume(); return send(415, { error: '请求体要是 JSON（Content-Type: application/json）' }); }
      }
    }
    try {
      if (hit) {
        const body = !opt.raw && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(hit[0]) ? await readJson(req, opt.max) : {};
        const out = await hit[2](...m.slice(1).map(decode), { req, res, body, url });
        if (opt.sse) return; // 已经自己写完了
        return send(200, out);
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const w = webFile(cfg, webRoot, url.pathname);
        if (w) {
          // 11-17 她：云岛打开太慢（页面 700 多 KB，每次都整个重下）。带上版本号（etag）：没改过就回 304，手机用存着的
          if (req.headers['if-none-match'] === w.etag) {
            fs.closeSync(w.fd);
            res.writeHead(304, { etag: w.etag, 'cache-control': 'no-cache' }); return res.end();
          }
          if (req.method === 'HEAD') fs.closeSync(w.fd);
          res.writeHead(200, { 'content-type': w.type, 'content-length': w.size, 'cache-control': 'no-cache', etag: w.etag, 'x-content-type-options': 'nosniff' });
          return req.method === 'HEAD' ? res.end() : fs.createReadStream(null, { fd: w.fd }).on('error', () => res.destroy()).pipe(res);
        }
      }
      req.resume();
      send(404, { error: '没有这个地址' });
    } catch (e) {
      const code = Number.isInteger(e.code) ? e.code : 500;
      if (code === 500) log('出错', req.method, url.pathname, e.stack || e.message);
      if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
      send(code, { error: code === 500 ? '后端出错了' : e.message, ...(e.extra && typeof e.extra === 'object' ? e.extra : {}) });
    }
  }
  // 最外层兜底：处理函数里没接住的错（包括还没进 try 的那几步）只记一行、回 500，不让一个坏请求把整个后端带走
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('出错', req.method, String(req.url).slice(0, 200), e?.stack || e?.message || e);
      try { if (!res.headersSent) json(res, 500, { error: '后端出错了' }); else if (!res.writableEnded) res.end(); } catch { res.destroy(); }
    });
  });

  return {
    server,
    listen: () => new Promise((ok) => server.listen(cfg.port, cfg.host || '127.0.0.1', () => ok(server.address()))),
    close: () => new Promise((ok) => server.close(ok)),
  };
}
