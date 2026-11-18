// dsh：名单里可以有一种 kind: "dsh" 的 TA。后端在这台电脑上拉起 DeepSeek Harness（dsh，DeepSeek 官方开源智能体，MIT），
// 把她说的话交给 dsh 的会话；dsh 的回复、跑了什么工具一边出一边传回前端；dsh 要超出权限时发起的确认（「这一步行不行」）交给前端，她点允许或拒绝。
// 协议：`dsh --profile sdk` 在 stdin/stdout 上说「一行一条」的 JSON-RPC 2.0（官方协议包 dsh-sdk-protocol）。给前端的接口、ais.json 怎么写、
// 怎么装，见 docs/接口-dsh.md。只用 Node 自带的模块。
//
// 几件要记住的事（是协议本身的样子，不是这里偷懒）：
// - 协议里没有「停下这一轮」的方法：停 = 关掉整个 dsh 进程。下一句再拉起来，用 session/resume 接回原来的会话（dsh 自己会把被打断的那轮补好）。
// - 字不是一个一个来的：dsh 只把「记进会话日志的事」发出来（session.event），助手的话是一步说完整段来一次。所以前端看到的是一段一段地出。
// - 一个 TA 一个 dsh 进程、一个 dsh home。进程懒启动、一直复用；闲了 idleMinutes 分钟自己关；挂了下一句再起。
// - dsh 能读写文件、跑命令。权限默认 workspace-write（工作目录里的事不问就做，超出这个权限时运行时发起确认）。确认发给前端；默认 5 分钟没回当拒绝。
// - 会话日志上传（session-log-deepseek：用 DeepSeek 官方接口时把会话日志随请求带上去）默认关：dsh home 的 cordis.patch.yml 里补一段，
//   每次启动带的补丁里也再写一遍。OTel 反馈上传（session-telemetry-otel）也默认关（DSH_TELEMETRY_DISABLED）。
// - key 只在拉起进程那一刻从环境里取，放进 dsh 进程的环境变量；不落盘、不进日志、不进返回。后端自己的口令、别的环境变量不交给 dsh。
//   dsh 要是把 key 原样说出来（回复、思考、工具参数和结果、确认的理由），交给前端和存盘前都换成 ***。这只是补救，不是隔离：
//   dsh 进程本身拿得到 key，它跑的命令也拿得到。
// - 确认要对得上：同一个会话、这一轮、有调用编号、对得上已经登记的那一步、工具名一样、参数能完整给她看；有一样不对就直接拒绝，不让她盲批。
// - 换过权限的旧会话：resume 时带上 permissionMode，再用 /permission 拨一次，dsh 明说成功了才发；确认不了就不发，让她点「新会话」。
// - 一轮有上限：一行输出（单帧）、这一轮累计输出、整轮的时长。超了就取消还在等的确认、关掉 dsh 进程，告诉她这一轮没完成。
//
// 这一版不做的：dsh 反问（ask_user_question，没接，dsh 那边会报没有回答方，模型一般改成直接在回复里问）、子任务（subagent）里的细节、
// 记忆库的开场和小记、重新生成（dsh 自己记着上下文，聊天记录里删改不影响它记得的）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './store.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
// 后端自己的口令和设置（.env 里那些）不许拿去当 keyEnv、也不许写进 env：chat.mjs、helper.mjs 也用这一份
export const OURS = new Set(['HOOK_TOKEN', 'GATEWAY_KEY', 'EMBED_KEY', 'NIGHT_API_KEY', 'WEB_PASSWORD', 'SESSION_SECRET', 'TRANSLATE_KEY',
  'BARK_URL', 'BARK_AES', 'NIGHT_CMD', 'NIGHT_API_URL', 'EMBED_URL', 'TRANSLATE_BASE', 'UPSTREAM_OPENAI', 'UPSTREAM_ANTHROPIC', 'UPSTREAM_GEMINI',
  'ALLOWED_HOSTS', 'ALLOW_URLS', 'TRUST_PROXY', 'DATA_DIR', 'WEB_DIR']);
// 下面这几个由这里来定，不许在 env 里改
const RESERVED = new Set(['DSH_HOME', 'DSH_PERMISSION_MODE', 'DSH_TELEMETRY_DISABLED', 'NODE_OPTIONS']);
export const PERMS = ['read-only', 'workspace-write', 'danger-full-access'];
// providers 里不许出现的字段名：key 只能用 apiKeyEnv（写环境变量的名字），不许把 key 本身写进 ais.json、再被写进补丁文件
const SECRET_FIELD = /^(api[-_]?key|key|token|secret|password|passwd|authorization|bearer|access[-_]?token|headers)$/i;
// 从后端的环境里带给 dsh 的：系统路径、用户目录、语言时区、代理和证书。别的一概不带
const PASS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP',
  'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
const SSE_HEAD = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' };
const LIMITS = {
  req: 60e3,     // 一般的请求（发一句、接回会话）等多久
  start: 120e3,  // 拉起进程到握手完：第一次要建 profile、装载一堆插件，给宽一点
  frame: 16 * 1024 * 1024,     // 一行（一条协议帧）最多这么多字节
  turnBytes: 64 * 1024 * 1024, // 一轮里 dsh 一共最多输出这么多字节
  stop: 1500,    // 关进程：先发 shutdown 等这么久
  eof: 4e3,      // 再关 stdin 等它自己收拾
  term: 3e3,     // 再 SIGTERM、SIGKILL 各等这么久
};
const OUT_MAX = 2000;   // 工具结果给前端看、存进聊天记录的最多这么多字
const IN_MAX = 4000;    // 工具参数（比如写文件的整段内容）最多存这么多字
const ASK_MAX = 64000;  // 要她确认的那一步，参数超过这么多字就显示不全：不让她盲批，直接拒绝
const cut = (s, n) => { const c = [...String(s ?? '')]; return c.length > n ? c.slice(0, n).join('') + '…' : c.join(''); };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const inside = (a, b) => { const r = path.relative(b, a); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); }; // a 在 b 里面（或就是 b）

// ---- ais.json 里一个 dsh TA 的设置 ----
// { id, name?, avatar?, kind: "dsh", dsh: { home, workspace, bin?, node?, profile?, permission?, provider?, model?, reasoningEffort?, maxTokens?,
//   providers?, keyEnv?, env?, uploadLog?, telemetry?, approvalTimeout?, idleMinutes? } }。只留认得的几项；报错不带她填的值
export function cleanDsh(x, i = 0) {
  const at = `第 ${i + 1} 个`;
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw fail(400, `${at}不是一个对象`);
  const id = String(x.id ?? '');
  if (!ID_RE.test(id)) throw fail(400, `${at}的 id 只能是字母、数字、_ 和 -`);
  const d = x.dsh;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw fail(400, `${id} 是 dsh，要写 dsh: { home, workspace, … }`);
  const a = { id, kind: 'dsh' };
  for (const k of ['name', 'avatar']) {
    if (x[k] == null || x[k] === '') continue;
    if (typeof x[k] !== 'string') throw fail(400, `${id} 的 ${k} 要是一段文字`);
    a[k] = x[k].slice(0, k === 'name' ? 40 : 2000);
  }
  const o = {};
  // dsh 的家（会话、设置、日志都在这里）和工作目录（dsh 只在这里面写东西）：都要绝对路径
  for (const k of ['home', 'workspace']) {
    if (typeof d[k] !== 'string' || !d[k].trim()) throw fail(400, `${id} 没写 dsh.${k}`);
    if (!path.isAbsolute(d[k])) throw fail(400, `${id} 的 dsh.${k} 要写绝对路径`);
    o[k] = path.resolve(d[k]);
  }
  // home 放在工作目录里，dsh 就能翻到自己的会话记录和凭据
  if (inside(o.home, o.workspace)) throw fail(400, `${id} 的 dsh.home 不能放在 dsh.workspace 里面（也不能是同一个文件夹）`);
  for (const k of ['bin', 'node']) {
    if (d[k] == null || d[k] === '') continue;
    if (typeof d[k] !== 'string' || d[k].length > 1000) throw fail(400, `${id} 的 dsh.${k} 要是一段文字`);
    if (/[\\/]/.test(d[k]) && !path.isAbsolute(d[k])) throw fail(400, `${id} 的 dsh.${k} 写路径的话要写绝对路径`);
    o[k] = d[k];
  }
  o.bin ??= 'dsh';
  o.profile = d.profile == null || d.profile === '' ? 'sdk' : String(d.profile);
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(o.profile)) throw fail(400, `${id} 的 dsh.profile 只能是小写字母、数字、_ 和 -`);
  o.permission = d.permission == null || d.permission === '' ? 'workspace-write' : d.permission;
  if (!PERMS.includes(o.permission)) throw fail(400, `${id} 的 dsh.permission 只能是 ${PERMS.join('、')}`);
  o.provider = d.provider == null || d.provider === '' ? 'deepseek-official' : String(d.provider);
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(o.provider)) throw fail(400, `${id} 的 dsh.provider 只能是字母、数字、.、_ 和 -`);
  o.model = d.model == null || d.model === '' ? 'deepseek-v4-flash' : d.model;
  if (typeof o.model !== 'string' || o.model.length > 200 || !o.model.trim()) throw fail(400, `${id} 的 dsh.model 要是一段文字`);
  if (d.reasoningEffort != null && d.reasoningEffort !== '') {
    if (typeof d.reasoningEffort !== 'string' || d.reasoningEffort.length > 40) throw fail(400, `${id} 的 dsh.reasoningEffort 要是一小段文字`);
    o.reasoningEffort = d.reasoningEffort;
  }
  for (const [k, lo, hi] of [['maxTokens', 1, 1e6], ['approvalTimeout', 10, 3600], ['idleMinutes', 0, 1440], ['turnMinutes', 1, 1440]]) {
    if (d[k] == null) continue;
    const n = Number(d[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) throw fail(400, `${id} 的 dsh.${k} 要是 ${lo} 到 ${hi} 的整数`);
    o[k] = n;
  }
  for (const k of ['uploadLog', 'telemetry']) {
    if (d[k] == null) continue;
    if (typeof d[k] !== 'boolean') throw fail(400, `${id} 的 dsh.${k} 只能是 true 或 false`);
    o[k] = d[k];
  }
  // 自定义模型提供商（OpenAI 兼容的中转、硅基流动这类）：原样写进 llm-pi-ai 的 providers；key 只许写 apiKeyEnv
  if (d.providers != null) {
    if (typeof d.providers !== 'object' || Array.isArray(d.providers)) throw fail(400, `${id} 的 dsh.providers 要是一个对象`);
    const walk = (v, depth) => {
      if (depth > 8) throw fail(400, `${id} 的 dsh.providers 套得太深了`);
      if (Array.isArray(v)) { v.forEach((y) => walk(y, depth + 1)); return; }
      if (v && typeof v === 'object') for (const [k, y] of Object.entries(v)) { if (SECRET_FIELD.test(k)) throw fail(400, `${id} 的 dsh.providers 里别写 ${k}：key 放进环境变量，这里只写 apiKeyEnv，再把变量名写进 keyEnv`); walk(y, depth + 1); }
    };
    walk(d.providers, 0);
    const s = JSON.stringify(d.providers);
    if (s.length > 20000) throw fail(400, `${id} 的 dsh.providers 太长了`);
    o.providers = JSON.parse(s);
  }
  // keyEnv：要交给 dsh 的 key 的环境变量名（值在用的时候从后端的环境或 .env 里取）
  if (d.keyEnv != null && d.keyEnv !== '') {
    const list = Array.isArray(d.keyEnv) ? d.keyEnv : [d.keyEnv];
    if (list.length > 10) throw fail(400, `${id} 的 dsh.keyEnv 最多写 10 个`);
    for (const k of list) {
      if (typeof k !== 'string' || !ENV_RE.test(k)) throw fail(400, `${id} 的 dsh.keyEnv 要写环境变量的名字（大写字母、数字、_），不是 key 本身`);
      if (OURS.has(k) || RESERVED.has(k)) throw fail(400, `${id} 的 dsh.keyEnv 不能用 ${k}`);
    }
    o.keyEnv = [...new Set(list)];
  }
  // env：不是秘密的设置（比如 TZ、DSH_CONTEXT_WINDOW）。key 别写这里，用 keyEnv
  if (d.env != null) {
    if (typeof d.env !== 'object' || Array.isArray(d.env)) throw fail(400, `${id} 的 dsh.env 要是一个对象`);
    const e = Object.entries(d.env);
    if (e.length > 20) throw fail(400, `${id} 的 dsh.env 最多 20 项`);
    o.env = {};
    for (const [k, v] of e) {
      if (!ENV_RE.test(k) || OURS.has(k) || RESERVED.has(k)) throw fail(400, `${id} 的 dsh.env 不能写 ${ENV_RE.test(k) ? k : '这个名字'}`);
      if (typeof v !== 'string' || v.length > 2000) throw fail(400, `${id} 的 dsh.env.${k} 要是一段文字`);
      o.env[k] = v;
    }
  }
  a.dsh = o;
  return a;
}
// 给前端看的：不带路径、环境变量
export const pubDsh = (a) => ({ id: a.id, ...(a.name ? { name: a.name } : {}), kind: 'dsh', model: a.dsh.model, ...(a.avatar ? { avatar: a.avatar } : {}), notes: false, permission: a.dsh.permission });

// ---- 关掉会话日志上传：dsh home 的 cordis.patch.yml（对这个 home 下的所有 profile 都管用，包括她自己另外开 dsh web）----
const MARK_A = '# >>> 云岛（yundao）', MARK_B = '# <<< 云岛（yundao）';
const LOG_OFF = ['- id: session-log-deepseek', '  config:', '    enabled: false'];
// off=false（她在设置里写了 uploadLog: true）：只拿掉我们写的那一段，别的不动。返回改没改
export function fixHomePatch(home, off = true) {
  const f = path.join(home, 'cordis.patch.yml');
  let src = '';
  try { src = fs.readFileSync(f, 'utf8'); } catch { /* 还没有 */ }
  const rest = [];
  let mine = false, inBlock = false;
  for (const l of src.split(/\r?\n/)) {
    if (l.startsWith(MARK_A)) { inBlock = mine = true; continue; }
    if (l.startsWith(MARK_B)) { inBlock = false; continue; }
    if (!inBlock) rest.push(l);
  }
  while (rest.length && !rest.at(-1).trim()) rest.pop();
  const body = rest.filter((l) => l.trim() && !l.trim().startsWith('#'));
  const empty = !body.length || (body.length === 1 && body[0].trim() === '[]');
  let out;
  if (!off) {
    if (!mine) return false;
    out = empty ? [...rest.filter((l) => l.trim() !== '[]'), '[]'] : rest;
  } else {
    const block = [MARK_A + ' 自动维护：关掉「用 DeepSeek 官方接口时把会话日志随请求传上去」。要打开，在云岛这个 TA 的设置里写 uploadLog: true，别手改这一段', ...LOG_OFF, MARK_B];
    if (empty) out = [...rest.filter((l) => l.trim() !== '[]'), ...block];
    else if (body.every((l) => /^(- |\s)/.test(l))) out = [...rest, ...block];
    // 不是「一行一个 - 」的写法（比如整份写成 [ … ]）：不敢动，让她自己加，加之前不启动
    else throw fail(503, 'dsh home 里的 cordis.patch.yml 写法认不出来，没法自动关掉会话日志上传。请手动在里面加上：' + LOG_OFF.join(' / ') + '，或者在设置里写 uploadLog: true');
  }
  const txt = out.join('\n').replace(/^\n+/, '') + '\n';
  if (txt === src) return false;
  fs.writeFileSync(f + '.tmp', txt, { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
  return true;
}
// 每次启动带的补丁（--patch，比 home 和 profile 里的都优先）：这个 TA 的模型提供商 + 再关一遍日志上传。JSON 也是合法的 YAML
function writeOverlay(ai, d) {
  const rows = [];
  if (!d.uploadLog) rows.push('- id: session-log-deepseek', '  config: {"enabled": false}');
  if (d.providers) rows.push('- id: llm-pi-ai', '  config: ' + JSON.stringify({ providers: d.providers }));
  const f = path.join(d.home, `yundao-${ai}.patch.yml`);
  fs.writeFileSync(f + '.tmp', ['# 云岛后端每次拉起 dsh 前按这个 TA 的设置重写这个文件，别手改', ...(rows.length ? rows : ['[]'])].join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
  return f;
}

// 工具参数：模型给的是一段 JSON 文字，能解开就解开；太长的存成截断的文字
function parseArgs(s) {
  if (typeof s === 'string') { try { return JSON.parse(s); } catch { return s; } }
  return s ?? {};
}
const argsLen = (v) => [...(typeof v === 'string' ? v : JSON.stringify(v))].length;
function argsOf(v) {
  const j = typeof v === 'string' ? v : JSON.stringify(v);
  return j.length > IN_MAX ? cut(j, IN_MAX) : v;
}
// 把已知的 key 换成 ***（字符串、数组、对象里的每一段字，键名也查）
function scrubDeep(v, secrets, depth = 0) {
  if (typeof v === 'string') { let x = v; for (const k of secrets) if (k.length >= 4) x = x.split(k).join('***'); return x; }
  if (!v || typeof v !== 'object') return v;
  if (depth > 20) return '〔参数嵌套太深，已省略〕';
  if (Array.isArray(v)) return v.map((y) => scrubDeep(y, secrets, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, y]) => [scrubDeep(k, secrets, depth + 1), scrubDeep(y, secrets, depth + 1)]));
}
const textOf = (blocks) => (Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '');
const MIME = { 'image/png': 'image/png', 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/webp': 'image/webp', 'image/gif': 'image/gif' };
// 她这一句交给 dsh 的样子：一段文字 + 几张图（只认 data:image/…;base64，别的说一声没带上）
function contentOf(text, imgs) {
  const out = [];
  if (String(text || '').trim()) out.push({ type: 'text', text: String(text) });
  let skipped = 0;
  for (const u of imgs || []) {
    const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(String(u));
    const mime = m && MIME[m[1].toLowerCase()];
    if (mime && m[2].trim()) out.push({ type: 'image', data: m[2].replace(/\s+/g, ''), mimeType: mime });
    else skipped++;
  }
  if (skipped) out.push({ type: 'text', text: `〔她还发了 ${skipped} 张图，格式认不出来，没带上〕` });
  if (!out.length) out.push({ type: 'text', text: '（空）' });
  return out;
}

// folder(ai)：这个 TA 的数据文件夹（存「现在续的是哪个 dsh 会话」，dsh.json）；不给就用 dir/<ai>
// keyOf(变量名) → key；log(…)：一行日志；limits：测试里把等待时间调短
export function openDsh({ dir, folder, keyOf = () => '', log = () => {}, now = Date.now, limits = {} } = {}) {
  const lim = { ...LIMITS, ...limits };
  const procs = new Map(); // ai → 进程
  const turns = new Map(); // ai → 正在跑的一轮
  const dirOf = (ai) => {
    const d = folder ? folder(ai) : (ID_RE.test(String(ai)) ? path.join(dir, ai) : null);
    if (!d) throw fail(400, 'AI 的名字只能是字母、数字、- 和 _');
    fs.mkdirSync(d, { recursive: true });
    return d;
  };

  // ---- 现在续的是哪个会话：data/<ai>/dsh.json = { session, home, used, perm, t } ----
  // used：发过话了（dsh 那边存下了，换了进程要 resume）；perm：这个会话现在的权限；home：会话存在哪个 dsh home（换了 home 旧的就接不上了）
  const stateFile = (ai) => path.join(dirOf(ai), 'dsh.json');
  function readState(ai) { try { const o = JSON.parse(fs.readFileSync(stateFile(ai), 'utf8')); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
  function writeState(ai, o) { const f = stateFile(ai); fs.writeFileSync(f + '.tmp', JSON.stringify(o), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); }
  const newSession = (ai) => `yd-${ai}-${now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  function sessionOf(ai, conf) {
    const s = readState(ai);
    if (s.session && s.home === conf.dsh.home) return s;
    const n = { session: newSession(ai), home: conf.dsh.home, used: false, t: now() };
    writeState(ai, n);
    return n;
  }

  // 发之前就能知道的毛病先拦下（她那句也不存）：key 没配、工作目录没建、dsh 找不到
  function ready(conf) {
    const d = conf.dsh;
    for (const k of d.keyEnv || []) if (!keyOf(k)) throw fail(503, `${conf.id} 的 key 没配：环境变量 ${k} 是空的`);
    if (!isDir(d.workspace)) throw fail(503, `${conf.id} 的工作目录不存在：先把这个文件夹建好（dsh 只在这里面干活）`);
    if (path.isAbsolute(d.bin) && !fs.existsSync(d.bin)) throw fail(503, `${conf.id} 的 dsh.bin 找不到，看看装好了没有`);
    if (d.node && path.isAbsolute(d.node) && !fs.existsSync(d.node)) throw fail(503, `${conf.id} 的 dsh.node 找不到`);
  }

  // ---- 进程 ----
  const scrub = (p, s) => { let x = String(s ?? ''); for (const k of p?.secrets || []) if (k.length >= 4) x = x.split(k).join('***'); return x; };
  function launch(ai, conf, keys, sig) {
    const d = conf.dsh;
    fs.mkdirSync(d.home, { recursive: true, mode: 0o700 });
    fixHomePatch(d.home, !d.uploadLog);
    const overlay = writeOverlay(ai, d);
    const env = {};
    for (const k of PASS) if (process.env[k] != null) env[k] = process.env[k];
    Object.assign(env, d.env || {}, keys, { DSH_HOME: d.home, DSH_PERMISSION_MODE: d.permission });
    if (!d.telemetry) env.DSH_TELEMETRY_DISABLED = '1';
    // 写的是 .js 文件（比如 node_modules/@deepseek-ai/dsh/lib/bin.js）就用 node 跑；不然当命令直接起（node_modules/.bin/dsh、装在 PATH 里的 dsh）
    const js = /\.[cm]?js$/i.test(d.bin);
    const cmd = js ? (d.node || process.execPath) : d.bin;
    const args = [...(js ? [d.bin] : []), '--profile', d.profile, '--patch', overlay];
    const p = { ai, sig, home: d.home, seq: 0, wait: new Map(), opened: new Set(), dead: false, halting: null, code: null, tail: [], flood: false,
      secrets: Object.values(keys), turn: null, idle: null, child: null };
    let exited;
    p.exited = new Promise((ok) => { exited = ok; });
    const gone = (code, err) => {
      if (p.dead) return;
      p.dead = true;
      p.code = code;
      clearTimeout(p.idle);
      const missing = err?.code === 'ENOENT';
      const why = missing ? `找不到 dsh（${d.bin}），看看装好了没有` : `dsh 进程退出了（退出码 ${code ?? '?'}）`;
      for (const w of p.wait.values()) { clearTimeout(w.timer); w.reject(Object.assign(new Error(why), { dead: true, missing })); }
      p.wait.clear();
      if (p.turn) p.turn.end({ dead: why });
      if (!p.halting) {
        log('dsh', ai, why);
        // 最后几行 stderr 帮忙查毛病（已知的 key 抹掉）；dsh 自己的启动报告在 dsh home 的 logs 文件夹里
        for (const l of p.tail.slice(-5)) log('dsh', ai, 'stderr:', cut(scrub(p, l), 200));
      }
      if (procs.get(ai) === p) procs.delete(ai);
      exited();
    };
    let child;
    try { child = spawn(cmd, args, { cwd: d.workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { gone(null, e); return p; }
    p.child = child;
    child.once('error', (e) => gone(null, e));
    child.once('close', (code, signal) => gone(code ?? signal));
    child.stdin.on('error', () => {}); // 进程死了还在写会 EPIPE；真正的信号是上面的 close
    let buf = '', ebuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s) => {
      if (p.flood) return; // 超了上限、正在关：后面来的都不要
      if (p.turn) { p.turn.bytes += Buffer.byteLength(s); if (p.turn.bytes > lim.turnBytes) return flood(p, `dsh 这一轮输出太多（超过 ${Math.round(lim.turnBytes / 1048576)} MB）`); }
      buf += s;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i);
        if (Buffer.byteLength(raw) > lim.frame) return flood(p, `dsh 一行输出太长（超过 ${Math.round(lim.frame / 1048576)} MB）`);
        buf = buf.slice(i + 1);
        const line = raw.trim(); if (line) frame(p, line);
      }
      if (Buffer.byteLength(buf) > lim.frame) return flood(p, `dsh 一行输出太长（超过 ${Math.round(lim.frame / 1048576)} MB）`);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => {
      ebuf += s;
      const k = ebuf.lastIndexOf('\n');
      if (k < 0) { if (ebuf.length > 4000) ebuf = ebuf.slice(-4000); return; }
      p.tail.push(...ebuf.slice(0, k).split('\n').filter(Boolean).map((l) => l.slice(0, 500)));
      if (p.tail.length > 30) p.tail.splice(0, p.tail.length - 30);
      ebuf = ebuf.slice(k + 1);
    });
    return p;
  }

  // 输出超了上限：这一轮当没完成（还在等的确认一起取消），关掉进程
  function flood(p, why) {
    p.flood = true;
    log('dsh', p.ai, why);
    if (p.turn) p.turn.end({ dead: why + '，这一轮没完成，已经停下' });
    halt(p, why);
  }

  // 一行收到的东西：带 id 和 method 的是 dsh 来问我们（确认），只带 id 的是回我们的话，只带 method 的是通知。坏行跳过（协议也是这么做的）
  function frame(p, line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const hasId = typeof m.id === 'string' || typeof m.id === 'number';
    const params = m.params && typeof m.params === 'object' && !Array.isArray(m.params) ? m.params : {};
    if (hasId && typeof m.method === 'string') { incoming(p, m.id, m.method, params); return; }
    if (hasId) {
      const w = p.wait.get(m.id);
      if (!w) return;
      p.wait.delete(m.id);
      clearTimeout(w.timer);
      if (m.error && typeof m.error === 'object') w.reject(Object.assign(new Error(String(m.error.message || 'dsh 回了一个错误')), { rpc: m.error.code }));
      else w.resolve(m.result);
      return;
    }
    if (typeof m.method === 'string' && p.turn) p.turn.feed(m.method, params); // 这个进程只服务一个 TA：通知都交给正在跑的那一轮
  }
  const write = (p, o) => { if (!p.dead && p.child) { try { p.child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* close 会来 */ } } };
  function request(p, method, params, ms = lim.req) {
    if (p.dead) return Promise.reject(Object.assign(new Error('dsh 进程已经退出了'), { dead: true }));
    const id = ++p.seq;
    return new Promise((resolve, reject) => {
      const timer = ms ? setTimeout(() => { p.wait.delete(id); reject(Object.assign(new Error(`dsh 等了 ${Math.round(ms / 1000)} 秒没回（${method}）`), { timeout: true })); }, ms) : null;
      p.wait.set(id, { resolve, reject, timer });
      write(p, { jsonrpc: '2.0', id, method, params });
    });
  }
  async function incoming(p, id, method, params) {
    let result = null, error = null;
    try {
      if (method === 'approval/request') result = await askHer(p, params);
      else error = { code: -32601, message: `不认得 ${method}` }; // 反问（user-question/ask）这一版没接：握手时没声明，本来也不会来
    } catch (e) { error = { code: -32603, message: String(e?.message || e) }; }
    write(p, error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
  }

  // 关进程：先 shutdown（dsh 自己收拾干净再退），不行关 stdin，再不行 SIGTERM、SIGKILL
  const within = (p, ms) => Promise.race([p.exited, new Promise((ok) => { const h = setTimeout(ok, ms); h.unref?.(); })]);
  function halt(p, why) {
    p.halting ??= (async () => {
      clearTimeout(p.idle);
      if (!p.dead) {
        log('dsh', p.ai, '关掉进程：' + why);
        await request(p, 'shutdown', {}, lim.stop).catch(() => {});
        await within(p, lim.stop);
      }
      if (!p.dead) { try { p.child?.stdin.end(); } catch { /* 已经关了 */ } await within(p, lim.eof); }
      if (!p.dead && process.platform !== 'win32') { try { p.child?.kill('SIGTERM'); } catch { /* 已经没了 */ } await within(p, lim.term); }
      if (!p.dead) { try { p.child?.kill('SIGKILL'); } catch { /* 已经没了 */ } await within(p, lim.term); }
      if (procs.get(p.ai) === p) procs.delete(p.ai);
    })();
    return p.halting;
  }
  // 闲了就关（省内存）；下一句再起
  function armIdle(p, conf) {
    clearTimeout(p.idle);
    const mins = conf.dsh.idleMinutes ?? 30;
    if (!mins || p.dead) return;
    p.idle = setTimeout(() => { if (!p.turn) halt(p, `闲了 ${mins} 分钟`); }, mins * 60e3);
    p.idle.unref?.();
  }

  // 拿一个能用的进程：没有、挂了、设置改了（或者 key 换了）就重起；同一个 home 不许两个 TA 一起用（会话会被占用）
  async function procOf(ai, conf, onStart) {
    const d = conf.dsh, keys = {};
    for (const k of d.keyEnv || []) { const v = keyOf(k); if (!v) throw fail(503, `${ai} 的 key 没配：环境变量 ${k} 是空的`); keys[k] = v; }
    const sig = JSON.stringify(d) + '|' + crypto.createHash('sha256').update(JSON.stringify(keys)).digest('hex'); // key 只拿哈希比，不存
    let p = procs.get(ai);
    if (p && !p.dead && !p.halting && p.sig === sig) return p.ready;
    if (p) await halt(p, p.dead || p.halting ? '换新的' : '设置改了');
    for (const [k, q] of procs) if (k !== ai && !q.dead && q.home === d.home) throw fail(409, `${ai} 和 ${k} 用了同一个 dsh home，一个 TA 要单独一个`);
    onStart?.();
    p = launch(ai, conf, keys, sig);
    procs.set(ai, p);
    const init = { cwd: d.workspace, provider: d.provider, model: d.model, approvalRequests: true,
      ...(d.reasoningEffort ? { reasoningEffort: d.reasoningEffort } : {}), ...(d.maxTokens ? { maxTokens: d.maxTokens } : {}) };
    p.ready = request(p, 'initialize', init, lim.start).then((r) => {
      if (r?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') log('dsh', ai, '握手回来的名字不对，照样用：', cut(String(r?.serverInfo?.name), 60));
      log('dsh', ai, '起来了');
      return p;
    }, (e) => {
      halt(p, '没起来');
      if (e.dead) throw Object.assign(new Error(e.missing ? e.message : `${e.message}：没起来，详细原因看 dsh home 里 logs 文件夹最新的那份`), { dead: true });
      throw Object.assign(new Error(scrub(p, e.message)), e.timeout ? { timeout: true } : {});
    });
    return p.ready;
  }

  // 这个进程里接上会话：换过进程的旧会话先 resume（带上设置里的 permissionMode，docs/接口-dsh.md 第 1 节）。
  // 旧会话的权限跟设置不一样（或者旧记录里没写）：resume 的回话是空的 {}，证明不了权限真的换了，所以再用 /permission 拨一次，
  // dsh 回「命令成功」才算数；没回成功（拒绝、超时、被当成一句话）就不发这一句，让她开新会话——新会话按设置的权限起（DSH_PERMISSION_MODE）
  async function sessionIn(p, ai, conf) {
    const s = sessionOf(ai, conf), want = conf.dsh.permission;
    if (!p.opened.has(s.session)) {
      if (s.used) {
        try { await request(p, 'session/resume', { sessionId: s.session, permissionMode: want }); } catch (e) {
          if (e.dead || e.timeout) throw e;
          throw fail(409, `接不上上次的 dsh 会话（${cut(scrub(p, e.message), 120)}），点「新会话」重新开始`);
        }
      }
      p.opened.add(s.session);
    }
    if (s.used && s.perm !== want) {
      let ok = false, why = '';
      try {
        const r = await request(p, 'session/query', { sessionId: s.session, contentBlocks: [{ type: 'text', text: '/permission ' + want }] });
        ok = r?.kind === 'command' && r.execution?.result?.kind === 'success';
        if (!ok) why = r?.kind === 'command' ? cut(scrub(p, r.execution?.result?.text || '没成功'), 120) : '被当成了一句话';
      } catch (e) { if (e.dead) throw e; why = cut(scrub(p, e.message), 120); }
      if (!ok) {
        log('dsh', ai, '权限没拨上：', why);
        throw fail(409, `这个会话的权限要换成 ${want}，但确认不了 dsh 那边已经换过来（${why}）。为了安全这一句没发，点「新会话」按新的权限重新开始`);
      }
      s.perm = want; writeState(ai, s); log('dsh', ai, '权限拨成了', s.perm);
    }
    return s;
  }

  // ---- 一轮 ----
  // 收的是 session.event（会话里记下的每件事）和 session.status（running / idle）。
  // 认这一轮从哪开始：agent/inbox/spliced 里带着我们这句的 messageId；到这个会话再变成 idle 就算完（跟官方 SDK 的 run() 一样）
  // clean(值) → 抹掉 key 以后的值：给前端、存盘的都先过一遍
  function makeTurn(ai, sid, emit, askMs, clean = (v) => v) {
    const t = { ai, sid, emit, askMs, msgId: null, early: [], started: false, text: '', think: '', steps: [], full: [], byCall: new Map(), callWait: new Map(), reason: null, err: '', interrupted: false, asks: new Map(), over: false, bytes: 0, notes: [] };
    let fin;
    t.ended = new Promise((ok) => { fin = ok; });
    t.end = (x) => {
      if (t.over) return;
      t.over = true;
      for (const a of [...t.asks.values()]) a.done('cancelled', 'cancelled'); // 还没答的确认：一律不批
      fin(x || {});
    };
    const say = (s) => { const add = (t.text && !t.text.endsWith('\n') ? '\n\n' : '') + clean(s); t.text += add; emit({ type: 'delta', text: add }); };
    function event(ev) {
      const d = ev.data && typeof ev.data === 'object' ? ev.data : {};
      if (ev.type === 'assistant/message') {
        for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
          if (b?.type === 'text' && typeof b.text === 'string' && b.text) say(b.text);
          else if (b?.type === 'reasoning' && typeof b.text === 'string' && b.text) { const x = clean(b.text); t.think += x; emit({ type: 'think', text: x }); }
        }
        if (d.interrupted) t.interrupted = true;
      } else if (ev.type === 'tool/call') {
        const raw = parseArgs(d.arguments), whole = clean(raw);
        const name = String(d.name || ''), shownName = clean(name);
        const i = t.steps.length, st = { kind: 'tool', name: shownName, input: argsOf(whole) };
        t.steps.push(st);
        let exact = false;
        if (d.arguments != null && raw && typeof raw === 'object' && !Array.isArray(raw) &&
            name && name.length <= 100 && name === shownName && argsLen(whole) <= ASK_MAX) {
          try { exact = JSON.stringify(raw) === JSON.stringify(whole); } catch { /* 无法完整序列化，不批 */ }
        }
        t.full[i] = exact ? whole : null;
        if (d.callId != null) { const k = String(d.callId); t.byCall.set(k, i); const w = t.callWait.get(k); if (w) { t.callWait.delete(k); w(); } }
        emit({ type: 'step', i, ...st });
      } else if (ev.type === 'tool/result') {
        const i = t.byCall.get(String(d.message?.toolCallId));
        if (i == null) return;
        const st = t.steps[i];
        st.ok = !d.message?.isError;
        const out = textOf(d.message?.content) || (typeof d.error?.reason === 'string' ? d.error.reason : '');
        if (out) st.out = cut(clean(out), OUT_MAX);
        emit({ type: 'step_end', i, ok: st.ok, ...(st.out ? { out: st.out } : {}) });
      } else if (ev.type === 'turn/end') {
        t.reason = typeof d.reason?.kind === 'string' ? d.reason.kind : null;
        if (t.reason === 'error') t.err = cut(String(d.reason.error?.message || d.reason.error?.code || '出错了'), 300);
      }
    }
    t.feed = (method, params) => {
      if (t.over) return;
      if (!t.msgId) { if (t.early.length < 2000) t.early.push([method, params]); return; } // 回执可能比 session/prompt 的回话先到：先攒着
      if (params.sessionId !== t.sid) return; // 别的会话（比如 dsh 自己开的子任务）这一版不显示
      if (method === 'session.event') {
        const ev = params.event;
        if (!ev || typeof ev !== 'object') return;
        if (!t.started) {
          if (ev.type === 'agent/inbox/spliced' && Array.isArray(ev.data?.inserted) && ev.data.inserted.some((m) => m?.id === t.msgId)) t.started = true;
          return;
        }
        event(ev);
      } else if (method === 'session.status' && t.started && params.status === 'idle') t.end({ ok: true });
    };
    t.receipt = (id) => { t.msgId = id; const e = t.early; t.early = []; for (const [m, x] of e) t.feed(m, x); };
    return t;
  }

  // dsh 问「这一步行不行」：发给前端，等她答；超时当拒绝。返回给 dsh 的只有 allowed-once / rejected / cancelled（只批这一次）
  async function askHer(p, q) {
    const t = p.turn;
    if (!t || t.over) return { outcome: 'rejected' }; // 没有她在等的那一轮（比如 dsh 自己的定时任务）：不批
    const no = (why, i) => {
      log('dsh', p.ai, '确认直接拒绝：', why);
      if (i != null && t.steps[i]) t.steps[i].approval = 'rejected';
      if (!t.notes.includes(why)) t.notes.push(why);
      return { outcome: 'rejected' };
    };
    // 别的会话（比如 dsh 自己开的子任务）来问：她看不到那边在做什么，不批
    if (q.sessionId !== t.sid) return no('有一个不是这个会话的确认，没给你看，直接拒绝了');
    // 确认请求和 tool/call 事件是两条消息：确认先到时等对应的工具调用登记上（最多 1 秒），前端才看得到要做什么
    const ck = q.callId != null && q.callId !== '' ? String(q.callId) : null;
    if (ck == null) return no('有一个确认没说是哪一步（没有调用编号），没法给你看，直接拒绝了');
    if (!t.byCall.has(ck)) await new Promise((r) => { t.callWait.set(ck, r); setTimeout(() => { t.callWait.delete(ck); r(); }, 1000).unref?.(); });
    if (t.over) return { outcome: 'rejected' };
    const i = t.byCall.get(ck);
    if (i == null) return no('有一个确认对不上任何一步，没法给你看，直接拒绝了');
    if (String(q.toolName ?? '') !== t.steps[i].name) return no('有一个确认的工具名跟那一步对不上，直接拒绝了', i);
    if (t.full[i] == null) return no('有一步的参数不能完整、原样展示，直接拒绝了', i);
    const id = 'ap' + crypto.randomBytes(6).toString('hex');
    const ms = t.askMs;
    const pub = { id, tool: cut(t.steps[i].name, 100), ...(q.reason ? { reason: cut(scrub(p, q.reason), 500) } : {}),
      i, input: t.full[i], t: now(), until: now() + ms };
    return new Promise((resolve) => {
      const timer = setTimeout(() => done('rejected', 'timeout'), ms);
      timer.unref?.();
      function done(outcome, shown) {
        if (!t.asks.has(id)) return;
        t.asks.delete(id);
        clearTimeout(timer);
        if (i != null) t.steps[i].approval = shown;
        t.emit({ type: 'approval_end', id, outcome: shown });
        resolve({ outcome });
      }
      t.asks.set(id, { pub, done });
      t.emit({ type: 'approval', ...pub, timeout: ms });
    });
  }

  // ---- 发一句、流式回复：跟 chat.mjs 的 answer 一样写 SSE（delta / think / step / error / done），多了 status、step_end、approval、approval_end ----
  // me：她那句的编号；text：交给 dsh 的文字（chat 那边拼好的，带引用、时间这些）；imgs：data:image/…;base64 的图
  // save(fields) → 新存的那条 TA 消息的编号（聊天记录由 chat 那边存）。job：chat 的 run() 给的，job.abort() = 停
  async function answer(ai, conf, res, job, { me = null, text = '', imgs = [], save }) {
    res.writeHead(200, SSE_HEAD);
    res.flushHeaders?.();
    const emit = (o) => { if (!res.writableEnded && !res.destroyed) res.write('data: ' + JSON.stringify(o) + '\n\n'); };
    const finish = (o) => { emit(o); if (!res.writableEnded) res.end(); };
    let p = null, t = null, turnTimer = null;
    job.abort = () => {
      job.stopped = true;
      if (t) t.end({ stopped: true });
      if (p && t) halt(p, '她按了停'); // 协议里没有「停这一轮」：只能关进程。还没开始跑就不用关
    };
    try {
      p = await procOf(ai, conf, () => emit({ type: 'status', state: 'starting' }));
      if (job.stopped) return finish({ type: 'done', id: null, me, cut: true });
      const s = await sessionIn(p, ai, conf);
      if (job.stopped) return finish({ type: 'done', id: null, me, cut: true });
      clearTimeout(p.idle);
      const askMs = limits.approvalMs ?? (conf.dsh.approvalTimeout ?? 300) * 1000;
      t = makeTurn(ai, s.session, emit, askMs, (v) => scrubDeep(v, p.secrets));
      p.turn = t;
      turns.set(ai, t);
      // 整轮的硬截止：回执来了以后 dsh 一直不说「完了」也不会永远卡着
      const turnMs = limits.turnMs ?? (conf.dsh.turnMinutes ?? 30) * 60e3;
      turnTimer = setTimeout(() => {
        if (t.over) return;
        const why = `这一轮跑了超过 ${turnMs >= 60e3 ? Math.round(turnMs / 60e3) + ' 分钟' : Math.round(turnMs / 1000) + ' 秒'}还没完`;
        log('dsh', ai, why);
        t.end({ dead: why + '，这一轮没完成，已经停下' });
        halt(p, why);
      }, turnMs);
      turnTimer.unref?.();
      // 回执和「这一轮已经结束」（超时、超量被切）谁先到听谁的；轮次先结束时，回执那边之后再失败也要接住，不然没人接的失败会把整个后端带崩
      const sent = request(p, 'session/prompt', { sessionId: s.session, contentBlocks: contentOf(text, imgs) }).then((receipt) => ({ receipt }), (err) => ({ err }));
      const first = await Promise.race([sent, t.ended.then((ended) => ({ ended }))]);
      if (first.err) throw first.err;
      if (first.ended) return wrapUp(ai, p, t, first.ended, { me, save, finish, job });
      const r = first.receipt;
      if (!s.used) { s.used = true; s.perm = conf.dsh.permission; writeState(ai, s); }
      if (typeof r?.messageId !== 'string' || !r.messageId) throw new Error('dsh 没回这句的编号');
      t.receipt(r.messageId);
      const out = await t.ended;
      return wrapUp(ai, p, t, out, { me, save, finish, job });
    } catch (e) {
      if (t && !t.over) t.end({});
      if (job.stopped) return t ? wrapUp(ai, p, t, { stopped: true }, { me, save, finish, job }) : finish({ type: 'done', id: null, me, cut: true });
      log('dsh', ai, '这一句没发成：', cut(scrub(p, e.message), 200));
      const status = Number.isInteger(e.code) ? e.code : 0;
      return finish({ type: 'error', status, msg: status ? e.message : cut(scrub(p, e.message), 300), me });
    } finally {
      clearTimeout(turnTimer);
      if (t) {
        if (!t.over) t.end({});
        if (p?.turn === t) p.turn = null;
        if (turns.get(ai) === t) turns.delete(ai);
      }
      if (p && !p.dead && !p.halting) armIdle(p, conf);
    }
  }
  // 一轮完了：有内容就存（被打断的标 cut），一点内容都没有就报错
  function wrapUp(ai, p, t, out, { me, save, finish, job }) {
    const stopped = !!(out.stopped || job.stopped);
    const has = !!(t.text.trim() || t.think.trim() || t.steps.length);
    const why = out.dead ? out.dead : t.reason === 'error' ? 'dsh 这一轮出错了：' + scrub(p, t.err) : '';
    if (!has) {
      if (stopped) return finish({ type: 'done', id: null, me, cut: true });
      if (why) { log('dsh', ai, why); return finish({ type: 'error', status: 0, msg: why, me }); }
      return finish({ type: 'error', status: 0, msg: 'dsh 这一轮什么也没说', me });
    }
    const cutOff = stopped || !!out.dead || t.reason === 'error' || t.reason === 'aborted' || t.interrupted;
    const msg = [why || (t.reason === 'max-tokens' ? '到了输出上限，后面没说完' : ''), ...t.notes].filter(Boolean).join('；');
    const fields = { text: t.text, ...(t.think ? { think: t.think } : {}), ...(t.steps.length ? { steps: t.steps } : {}), ...(cutOff ? { cut: true } : {}), dsh: { session: t.sid } };
    let id = null;
    try { id = save ? save(fields) : null; } catch (e) { log('dsh', ai, '回复存不进去：', e.code || e.name); }
    return finish({ type: 'done', id, me, ...(cutOff ? { cut: true } : {}), ...(msg ? { msg } : {}) });
  }

  // ---- 给前端的另外几件 ----
  // 她答确认：allow 为 true 是允许（只这一次），别的都是拒绝
  function approve(ai, id, allow) {
    const t = turns.get(ai), a = t?.asks.get(String(id ?? ''));
    if (!a) throw fail(404, '没有这个确认（可能已经超时、答过了，或者这一轮停了）');
    if (now() > a.pub.until) { a.done('rejected', 'timeout'); throw fail(404, '这个确认已经超时了，当拒绝'); } // 定时器晚到一点也不放行
    a.done(allow === true ? 'allowed-once' : 'rejected', allow === true ? 'allowed' : 'rejected');
    return { ok: true, outcome: allow === true ? 'allowed' : 'rejected' };
  }
  // 还在等她答的确认（前端断线重连后用）
  function pending(ai) {
    dirOf(ai);
    const t = turns.get(ai);
    return { items: t ? [...t.asks.values()].map((a) => ({ ...a.pub, left: Math.max(0, a.pub.until - now()) })) : [] };
  }
  // 新会话：换一个会话编号，下一句从头开始（旧的还留在 dsh home 里，不删）
  function reset(ai) {
    if (turns.has(ai)) throw fail(409, '这一轮还在跑，先停下再开新会话');
    const old = readState(ai);
    const n = { session: newSession(ai), home: old.home ?? null, used: false, t: now() };
    writeState(ai, n);
    return { ok: true, session: n.session };
  }
  function state(ai) {
    const s = readState(ai), p = procs.get(ai);
    // perm：这个会话在 dsh 那边确认过的权限（不是设置里写的那个；新会话还没发过话时是 null）
    return { kind: 'dsh', session: s.session || null, used: !!s.used, perm: s.used ? s.perm || null : null, alive: !!(p && !p.dead && !p.halting), busy: turns.has(ai) };
  }
  // 停：chat 那边按停走的是 job.abort()；这里给不经过 chat 的调用
  async function stop(ai) {
    const t = turns.get(ai), p = procs.get(ai);
    if (!t) return { ok: true, stopped: false };
    t.end({ stopped: true });
    if (p) await halt(p, '停下');
    return { ok: true, stopped: true };
  }
  // 后端要关了：把 dsh 都关掉（后端直接退出的话，dsh 读到 stdin 断了也会自己退）
  const close = (ai) => { const p = procs.get(ai); return p ? halt(p, '关掉') : Promise.resolve(); };
  const closeAll = () => Promise.all([...procs.values()].map((p) => halt(p, '后端关了')));

  return { ready, answer, approve, pending, reset, state, stop, close, closeAll, busy: (ai) => turns.has(ai) };
}
