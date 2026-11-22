// 设置里要填的服务（不只是开关，要能填地址、模型、Key 这些配置）。
// 存在 data/svc.json（权限 600），所有 AI 共用一份：功能模型（fm）、向量（vec）、推送（push）、两个小选项（opts）。
// Key 只进不出：GET 只回「填没填、末四位」，日志也不印。PUT 时 key 不给或空 = 不换，给 null = 清掉。
// 后端用这些的地方（翻译、认字、出声、推送）从 svc.read() 取。
// Key 跟着地址走：存 Key 时记下当时地址的 origin（keyAt）。换了地址（origin 变了）又没同时填新 Key，旧 Key 清掉，要重新填；
// 用的时候也只在请求的 origin 跟 keyAt 一样时才带上（keyFor）。Bark 换了服务器，旧的设备钥匙同样清掉。
// 地址只收 https 的公网地址；本机、局域网的服务要管理员在 .env 的 ALLOW_URLS 里放行（lib/net.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './store.mjs';
import { makeNet, originOf } from './net.mjs';

export const BARK_DEFAULT = 'https://api.day.app';
// 这个 Key 能不能带去 target：只有 origin 跟存 Key 时的一样才行（旧文件没有 keyAt 的，按它自己的地址算）
export function keyFor(entry, target) {
  if (!entry?.key) return '';
  const at = entry.keyAt || originOf(entry.url);
  return at && at === originOf(target) ? entry.key : '';
}
// AES-256 要正好 32 个字节（按 UTF-8 数，不是按字数）
export const aesOk = (s) => typeof s === 'string' && Buffer.byteLength(s, 'utf8') === 32;

export const FM_KEYS = ['img', 'trans', 'stt', 'mood', 'tts', 'memo', 'cstt', 'ctts'];
const VOICED = ['tts', 'ctts'];
const ROUTES = ['web', 'bark', 'both'];
const CALL_SVC = ['same', 'own'];
const str = (v, n, what) => {
  if (typeof v !== 'string') throw fail(400, `${what}要是一段文字`);
  const s = v.trim();
  if ([...s].length > n) throw fail(400, `${what}最长 ${n} 个字`);
  return s;
};
function url(v, what) {
  const s = str(v, 500, what);
  if (!s) return '';
  let u; try { u = new URL(s); } catch { throw fail(400, `${what}写得不对`); }
  if (!/^https?:$/.test(u.protocol)) throw fail(400, `${what}要是 http 或 https`);
  if (u.username || u.password) throw fail(400, `${what}里别带口令，Key 单独填`);
  return s.replace(/\/+$/, '');
}
// key：undefined / '' 不换；null 清掉；别的是新的
function keyIn(cur, v, what) {
  if (v === undefined || v === '') return cur;
  if (v === null) return undefined;
  const s = str(v, 1000, what);
  if (/\s/.test(s)) throw fail(400, `${what}里有空格或换行，是不是多复制了`);
  return s || cur;
}
const hasNewKey = (v) => typeof v === 'string' && v.trim() !== '';
const tail = (k) => (k && k.length >= 12 ? k.slice(-4) : undefined);
const hide = (o, keyName = 'key') => {
  const { [keyName]: k, keyAt, ...rest } = o;
  return { ...rest, hasKey: !!k, ...(tail(k) ? { keyTail: tail(k) } : {}) };
};

// net：lib/net.mjs 的 makeNet(…)（管哪些地址能填）；不传就只许 https 公网地址
export function openSvc({ dir, net = makeNet() }) {
  const file = () => path.join(dir, 'svc.json');
  function read() {
    try { const d = JSON.parse(fs.readFileSync(file(), 'utf8')); return { fm: {}, vec: {}, push: {}, opts: {}, ...d }; } catch { return { fm: {}, vec: {}, push: {}, opts: {} }; }
  }
  function save(d) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file() + '.tmp', JSON.stringify(d, null, 2), { mode: 0o600 });
    fs.renameSync(file() + '.tmp', file());
    try { fs.chmodSync(file(), 0o600); } catch { /* 换名后权限跟着 tmp，这里再保险一次 */ }
  }
  // 给网页看的：不带 Key
  function view(d = read()) {
    const fm = {};
    for (const [k, v] of Object.entries(d.fm)) fm[k] = hide(v);
    const b = d.push.bark || {};
    return {
      fm, vec: hide(d.vec),
      push: { route: d.push.route || 'web', bark: { url: b.url || BARK_DEFAULT, hasDev: !!b.dev, hasAes: !!b.aes } },
      callSvc: d.opts.callSvc || 'same', asrWords: d.opts.asrWords || '',
      keepVoice: d.opts.keepVoice !== false,   // 仓库：TA 念出来的声音存下来（默认存）
    };
  }
  // 一项模型配置：服务商第几家、地址、模型、Key，再加这一项自己的几样
  function model(cur = {}, input = {}, what) {
    const o = { ...cur };
    if (input.prov !== undefined) { if (input.prov === null) delete o.prov; else { const n = Number(input.prov); if (!Number.isInteger(n) || n < 0 || n > 50) throw fail(400, '服务商要是第几家（整数）'); o.prov = n; } }
    const before = o.key ? (o.keyAt || originOf(o.url)) : '';
    if (input.url !== undefined) { o.url = url(input.url ?? '', what + '的地址'); if (o.url) net.okSync(o.url, what + '的地址'); }
    if (input.model !== undefined) o.model = str(input.model ?? '', 200, what + '的模型名');
    let k = keyIn(o.key, input.key, what + '的 Key');
    const fresh = hasNewKey(input.key);
    if (k && !fresh && before !== originOf(o.url)) k = undefined; // 换了地址又没给新 Key：旧 Key 不带到新地址去
    if (k === undefined) { delete o.key; delete o.keyAt; } else { o.key = k; o.keyAt = originOf(o.url); }
    return o;
  }
  function putFm(k, input = {}) {
    if (!FM_KEYS.includes(k)) throw fail(404, '没有这一项：' + k);
    const d = read(), o = model(d.fm[k], input, k);
    if (VOICED.includes(k) && input.voices !== undefined) {
      if (input.voices === null) delete o.voices;
      else {
        if (typeof input.voices !== 'object' || Array.isArray(input.voices)) throw fail(400, 'voices 要是 { AI: { id, speed } }');
        const vs = {};
        for (const [ai, v] of Object.entries(input.voices).slice(0, 50)) {
          if (!v || typeof v !== 'object') continue;
          const id = str(v.id ?? '', 200, '音色 ID'); if (!id) continue;
          const sp = Number(v.speed ?? 1);
          vs[String(ai).slice(0, 40)] = { id, speed: Number.isFinite(sp) ? Math.max(0.5, Math.min(2, Math.round(sp * 100) / 100)) : 1 };
        }
        o.voices = vs;
      }
    }
    if (k === 'img') {
      for (const [f, lo, hi] of [['steps', 1, 50], ['scale', 1, 20], ['seed', 0, 2 ** 32]]) {
        if (input[f] === undefined) continue;
        const n = Number(input[f]); if (!Number.isFinite(n) || n < lo || n > hi) throw fail(400, `${f} 要在 ${lo} 到 ${hi} 之间`); o[f] = n;
      }
      if (input.size !== undefined) o.size = str(input.size, 20, '尺寸');
      if (input.neg !== undefined) o.neg = str(input.neg, 2000, '不要什么');
    }
    d.fm[k] = o; save(d);
    return view(d).fm[k];
  }
  function putVec(input = {}) { const d = read(); d.vec = model(d.vec, input, '向量'); save(d); return view(d).vec; }
  function putPush(input = {}) {
    const d = read(), p = { ...d.push };
    if (input.route !== undefined) { if (!ROUTES.includes(input.route)) throw fail(400, 'route 只能是 web、bark、both'); p.route = input.route; }
    if (input.bark !== undefined) {
      const b = { ...(p.bark || {}) }, i = input.bark || {};
      const before = originOf(b.url || BARK_DEFAULT);
      if (i.url !== undefined) {
        b.url = url(i.url ?? '', 'Bark 服务器') || BARK_DEFAULT;
        const u = new URL(b.url);
        if (u.search || u.hash || String(i.url).includes('?') || String(i.url).includes('#')) throw fail(400, 'Bark 服务器只写到地址本身，别带 ?… 或 #…，设备钥匙单独填');
        // 只许官方服务器；自己搭的 Bark 服务器要管理员在 .env 的 ALLOW_URLS 里放行
        if (u.origin !== BARK_DEFAULT && !net.allowed(b.url)) throw fail(400, '只能用官方的 https://api.day.app；自己搭的 Bark 服务器要先在 .env 的 ALLOW_URLS 里放行');
      }
      let dev = keyIn(b.dev, i.dev, 'Bark 设备钥匙');
      const fresh = hasNewKey(i.dev);
      if (dev && !fresh && before !== originOf(b.url || BARK_DEFAULT)) dev = undefined; // 换了服务器：旧的设备钥匙不带过去
      if (dev === undefined) delete b.dev; else b.dev = dev;
      const aes = keyIn(b.aes, i.aes, 'Bark 加密钥匙');
      if (aes !== undefined && !aesOk(aes)) throw fail(400, '加密钥匙要正好 32 个字节（32 个英文字母或数字）');
      if (aes === undefined) delete b.aes; else b.aes = aes;
      p.bark = b;
    }
    d.push = p; save(d);
    return view(d).push;
  }
  function putOpts(input = {}) {
    const d = read(), o = { ...d.opts };
    if (input.callSvc !== undefined) { if (!CALL_SVC.includes(input.callSvc)) throw fail(400, 'callSvc 只能是 same、own'); o.callSvc = input.callSvc; }
    if (input.asrWords !== undefined) o.asrWords = str(input.asrWords ?? '', 500, '常被认错的词');
    if (input.keepVoice !== undefined) { if (typeof input.keepVoice !== 'boolean') throw fail(400, 'keepVoice 要是 true 或 false'); o.keepVoice = input.keepVoice; }
    d.opts = o; save(d);
    const v = view(d); return { callSvc: v.callSvc, asrWords: v.asrWords, keepVoice: v.keepVoice };
  }
  return { read, view, putFm, putVec, putPush, putOpts };
}
