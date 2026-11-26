// 旁听的小模型（备用的散场记）：给既不能分叉、又不想让问答留在原对话里的人用。
// 规矩参考作者另一个私用项目的接口说明「第五个时机：散场记」里「备用」那一条。
// 打开后（还要对话原文 talk 开着），散场记的时候由它读上次散场记以后的原文，写一条待整理（by: helper）。
// 它拒绝、出错、回空就跳过，只记一行日志（不带原文）；凌晨还有 48 小时原文兜底。
// 设置存在 mem.json 的 helper 一项（不放 cfg：导出不带）：{ on, url, model, keyEnv }。
// keyEnv 只存环境变量的名字（跟 ais.json 一样），key 只在发请求那一刻取：不落盘、不进返回、不进日志。
// 只认 OpenAI 兼容的 /v1/chat/completions（非流式）一种。
// 设置在网页里改（跟别的设置一样要网页登录，HOOK_TOKEN 改不了）。地址要过 lib/net.mjs 的检查：默认只许 https 公网，
// 本机的小模型（比如 Ollama）要管理员在 .env 的 ALLOW_URLS 里放行。keyEnv 不能用后端自己的口令（OURS）。
import { fail } from './store.mjs';
import { makeApiRunner } from './night.mjs';
import { OURS } from './chat.mjs';
import { makeNet, originOf } from './net.mjs';

export const HELPER = { on: false, url: '', model: '', keyEnv: '' };
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const MATERIAL = 30000; // 原文最多给它这么多字（超了从最旧的开始丢）
const SKIP = '〔跳过〕';
// 回的东西像是拒绝（短、而且一开头就是这几种说法）也当跳过：不然凌晨会把「抱歉，我不能…」写进日记
const REFUSE = /^(抱歉|对不起|很抱歉|我不能|我无法|作为一个?\s*AI|I'?m sorry|Sorry|I can(not|'t)|I am unable|As an AI)/i;

export const HELPER_PROMPT = `你在旁边听一段聊天：「她」是一个人，「TA」是陪她聊天的 AI。请替 TA 写一条「待整理」，凌晨 TA 会拿它写日记。
写这几样（没有的就不写）：这段时间发生了什么、她说的要紧的话（尽量用原话）、她的情绪、从 TA 的话里看得出的 TA 的感受。
用第一人称写成 TA 的口气（「她」指她，「我」指 TA），一段话，不超过 600 字，不要标题、不要列表。
不想写、或者这段没什么可写的，就只回 ${SKIP}。`;

const isLocal = (u) => { try { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(u).hostname); } catch { return false; } };
// url 写到域名（和端口）就补上 /v1/chat/completions；写成完整地址就原样用
export const fullUrl = (u) => (/\/chat\/completions$/.test(u) ? u : u.replace(/\/+$/, '') + '/v1/chat/completions');

// 网页设的「小模型位置」（旁听的、记忆小模型共用）：地址过 lib/net.mjs 的检查，用哪个环境变量当 Key 要管理员登记过。
// 网页能改地址和用哪个环境变量当 Key：只认本机管理员在 .env 的 HELPER_KEY_ORIGINS 登记过的「变量名 → 地址」，
// 不然登录了网页的人就能把任意一个环境变量发到任意 https 网站
export function makeSlotGuard({ net = makeNet(), keyOrigins = '' } = {}) {
  const pairs = new Set();
  for (const item of String(keyOrigins || '').split(/[,\s]+/)) {
    const i = item.indexOf('=');
    if (i < 1) continue;
    const name = item.slice(0, i);
    let u; try { u = new URL(item.slice(i + 1)); } catch { continue; }
    if (!ENV_RE.test(name) || OURS.has(name) || !originOf(u) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) continue;
    pairs.add(name + '\n' + u.origin);
  }
  function checkKey(name, target) {
    if (name && !pairs.has(name + '\n' + originOf(target))) throw fail(400, '小模型用的这个 Key 没登记能发到这个地址：在 .env 的 HELPER_KEY_ORIGINS 里加上「变量名=地址」');
  }
  // on、url、model、keyEnv 逐项校验后改进 h，回 h
  function apply(h, input = {}) {
    if (input.on !== undefined) { if (typeof input.on !== 'boolean') throw fail(400, 'on 只能是 true 或 false'); h.on = input.on; }
    if (input.url !== undefined) {
      if (input.url === '') h.url = '';
      else {
        let u;
        try { u = new URL(String(input.url)); } catch { throw fail(400, 'url 写得不对'); }
        if (!/^https?:$/.test(u.protocol)) throw fail(400, 'url 要是 http 或 https');
        if (u.username || u.password || u.search) throw fail(400, 'url 里别带口令和 ?…：key 放进环境变量，这里只写变量名（keyEnv）');
        net.okSync(u.href, 'url');
        h.url = String(input.url).replace(/\/+$/, '');
      }
    }
    if (input.model !== undefined) { if (typeof input.model !== 'string') throw fail(400, 'model 要是一段文字'); h.model = input.model.trim().slice(0, 200); }
    if (input.keyEnv !== undefined) {
      if (input.keyEnv !== '' && (typeof input.keyEnv !== 'string' || !ENV_RE.test(input.keyEnv))) throw fail(400, 'keyEnv 要写环境变量的名字（大写字母、数字、_），不是 key 本身');
      if (OURS.has(input.keyEnv)) throw fail(400, 'keyEnv 不能用后端自己的口令');
      h.keyEnv = input.keyEnv;
    }
    if (h.on && h.url) checkKey(h.keyEnv, fullUrl(h.url));
    return h;
  }
  // 真发之前再查一遍（设置之后管理员可能改了 .env、域名可能换了解析）
  async function before(h, what) {
    checkKey(h.keyEnv, fullUrl(h.url));
    await net.check(fullUrl(h.url), what);
  }
  return { apply, checkKey, before, net };
}

// keyOf(变量名) → key；timeout 测试里可以改小
// net：lib/net.mjs 的 makeNet(…)；不传就只许 https 公网地址。guard：makeSlotGuard(…)，不传就照 net、keyOrigins 现做一个
export function makeHelper({ store, digest, keyOf = () => '', log = () => {}, timeout = 60e3, net = makeNet(), keyOrigins = '', guard = makeSlotGuard({ net, keyOrigins }) }) {
  const inflight = new Set();
  const raw = (ai) => ({ ...HELPER, ...(store.load(ai).helper || {}) });
  // 给网页看的：不带 url、keyEnv（跟 /api/ais 一样），只说是不是本机地址、有没有配 key 的变量
  function get(ai) {
    const h = raw(ai);
    return { on: h.on, model: h.model, local: h.url ? isLocal(h.url) : null, key: !!h.keyEnv, talk: store.getCfg(ai).talk };
  }
  function set(ai, input = {}) {
    const h = guard.apply(raw(ai), input);
    if (h.on && (!h.url || !h.model)) throw fail(400, '打开之前先填 url 和 model');
    const d = store.load(ai);
    d.helper = h;
    store.save(ai, d);
    return get(ai);
  }
  const on = (ai) => raw(ai).on === true;

  // 散场记时调：读 since 以后的原文，请它写一段。回 { ok } 或 { skip: 原因 }，不往外抛
  async function run(ai, { since = 0, sid = null, why } = {}) {
    const h = raw(ai);
    if (!h.on) return { skip: '没打开' };
    if (!store.talk || !store.getCfg(ai).talk) { log('旁听', ai, '跳过：对话原文没开'); return { skip: '对话原文没开' }; }
    const rows = store.talk.recent(ai, { since });
    if (!rows.length) return { skip: '没有新的对话' };
    const key = h.keyEnv ? keyOf(h.keyEnv) : '';
    if (h.keyEnv && !key) { log('旁听', ai, '跳过：key 的环境变量是空的'); return { skip: '没配 key' }; }
    let budget = MATERIAL;
    const lines = [];
    for (const r of [...rows].reverse()) {
      const s = `${r.role === 'me' ? '她' : 'TA'}：${r.text}`;
      if (budget - s.length < 0) break;
      budget -= s.length + 1;
      lines.unshift(s);
    }
    let text;
    try {
      await guard.before(h, '旁听的小模型的地址');
      text = await makeApiRunner({ url: fullUrl(h.url), key, model: h.model, style: 'openai', timeout })({ system: HELPER_PROMPT, prompt: lines.join('\n') });
    } catch (e) {
      log('旁听', ai, '没写成：', e.safe ? e.message : (e.code || e.name)); // 我们自己造的错不带正文；别的只记名字
      return { skip: '出错了' };
    }
    const s = String(text || '').trim();
    if (!s || s.includes(SKIP) || (s.length < 200 && REFUSE.test(s))) { log('旁听', ai, '跳过：它没写（回空或者不写）'); return { skip: '它没写' }; }
    try { digest.add(ai, { text: s, sid, by: 'helper', why }); } catch (e) { log('旁听', ai, '存不进去：', e.code || e.name); return { skip: '存不进去' }; }
    return { ok: true };
  }
  // 不等它：散场记的接口要马上回。测试里用 idle() 等它跑完
  function kick(ai, opt) {
    const p = run(ai, opt).catch(() => ({ skip: '出错了' })).finally(() => inflight.delete(p));
    inflight.add(p);
    return p;
  }
  const idle = () => Promise.all([...inflight]);

  return { get, set, on, run, kick, idle };
}
