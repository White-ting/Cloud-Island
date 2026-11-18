// 聊天：给「走 API」的 TA。前端把她的话发过来，这里去调模型，把回复流回前端，存聊天记录。
// 规矩参考作者另一个私用项目的接口说明「一条消息长什么样」「必须有的」「有了更好的」「走 API 时聊天记录带多少」。
// 跟网关（lib/gateway.mjs）的分别：网关替别的 App 转发，聊天记录在 App 手里；这里聊天记录在我们手里。
// 四种协议「她的话在哪、开场放哪、回复的文字在哪」、扣小记，都用网关那一套（ASK、eachText、makeCut）。
// 记忆是添头，聊天是正事：开场、每条消息前、回复之后任何一步出错，都当这一步没有，只记一行日志。
//
// 没拿真接口核实过的（只拿测试里的假上游跑过）：
// - 打开思考：Anthropic 发 thinking:{type:"enabled",budget_tokens}；Responses 发 reasoning:{summary:"auto"}；
//   Gemini 发 generationConfig.thinkingConfig.includeThoughts；OpenAI 对话式什么都不发，只认回来的增量。
// - 思考的增量：对话式 delta.reasoning_content、Responses response.reasoning_summary_text.delta、
//   Anthropic thinking_delta、Gemini 带 thought:true 的 part。
// - 图片：对话式 image_url、Responses input_image、Anthropic image（base64 / url）、Gemini inlineData / fileData。
// - 流里的工具调用：对话式 delta.tool_calls、Responses output_item.done 里的 function_call、
//   Anthropic tool_use 块、Gemini functionCall。只原样记成一步，不执行（这一批走 API 的 TA 没有工具）。
//
// 文件：data/ais.json（有哪几个 AI，只存环境变量的名字，不存 key）；data/<ai>/chat.jsonl（一行一条消息，权限 600）；
// data/<ai>/said.jsonl（TA 主动开口说过的话，一行 { t, why, gist }，留 30 天；不进导出、不进搜索）。
//
// TA 主动开口（wake）：收件箱叫醒 TA 时用。不存「她的一句」，最后一条给模型看的提示不存、不显示；
// TA 可以不说（去掉小记后是空的、或只有〔不说〕）。她发来一句时，正在进行的 wake 让给她（断开、不存，收件箱晚点再来）。
// key 只在发请求那一刻从环境里取：不落盘、不进任何返回、不进日志和报错。
//
// 散场记（digest）：她停 digestIdle 分钟（记忆库设置，默认 15，0 是关）以后，后端自己带着同样的聊天记录 + 散场记的问话多发一次请求，
// 不进聊天记录，只把小记交给记忆库（③ 带 quiet）；记下了东西就在最后一条消息上留 digest: { n, kinds }（几条、哪几种，不带内容）。
// 她这时又发话，散场记让给她（跟 TA 主动开口一样）。定时器可以注入（测试里用假的），真的那个 unref，不留住进程。
// 快压缩时也做一次（why: compact）：走 API 的「压缩」就是上下文设成 all 又配了 ctxMax、超了从最旧的开始不带；
// 这里自己算出离那一步还剩多少当 ctxLeft 交给②，②说跌进 10% 了（digest: true），这一句回完就问一次。别的设置没有压缩，不做。
// 一场结束：走 API 的聊天没有明确的结束，不做。
// 后端重启：定时器丢了，boot() 照「她最后一句的时间」和「上次散场记的时间」把还该问的重新挂上。
//
// 拍一拍（pat）：消息 { id, role, t, pat: { n, tail? } }，没有 text；一分钟内同一方连着拍合成一条。不发给模型（她拍的那一下另外带）。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { fail } from './store.mjs';
import { split } from './notes.mjs';
import { ASK, eachText, wholeText, makeCut } from './gateway.mjs';
import { cleanDsh, pubDsh, openDsh, OURS } from './dsh.mjs';
export { OURS }; // 后端自己的口令和设置不许拿去当某个 AI 的 key（名单在 dsh.mjs）

const SIX_H = 6 * 3600e3;
const STYLES = { openai: 'chat', responses: 'resp', anthropic: 'claude', gemini: 'gemini' }; // ais.json 的写法 → 网关里的叫法
const FAMILY = { openai: 'openai', responses: 'openai', anthropic: 'anthropic', gemini: 'gemini' };
const UP_NAME = { openai: 'UPSTREAM_OPENAI', anthropic: 'UPSTREAM_ANTHROPIC', gemini: 'UPSTREAM_GEMINI' };
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const IMG_MAX = 8;
const len = (s) => [...String(s || '')].length;
const cutTo = (s, n) => { const c = [...String(s || '')]; return c.length > n ? c.slice(0, n).join('') + '…' : c.join(''); };
const SAID_KEEP = 30 * 864e5, SAID_GIST = 80, SAID_SHOW = 10;
const SILENT = '〔不说〕';
const WHY = { knock: '外面有事，守门人送来了简报', idle: '空下来了，这段时间是你的', later: '你自己定的回头看到点了', sched: '她定的时间到了' };
// 发给模型的第一句要是她的（Anthropic、Gemini 不收 TA 开头的；另外两家也一样处理）：
// 截出来的历史第一句是 TA 的，就在最前面补一句占位的她的话，TA 那句不丢
const PAD_CUT = '（前面的聊天没有带上）', PAD_FIRST = '（这里还没有她的话，是你先开的口）';
// 打电话（发一句时带 call: true）：给模型的那一份末尾加一行提醒，不存、不显示。
// 一通电话只在头一句带整段，之后 30 分钟内只带短的一行；call: 'start' 表示新的一通，重新带整段（写法参考作者另一个私用项目）
const CALL_TAG = '〔通话：她在跟你打电话，这句是她说话转成的字。回得像说话：短、口语，别用列表、标题、代码和表情，一次别说太长。〕';
const CALL_TAG_SHORT = '〔通话：你们正在通话中〕';
const CALL_AGAIN = 30 * 60e3;
const ASK_WAIT = 120e3; // 单问一句（开屏字幕这类）最多等这么久
function lead(turns, cut) {
  return turns[0]?.role === 'assistant' ? [{ role: 'user', text: cut ? PAD_CUT : PAD_FIRST, img: [] }, ...turns] : turns;
}

// ---- 有哪几个 AI ----
// 校验一个 AI 的设置，只留认得的那几项（别的字段，比如有人顺手写了 key，直接扔掉不落盘）。报错不带她填的值
function cleanAi(x, i) {
  const at = `第 ${i + 1} 个`;
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw fail(400, `${at}不是一个对象`);
  if (x.kind === 'dsh') return cleanDsh(x, i);
  const id = String(x.id ?? '');
  if (!ID_RE.test(id)) throw fail(400, `${at}的 id 只能是字母、数字、_ 和 -`);
  if (typeof x.model !== 'string' || !x.model.trim()) throw fail(400, `${id} 没写 model`);
  if (!STYLES[x.style]) throw fail(400, `${id} 的 style 只能是 openai、responses、anthropic、gemini`);
  const a = { id, model: x.model.trim(), style: x.style };
  for (const k of ['name', 'avatar']) {
    if (x[k] == null || x[k] === '') continue;
    if (typeof x[k] !== 'string') throw fail(400, `${id} 的 ${k} 要是一段文字`);
    a[k] = x[k].slice(0, k === 'name' ? 40 : 2000);
  }
  if (x.url != null && x.url !== '') {
    let u;
    try { u = new URL(String(x.url)); } catch { throw fail(400, `${id} 的 url 写得不对`); }
    if (!/^https?:$/.test(u.protocol)) throw fail(400, `${id} 的 url 要是 http 或 https`);
    if (u.username || u.password || u.search) throw fail(400, `${id} 的 url 里别带口令和 ?…：key 放进环境变量，这里只写变量名（keyEnv）`);
    a.url = String(x.url).replace(/\/+$/, '');
  }
  if (x.keyEnv != null && x.keyEnv !== '') {
    if (typeof x.keyEnv !== 'string' || !ENV_RE.test(x.keyEnv)) throw fail(400, `${id} 的 keyEnv 要写环境变量的名字（大写字母、数字、_），不是 key 本身`);
    if (OURS.has(x.keyEnv)) throw fail(400, `${id} 的 keyEnv 不能用后端自己的口令`);
    a.keyEnv = x.keyEnv;
  }
  for (const k of ['think', 'notes']) {
    if (x[k] == null) continue;
    if (typeof x[k] !== 'boolean') throw fail(400, `${id} 的 ${k} 只能是 true 或 false`);
    a[k] = x[k];
  }
  for (const [k, lo, hi] of [['maxTokens', 1, 1e6], ['ctxMax', 100, 1e8]]) {
    if (x[k] == null) continue;
    const n = Number(x[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) throw fail(400, `${id} 的 ${k} 要是 ${lo} 到 ${hi} 的整数`);
    a[k] = n;
  }
  return a;
}
// 给前端看的：不带 url、keyEnv
const pub = (a) => (a.kind === 'dsh' ? pubDsh(a) : { id: a.id, ...(a.name ? { name: a.name } : {}), model: a.model, ...(a.avatar ? { avatar: a.avatar } : {}), notes: !!a.notes });

// ---- 发给模型的那一份 ----
function mimeOf(u) {
  const e = (/\.([a-z0-9]+)(?:$|[?#])/i.exec(u)?.[1] || '').toLowerCase();
  return { png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic' }[e] || 'image/jpeg';
}
// 一张图在各家怎么写：data: 开头的是 base64，别的是网址
function imgPart(kind, u) {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(u);
  if (kind === 'chat') return { type: 'image_url', image_url: { url: u } };
  if (kind === 'resp') return { type: 'input_image', image_url: u };
  if (kind === 'claude') return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'image', source: { type: 'url', url: u } };
  return m ? { inlineData: { mimeType: m[1], data: m[2] } } : { fileData: { mimeType: mimeOf(u), fileUri: u } };
}
// 挨着的同一方合成一轮（她那句没等到回复又说了一句；有的家不收连着两条 user）
function merge(turns) {
  const out = [];
  for (const t of turns) {
    if (!t.text && !t.img.length) continue;
    const last = out.at(-1);
    if (last && last.role === t.role) { last.text = [last.text, t.text].filter(Boolean).join('\n\n'); last.img.push(...t.img); } else out.push({ ...t, img: [...t.img] });
  }
  return out;
}
function buildBody(conf, kind, turns) {
  const { model, maxTokens, think } = conf;
  const parts = (t, txt, img) => [...(t.text ? [txt(t.text)] : []), ...t.img.map((u) => img(u))];
  if (kind === 'chat') {
    return { model, stream: true, stream_options: { include_usage: true }, ...(maxTokens ? { max_tokens: maxTokens } : {}),
      messages: turns.map((t) => ({ role: t.role, content: t.img.length ? parts(t, (text) => ({ type: 'text', text }), (u) => imgPart(kind, u)) : t.text })) };
  }
  if (kind === 'resp') {
    return { model, stream: true, ...(maxTokens ? { max_output_tokens: maxTokens } : {}), ...(think ? { reasoning: { summary: 'auto' } } : {}),
      input: turns.map((t) => (t.role === 'user' && t.img.length
        ? { role: 'user', content: parts(t, (text) => ({ type: 'input_text', text }), (u) => imgPart(kind, u)) }
        : { role: t.role, content: t.text })) };
  }
  if (kind === 'claude') {
    let mt = maxTokens || 8192;
    const th = think ? { type: 'enabled', budget_tokens: Math.max(1024, Math.floor(mt / 2)) } : null;
    if (th && th.budget_tokens >= mt) mt = th.budget_tokens + 1024; // 思考的预算要比 max_tokens 小
    // cache_control 写在最外层：Anthropic 自己把缓存点放在最后一块上，前面没变的那一大段下次按一折算
    return { model, max_tokens: mt, stream: true, cache_control: { type: 'ephemeral' }, ...(th ? { thinking: th } : {}),
      messages: turns.map((t) => ({ role: t.role, content: t.img.length ? parts(t, (text) => ({ type: 'text', text }), (u) => imgPart(kind, u)) : t.text })) };
  }
  const gc = { ...(maxTokens ? { maxOutputTokens: maxTokens } : {}), ...(think ? { thinkingConfig: { includeThoughts: true } } : {}) };
  return { contents: turns.map((t) => ({ role: t.role === 'user' ? 'user' : 'model', parts: parts(t, (text) => ({ text }), (u) => imgPart(kind, u)) })),
    ...(Object.keys(gc).length ? { generationConfig: gc } : {}) };
}
function headersFor(style, key) {
  const h = { 'content-type': 'application/json', accept: 'text/event-stream', 'accept-encoding': 'identity' };
  if (style === 'anthropic') { h['anthropic-version'] = '2023-06-01'; if (key) h['x-api-key'] = key; } else if (style === 'gemini') { if (key) h['x-goog-api-key'] = key; } else if (key) h.authorization = 'Bearer ' + key;
  return h;
}

// ---- 收回来的那一份 ----
// 上游的 SSE：一个事件交给 on(对象)；看不懂的事件跳过
function sseSplit(on) {
  let buf = '';
  const block = (b) => {
    const data = b.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    let o;
    try { o = JSON.parse(data); } catch { return; }
    on(o);
  };
  return {
    push(s) {
      buf += s;
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) { block(buf.slice(0, m.index)); buf = buf.slice(m.index + m[0].length); }
    },
    end() { if (buf.trim()) block(buf); buf = ''; },
  };
}
// 这一次用了多少：{ in 发过去的, hit 其中命中缓存的, out 回来的 }。各家字段不一样，认不出就 null
// 流里的事件和不给流时的整个 JSON 都能喂
export function usageOf(kind, o) {
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  if (kind === 'chat') {
    const u = o?.usage;
    if (!u || typeof u !== 'object') return null;
    return { in: n(u.prompt_tokens), hit: n(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens), out: n(u.completion_tokens) };
  }
  if (kind === 'resp') {
    const u = o?.type === 'response.completed' ? o.response?.usage : (o?.object === 'response' ? o.usage : null);
    if (!u || typeof u !== 'object') return null;
    return { in: n(u.input_tokens), hit: n(u.input_tokens_details?.cached_tokens), out: n(u.output_tokens) };
  }
  if (kind === 'claude') {
    const u = o?.type === 'message_start' ? o.message?.usage : o?.usage; // message_start 给发过去的，message_delta 给回来的
    if (!u || typeof u !== 'object') return null;
    const has = 'input_tokens' in u || 'cache_read_input_tokens' in u;
    return { ...(has ? { in: n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens), hit: n(u.cache_read_input_tokens) } : {}),
      ...('output_tokens' in u ? { out: n(u.output_tokens) } : {}) };
  }
  const u = o?.usageMetadata;
  if (!u || typeof u !== 'object') return null;
  return { in: n(u.promptTokenCount), hit: n(u.cachedContentTokenCount), out: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount) };
}
const parseOr = (s, d) => { if (!s) return d ?? {}; try { return JSON.parse(s); } catch { return s; } };
// 每种协议里思考和工具调用在哪（正文走网关的 eachText）。on: { text, think, step, fail }
function makeReader(kind, on) {
  const calls = new Map(); // 边来边拼的工具调用：键 → { name, input }
  function event(o) {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'error' || o.type === 'response.failed' || (o.error && !o.choices && !o.candidates)) { on.fail(); return; } // 流里报错
    const u = usageOf(kind, o);
    if (u) on.usage?.(u);
    eachText(kind, o, on.text);
    if (kind === 'chat') {
      for (const c of o.choices || []) {
        if ((c?.index ?? 0) !== 0) continue;
        const d = c.delta || {};
        if (typeof d.reasoning_content === 'string' && d.reasoning_content) on.think(d.reasoning_content);
        for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
          const k = tc?.index ?? 0, cur = calls.get(k) || { name: '', input: '' };
          if (typeof tc?.function?.name === 'string') cur.name += tc.function.name;
          if (typeof tc?.function?.arguments === 'string') cur.input += tc.function.arguments;
          calls.set(k, cur);
        }
      }
    } else if (kind === 'resp') {
      if (o.type === 'response.reasoning_summary_text.delta' && typeof o.delta === 'string') on.think(o.delta);
      if (o.type === 'response.output_item.done' && o.item?.type === 'function_call') on.step({ name: String(o.item.name || ''), input: o.item.arguments ?? '' });
    } else if (kind === 'claude') {
      if (o.type === 'content_block_delta' && o.delta?.type === 'thinking_delta' && typeof o.delta.thinking === 'string') on.think(o.delta.thinking);
      if (o.type === 'content_block_start' && o.content_block?.type === 'tool_use') calls.set(o.index, { name: String(o.content_block.name || ''), input: '', obj: o.content_block.input });
      if (o.type === 'content_block_delta' && o.delta?.type === 'input_json_delta' && calls.has(o.index)) calls.get(o.index).input += o.delta.partial_json || '';
      if (o.type === 'content_block_stop' && calls.has(o.index)) { const c = calls.get(o.index); calls.delete(o.index); on.step({ name: c.name, input: parseOr(c.input, c.obj) }); }
    } else {
      for (const c of o.candidates || []) {
        if ((c?.index ?? 0) !== 0) continue;
        for (const p of c?.content?.parts || []) {
          if (p?.thought && typeof p.text === 'string' && p.text) on.think(p.text);
          const fc = p?.functionCall || p?.function_call;
          if (fc) on.step({ name: String(fc.name || ''), input: fc.args ?? {} });
        }
      }
    }
  }
  // 流收完：对话式的工具调用这时才拼齐
  const end = () => { for (const c of calls.values()) on.step({ name: c.name, input: c.input }); calls.clear(); };
  return { event, end };
}

// 上游报错时给她看的一句话（不带请求体、不带 key）
function human(status) {
  if (status === 401 || status === 403) return '上游说 key 不对，或者没有权限';
  if (status === 404) return '上游找不到这个地址或模型，看看 url 和 model';
  if (status === 429) return '上游说太频繁了，或者额度用完了';
  if (status === 400 || status === 422) return '上游不收这个请求（可能是模型不认某个字段）';
  if (status >= 500) return '上游自己出错了，过一会儿再试';
  return `上游回了 ${status}`;
}
// 上游错误里的那句说明：只取 message，抹掉 key，截到 200 字
function detailOf(text, key) {
  let s = '';
  try { const o = JSON.parse(text); const e = Array.isArray(o) ? o[0]?.error : o?.error; s = typeof e === 'string' ? e : e?.message || o?.message || ''; } catch { /* 不是 JSON 就不给 */ }
  s = String(s);
  if (key && key.length >= 4) s = s.split(key).join('***');
  return cutTo(s.replace(/\s+/g, ' ').trim(), 200);
}
// 中途断了：最后那段没收完的 <!--… 不算
function dropOpen(raw) {
  const i = raw.lastIndexOf('<!--');
  return i >= 0 && raw.indexOf('-->', i) < 0 ? raw.slice(0, i) : raw;
}

// 发一次请求，边收边交给 cb.chunk；job.abort() 会断开上游
function callUp(url, headers, payload, job, cb) {
  return new Promise((resolve) => {
    let over = false;
    const done = (x) => { if (!over) { over = true; resolve(x); } };
    if (job.stopped) return done({ stopped: true });
    let u;
    try { u = new URL(url); } catch { return done({ net: true }); }
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(payload) } });
    job.abort = () => { job.stopped = true; req.destroy(); done({ stopped: true }); };
    req.on('error', () => done(job.stopped ? { stopped: true } : { net: true }));
    req.on('response', (r) => {
      const status = r.statusCode;
      r.on('error', () => {});
      if (status < 200 || status >= 300) {
        const chunks = [];
        let n = 0;
        r.on('data', (c) => { if ((n += c.length) <= 64 * 1024) chunks.push(c); });
        r.on('end', () => done({ status, errText: Buffer.concat(chunks).toString('utf8') }));
        r.on('close', () => done({ status, errText: '' }));
        return;
      }
      const sse = /text\/event-stream/i.test(String(r.headers['content-type'] || ''));
      const dec = new TextDecoder(), chunks = [];
      r.on('data', (c) => { if (sse) cb.chunk(dec.decode(c, { stream: true })); else chunks.push(c); });
      r.on('end', () => {
        if (sse) { cb.chunk(dec.decode()); cb.end(); } else cb.whole(Buffer.concat(chunks).toString('utf8'));
        done({ ok: true, status });
      });
      r.on('close', () => { if (!r.complete) done({ status, broken: true }); });
    });
    req.end(payload);
  });
}

// dir：数据文件夹（ais.json 放这里）；upstream：.env 里那三家（ais.json 里没写 url 时用）；keyOf(变量名) → key
// tz：主动开口时那一行「现在几点」按哪个时区；onWake(ai, 消息, { push })：TA 主动说了一句之后调（接推送），出错不管
// onReply(ai, { id, text, again })：她发一句、TA 回完存好以后调（网页不在前台时推送用），出错不管
// pat：lib/pat.mjs（拍一拍的设置和挂起的那几下），没传就拍不了
// timers：{ set(fn, ms) → 句柄, clear(句柄) }，散场记的定时器用；不传用真的（unref）
const REAL_TIMERS = { set: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; }, clear: (h) => clearTimeout(h) };
const PAT_MERGE = 60e3; // 一分钟内同一方连着拍，合成一条
const BOOT_WAIT = 30e3; // 重启时散场记已经过点了：等这么久再问
const BOOT_GAP = 30e3;  // 好几个 AI 都过点了：一个隔一个问，不一起挤上去
// 「拍了拍，现在就回」时没有前端在等流：给 answer 一个什么都不写的 res
const sink = () => ({ headersSent: false, writableEnded: false, destroyed: false, writeHead() {}, flushHeaders() {}, write() {}, end() { this.writableEnded = true; } });

export function openChat({ dir, store, hooks = null, persona = null, pat = null, files = null, upstream = {}, keyOf = () => '', log = () => {}, now = store.now, tz, onWake = () => {}, onReply = () => {}, timers = REAL_TIMERS }) {
  const dsh = openDsh({ dir, folder: (ai) => store.folder(ai), keyOf, log, now });
  const callAt = new Map();  // 每个 AI 上次带整段通话提醒的时间
  function callTag(ai, call) {
    if (!call) return '';
    const t = now(), last = callAt.get(ai);
    if (call !== 'start' && last && t - last < CALL_AGAIN) return CALL_TAG_SHORT;
    callAt.set(ai, t);
    return CALL_TAG;
  }
  const cuts = new Map();    // 每个 AI 上次把聊天记录切在哪一句（pick 用）
  const plain = new Set();   // 上游不收附加项（要用量的 stream_options、Claude 的 cache_control）的那几个 AI：以后不带
  // ---- 用量和缓存命中：每调一次上游记一行到 data/usage.jsonl（只有数，没有内容）----
  const usageFile = () => path.join(dir, 'usage.jsonl');
  function noteUsage(ai, conf, what, u) {
    if (!u || u.in == null) return;
    const row = { t: now(), ai, model: conf.model, what, in: u.in, hit: Math.min(u.hit || 0, u.in), out: u.out || 0 };
    try { fs.appendFileSync(usageFile(), JSON.stringify(row) + '\n', { mode: 0o600 }); } catch { /* 记不下就算了 */ }
    log('用量', ai, `发过去 ${row.in}，命中缓存 ${row.hit}（${row.in ? Math.round((row.hit / row.in) * 100) : 0}%），回来 ${row.out}`);
  }
  // 最近 days 天每个 AI 的合计：{ ai: { n 次数, in, hit, out, rate 命中率（0 到 1）, last: 最近一次 { t, in, hit, what } } }（last 给网页右上角「容量」那圈用）
  function usage({ days = 7 } = {}) {
    const d = Math.min(Math.max(Number(days) || 7, 1), 365), since = now() - d * 864e5, out = {};
    let txt = '';
    try { txt = fs.readFileSync(usageFile(), 'utf8'); } catch { /* 还没有 */ }
    for (const line of txt.split('\n')) {
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || r.t < since) continue;
      const o = (out[r.ai] ??= { n: 0, in: 0, hit: 0, out: 0 });
      o.n++; o.in += r.in || 0; o.hit += r.hit || 0; o.out += r.out || 0;
      if (!o.last || r.t >= o.last.t) o.last = { t: r.t, in: r.in || 0, hit: r.hit || 0, what: r.what };
    }
    for (const o of Object.values(out)) o.rate = o.in ? Math.round((o.hit / o.in) * 1000) / 1000 : 0;
    return { days: d, ais: out };
  }
  // 调上游。上游回 400 而这次带了附加项：去掉再试一次，记住这个 AI 以后不带（有的中转不认这些字段）
  async function upCall(ai, conf, url, key, body, job, cb) {
    const extra = ['stream_options', 'cache_control'].filter((k) => k in body);
    if (plain.has(ai)) for (const k of extra) delete body[k];
    let r = await callUp(url, headersFor(conf.style, key), JSON.stringify(body), job, cb);
    if (r.status === 400 && !plain.has(ai) && extra.length) {
      for (const k of extra) delete body[k];
      const r2 = await callUp(url, headersFor(conf.style, key), JSON.stringify(body), job, cb);
      if (r2.ok) { plain.add(ai); log('聊天', ai, '上游不收用量、缓存那两个附加项，以后不带'); }
      r = r2;
    }
    return r;
  }
  const memos = new Map();   // 每个 AI 一份，只在内存里：这一场的开场、sid、上一句的时间、上次带的第一句、每条消息前那段
  const running = new Map(); // ai → 正在跑的那一句（job.wake：TA 主动开口、散场记这种，她一说话就让给她）
  const idleT = new Map();   // ai → 散场记的定时器
  const due = new Set();     // 快压缩了、这一句回完要做一次散场记的 AI
  const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: tz || undefined, month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

  // ---- ais.json ----
  const aisFile = () => path.join(dir, 'ais.json');
  function readAis() {
    let arr;
    try { arr = JSON.parse(fs.readFileSync(aisFile(), 'utf8')); } catch { return []; }
    if (!Array.isArray(arr)) return [];
    const out = [];
    arr.forEach((x, i) => { try { out.push(cleanAi(x, i)); } catch { /* 坏的一个跳过 */ } });
    return out;
  }
  const ais = () => readAis().map(pub);
  function setAis(input) {
    const arr = Array.isArray(input) ? input : input?.items;
    if (!Array.isArray(arr)) throw fail(400, '要传一个数组：[{ id, model, style, … }]');
    const list = arr.map(cleanAi), seen = new Set();
    for (const a of list) { if (seen.has(a.id)) throw fail(400, `id 重复了：${a.id}`); seen.add(a.id); }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(aisFile() + '.tmp', JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(aisFile() + '.tmp', aisFile()); // 先写旁边再换名
    return { ok: true, ais: list.map(pub) };
  }
  function confOf(ai) {
    store.folder(ai);
    const a = readAis().find((x) => x.id === ai);
    if (!a) throw fail(404, '没有这个 AI（data/ais.json 里没写）');
    return a;
  }
  // 发之前就能知道的毛病先拦下：她那句也不存，改好了再发
  function ready(conf) {
    if (conf.kind === 'dsh') throw fail(400, `${conf.id} 是 dsh 的 TA，不支持这个（重新生成、主动开口、散场记、单问一句）`);
    const fam = FAMILY[conf.style], base = conf.url || upstream[fam];
    if (!base) throw fail(503, `${conf.id} 没写 url，.env 里也没配 ${UP_NAME[fam]}`);
    const key = conf.keyEnv ? keyOf(conf.keyEnv) : '';
    if (conf.keyEnv && !key) throw fail(503, `${conf.id} 的 key 没配：环境变量 ${conf.keyEnv} 是空的`);
    const b = base.replace(/\/+$/, '');
    // url 写成了完整地址（…/chat/completions、…/responses、…/messages）就原样用；不然跟 .env 的三家一样，只写到域名
    const tail = { openai: '/v1/chat/completions', responses: '/v1/responses', anthropic: '/v1/messages',
      gemini: `/v1beta/models/${encodeURIComponent(conf.model)}:streamGenerateContent?alt=sse` }[conf.style];
    const url = conf.style !== 'gemini' && /\/(chat\/completions|responses|messages)$/.test(b) ? b : b + tail;
    return { url, key };
  }

  // ---- chat.jsonl ----
  const file = (ai) => path.join(store.folder(ai), 'chat.jsonl');
  function readAll(ai) {
    let s;
    try { s = fs.readFileSync(file(ai), 'utf8'); } catch { return []; }
    const out = [];
    for (const l of s.split('\n')) { if (!l) continue; try { const m = JSON.parse(l); if (m && m.id) out.push(m); } catch { /* 坏的一行跳过 */ } }
    return out;
  }
  function append(ai, m) {
    const f = file(ai);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(m) + '\n', { mode: 0o600 });
  }
  // 改一条：整份重写（先写旁边再换名）。看不懂的行原样留着
  function change(ai, id, fn) {
    const f = file(ai);
    let lines;
    try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { throw fail(404, '没有这条消息'); }
    let hit = null;
    const out = lines.map((l) => {
      if (hit || !l) return l;
      let m;
      try { m = JSON.parse(l); } catch { return l; }
      if (m?.id !== id) return l;
      fn(m);
      hit = m;
      return JSON.stringify(m);
    });
    if (!hit) throw fail(404, '没有这条消息');
    fs.writeFileSync(f + '.tmp', out.join('\n'), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f);
    return hit;
  }
  const newId = () => 'c' + now().toString(36) + crypto.randomBytes(3).toString('hex');
  const talks = (m) => !m.gone && !m.pat; // 发给模型的：没删的、不是拍一拍的
  const noPat = (marks) => (marks || []).filter((x) => x.kind !== 'pat'); // 拍一拍单独成一行，不进回复下面的小字

  // 往前翻：before 是消息编号（或时间戳），新的在后；gone=1 只看删掉的
  // turns：按「她一句 + 后面的回复」算一轮，往前数这么多轮（给了就不看 limit，最多 100 轮、兜底 2000 条）；她的第一句前面 TA 先开口的那几句也算进最早那一轮
  function list(ai, { before, limit, turns, gone = false } = {}) {
    store.folder(ai);
    let ms = readAll(ai).filter((m) => !!m.gone === !!gone);
    if (before) {
      const i = ms.findIndex((m) => m.id === before);
      ms = i >= 0 ? ms.slice(0, i) : ms.filter((m) => m.t < Number(before));
    }
    if (turns != null && turns !== '') {
      const want = Math.max(1, Math.min(100, Number(turns) || 20));
      let k = ms.length, seen = 0;
      while (k > 0 && ms.length - k < 2000) { k--; if (ms[k].role === 'me' && ++seen === want) break; }
      if (seen < want) k = Math.max(0, ms.length - 2000);
      return { items: ms.slice(k), more: k > 0 };
    }
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    return { items: ms.slice(-n), more: ms.length > n };
  }
  // 删 = 标 gone，不真删；不再给前端、不再发给模型
  function remove(ai, id) {
    store.folder(ai);
    const m = change(ai, id, (x) => { if (!x.gone) x.gone = now(); });
    return { ok: true, gone: m.gone };
  }
  function restore(ai, id) {
    store.folder(ai);
    if (!readAll(ai).find((m) => m.id === id)?.gone) throw fail(400, '这一句没有删');
    return change(ai, id, (x) => { delete x.gone; });
  }
  // 编辑一句的正文（她的、TA 的都行）
  function edit(ai, id, { text } = {}) {
    store.folder(ai);
    if (typeof text !== 'string' || !text.trim()) throw fail(400, '内容是空的');
    if (readAll(ai).find((m) => m.id === id)?.gone) throw fail(400, '这一句删掉了，先恢复');
    return change(ai, id, (x) => { x.text = text; x.edited = now(); });
  }

  // ---- 上下文带多少：存在记忆库设置的 cfg.chatCtx ----
  function getCtx(ai) { const c = store.load(ai).cfg.chatCtx; return c ? { ...c } : { mode: 'all' }; }
  function setCtx(ai, input = {}) {
    const mode = input.mode;
    let c;
    if (mode === 'all') c = { mode };
    else if (mode === 'range') {
      const ids = readAll(ai).map((m) => m.id);
      const from = String(input.from ?? ''), to = input.to == null || input.to === '' ? null : String(input.to);
      const i = ids.indexOf(from), j = to == null ? Infinity : ids.indexOf(to);
      if (i < 0) throw fail(400, '起点那句找不到');
      if (j < 0) throw fail(400, '终点那句找不到');
      if (j < i) throw fail(400, '终点在起点前面');
      c = { mode, from, ...(to ? { to } : {}) };
    } else if (mode === 'last') {
      const n = Number(input.n);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw fail(400, '最近几轮要是 1 到 500 的整数');
      c = { mode, n };
    } else throw fail(400, 'mode 只能是 all、range、last');
    const d = store.load(ai);
    d.cfg.chatCtx = c;
    store.save(ai, d);
    cuts.delete(ai);
    const memo = memos.get(ai);
    if (memo) memo.ctxChanged = true; // 下一句看前面是不是被截掉了，截掉了重新取开场
    return c;
  }
  // 按设置挑历史。prior：她这句之前、没删的；all：整份（range 认位置用）；curLen：她这句的字数
  // left：离「从最旧的开始不带」还剩多少（0 到 1），只有 all + ctxMax 才有（这就是走 API 时的「压缩」），别的是 null
  // 截断点要站稳（11-17，为了上游的缓存）：各家缓存都是「开头一样才算命中」，每句都往后挪一条就永远命中不了。
  // 所以切一次就多切掉一截，然后原地不动，等又攒满了再切下一次。切在哪记在 cuts 里（只在内存；重启后重算一次）
  const CUT_TO = 0.7;   // all + ctxMax：超了就切到 ctxMax 的七成
  const LAST_UP = 1.5;  // last n：攒到 n 的一倍半再切回 n
  function pick(ai, conf, prior, all, curLen) {
    const c = getCtx(ai);
    let ms = prior, trimmed = 0, left = null;
    const key = c.mode === 'last' ? 'last:' + c.n : c.mode === 'all' && conf.ctxMax ? 'all:' + conf.ctxMax : '';
    const cut = cuts.get(ai);
    let a = key && cut?.key === key ? ms.findIndex((m) => m.id === cut.id) : -1; // 上次切在哪（那句被删了就是 -1，重算）
    const keep = (i) => { if (ms[i]) cuts.set(ai, { key, id: ms[i].id }); else cuts.delete(ai); };
    if (c.mode === 'range') {
      const pos = new Map(all.map((m, i) => [m.id, i]));
      const i = pos.get(c.from) ?? 0, j = c.to != null ? (pos.get(c.to) ?? Infinity) : Infinity;
      ms = ms.filter((m) => pos.get(m.id) >= i && pos.get(m.id) <= j);
    } else if (c.mode === 'last') {
      const turnsFrom = (i) => ms.slice(i).filter((m) => m.role === 'me').length;
      const k0 = a >= 0 ? turnsFrom(a) : -1;
      if (a < 0 || k0 < c.n || k0 > Math.ceil(c.n * LAST_UP)) { // 没切过、不够 n 轮了、攒过头了：重新切到正好 n 轮
        let k = 0, i = ms.length;
        while (i > 0 && k < c.n) if (ms[--i].role === 'me') k++;
        a = k < c.n ? 0 : i; // 不够 n 轮就是全部
        keep(a);
      }
      ms = ms.slice(a);
    } else if (conf.ctxMax) { // all：超过 ctxMax 字从最旧的开始不带
      let i = Math.max(a, 0), total = curLen + ms.slice(i).reduce((x, m) => x + len(m.text), 0);
      left = Math.max(0, 1 - total / conf.ctxMax); // 离下一次切还剩多少
      if (total > conf.ctxMax) {
        while (i < ms.length && total > conf.ctxMax * CUT_TO) total -= len(ms[i++].text);
        keep(i);
      }
      trimmed = i;
      ms = ms.slice(i);
    }
    return { ms, trimmed, left };
  }
  // 一句话交给模型时的样子：动作包成 *…*，引用的那句放在前面一行
  function says(m, byId) {
    let s = m.text || '';
    if (m.action && s.trim() && !/^\*[\s\S]*\*$/.test(s.trim())) s = `*${s.trim()}*`;
    // 她发的语音：文字是转出来的字，前面说一声是语音、多长
    if (m.voice) s = `〔她发了一条语音${m.voice.dur ? `（${Math.max(1, Math.round(m.voice.dur))} 秒）` : ''}，下面是转出来的字〕\n` + (s.trim() ? s : '（没认出字）');
    if (m.quote) {
      const q = byId.get(m.quote);
      if (q && !q.gone) s = `〔引用${q.role === 'me' ? '她自己' : '你'}说过的：「${cutTo(q.text, 200)}」〕\n` + s;
    }
    if (m.inlineImg && !s.trim() && !(m.img || []).length) s = `〔她发了 ${m.inlineImg} 张图，图没存下来，这次看不到〕`;
    // 她发的文件：先只告诉 TA 发了什么（名字、大小），内容还读不了（取字以后再做）
    if (m.files?.length) s = m.files.map((f) => `〔她发了一个文件：${f.name}（${f.size < 1024 * 1024 ? Math.max(1, Math.round(f.size / 1024)) + ' KB' : (f.size / 1048576).toFixed(1) + ' MB'}），内容你现在还读不到〕`).join('\n') + (s.trim() ? '\n' + s : '');
    return s;
  }
  // 她传上来的图存的是 /api/file/<编号>：发给模型时换成 base64（找不到了就不带）
  const imgOut = (a) => (a || []).map((u) => (/^\/api\/file\//.test(u) ? files?.dataUrl(u) || null : u)).filter(Boolean);
  const turnOf = (m, byId) => ({ role: m.role === 'me' ? 'user' : 'assistant', text: says(m, byId), img: m.role === 'me' ? imgOut(m.img) : [] });

  // 记忆这边的一步：出错就当没有，只记一行
  async function step(ai, what, fn) {
    if (!hooks) return null;
    try { return (await fn()) || null; } catch (e) { log('聊天', ai, what + '这一步跳过：', e.code || e.name); return null; }
  }

  // ---- 回一句 ----
  // her：她那句（已经存好）；prior：她这句之前、没删的；imgs：这次要带的图（发的时候可以有 data:，存的只有网址）
  // again：重新生成（不重新取开场，每条消息前那段用上次的）；target：要换掉回答的那一句 TA（没有就新存一句）
  // prefix：只拼在发给模型的她那句前面、不存的一行（拍一拍）
  // suffix：只拼在发给模型的她那句后面、不存的一行（打电话的提醒）
  async function answer(ai, conf, res, job, { her, prior, all, focus = false, timeTag = '', prefix = '', suffix = '', imgs, again = false, target = null }) {
    const kind = STYLES[conf.style], { url, key } = ready(conf);
    const byId = new Map(all.map((m) => [m.id, m]));
    const curText = [timeTag, prefix, says(her, byId), suffix].filter(Boolean).join('\n');
    const { ms, trimmed, left } = pick(ai, conf, prior, all, len(curText));

    // 开场：这一场的第一句、隔了 6 小时以上、或者改了上下文设置把前面截掉了，才重新取；同一场里固定不变
    const memo = memos.get(ai) || {};
    memos.set(ai, memo);
    const t = now();
    let source = null;
    if (memo.t == null) source = 'startup';
    else if (!again && (t - memo.t > SIX_H || !prior.length)) source = 'startup';
    else if (!again && memo.ctxChanged && memo.first && !ms.some((m) => m.id === memo.first)) source = 'compact';
    if (source === 'startup') memo.sid = 'c' + t.toString(36);
    if (source) memo.start = await step(ai, '开场', async () => (await hooks.start(ai, { source, focus })).context);
    if (!again) { memo.ctxChanged = false; memo.first = ms[0]?.id ?? null; memo.t = t; } else memo.t ??= t;
    // 每条消息前：重新生成时用上次那段（不再记一遍对话原文、不再算一轮）
    let before;
    if (again && memo.beforeFor === her.id) before = memo.before;
    else {
      // ctxLeft 只在 all + ctxMax 时给（我们自己算得出来，不猜）；重新生成不给，免得同一句算两遍
      const b = await step(ai, '每条消息前', () => hooks.before(ai, { text: her.text || '', focus, sid: memo.sid, again, ...(left != null && !again ? { ctxLeft: left } : {}) }));
      before = b?.context || null;
      if (b?.digest) due.add(ai); // 跌进 10%：这一句回完做一次散场记（why: compact）
      memo.before = before;
      memo.beforeFor = her.id;
    }

    const turns = lead(merge([...ms.map((m) => turnOf(m, byId)), { role: 'user', text: curText, img: imgOut(imgs) }]), ms[0] !== prior[0]);
    const body = buildBody(conf, kind, turns);
    const P = ASK[kind], lst = P.list(body);
    if (before && lst.length && lst.at(-1)) P.add(body, lst.at(-1), before);
    if (memo.start) P.sys(body, memo.start);
    let head = '';
    if (persona) { try { head = persona.inject(ai) || ''; } catch (e) { log('聊天', ai, '人格读不出来，这次不带：', e.code || e.name); } }
    if (head) P.head(body, head);

    // ---- 流 ----
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const emit = (o) => { if (!res.writableEnded && !res.destroyed) res.write('data: ' + JSON.stringify(o) + '\n\n'); };
    const finish = (o) => { emit(o); if (!res.writableEnded) res.end(); };
    let raw = '', shown = '', think = '', bad = false;
    const steps = [], cutter = makeCut(), used = {};
    const textIn = (s) => { raw += s; const o = cutter(s); if (o) { shown += o; emit({ type: 'delta', text: o }); } };
    const reader = makeReader(kind, {
      text: textIn,
      think: (s) => { think += s; emit({ type: 'think', text: s }); },
      step: (st) => { const i = steps.length; steps.push({ kind: 'tool', name: st.name, input: st.input }); emit({ type: 'step', i, ...steps[i] }); },
      fail: () => { bad = true; },
      usage: (u) => Object.assign(used, u),
    });
    const sse = sseSplit(reader.event);
    const r = await upCall(ai, conf, url, key, body, job, {
      chunk: (s) => sse.push(s),
      end: () => { sse.end(); reader.end(); },
      // 上游没给流、回了一整个 JSON：文字照样剥小记，一次发出去
      whole: (s) => { try { const o = JSON.parse(s); Object.assign(used, usageOf(kind, o) || {}); wholeText(kind, o, textIn); } catch { bad = true; } },
    });
    noteUsage(ai, conf, again ? 'again' : 'chat', used);

    const me = her.id;
    if (r.net) { log('聊天', ai, '连不上上游'); return finish({ type: 'error', status: 0, msg: '连不上上游', me }); }
    if (r.status && !r.ok && !r.broken) {
      log('聊天', ai, '上游回了', r.status);
      const detail = detailOf(r.errText, key);
      return finish({ type: 'error', status: r.status, msg: human(r.status), ...(detail ? { detail } : {}), me });
    }
    const cut = !!(r.broken || r.stopped || bad);
    if (cut && !shown.trim() && !think.trim() && !steps.length) {
      if (r.stopped) return finish({ type: 'done', id: null, me, cut: true });
      log('聊天', ai, bad ? '上游流里报错' : '上游中途断了');
      return finish({ type: 'error', status: r.status || 0, msg: bad ? '上游中途报错了' : '上游中途断了', me });
    }

    // 回复之后：小记交给记忆库（对话原文也由它记，这里不另写）
    const regen = target?.role === 'ai';
    const reply = cut ? dropOpen(raw) : raw;
    const aft = reply.trim() ? await step(ai, '回复之后', () => hooks.after(ai, { reply, sid: memo.sid, again: regen })) : null;
    const text = cut ? shown.replace(/\s+$/, '') : (aft?.clean ?? split(reply).clean);
    const notes = [...(aft?.rows || []), ...noPat(aft?.marks)].map((x) => (regen ? { ...x, again: true } : x));
    const fields = { text, ...(think ? { think } : {}), ...(steps.length ? { steps } : {}), ...(notes.length ? { notes } : {}), ...(cut ? { cut: true } : {}) };
    let id;
    if (regen) {
      change(ai, target.id, (m) => {
        m.alts = [...(m.alts?.length ? m.alts : [m.text]), text]; // 每一版都在 alts 里，text 是现在显示的那版
        for (const k of ['think', 'steps', 'notes', 'cut']) delete m[k];
        Object.assign(m, fields, { t2: now() });
      });
      id = target.id;
    } else {
      const m = { id: newId(), role: 'ai', t: now(), ...fields };
      append(ai, m);
      id = m.id;
    }
    const patId = taPats(ai, aft?.marks);
    finish({ type: 'done', id, me, ...(notes.length ? { notes } : {}), ...(trimmed ? { trimmed } : {}), ...(cut ? { cut: true } : {}), ...(regen ? { again: true } : {}), ...(patId ? { pat: patId } : {}) });
    // 她自己按了停的不算；推不推（网页在不在前台）由接的那一边定
    if (!r.stopped && text.trim()) {
      try { Promise.resolve(onReply(ai, { id, text, again: regen })).catch((e) => log('聊天', ai, '回完之后那一步出错：', e.code || e.name)); } catch (e) { log('聊天', ai, '回完之后那一步出错：', e.code || e.name); }
    }
  }

  // 同一个 AI 同时只跑一句。res 为 null 是 TA 主动开口（没有前端在等流），出错原样抛给调用的一方
  async function run(ai, res, fn, { wake = false } = {}) {
    if (running.has(ai)) throw fail(409, '上一句还在回，等它回完或者先停下');
    const job = { stopped: false, wake, abort() { job.stopped = true; } };
    running.set(ai, job);
    let out;
    job.done = (async () => {
      try { out = await fn(job); } catch (e) {
        if (!res || !res.headersSent) throw e;
        log('聊天', ai, '出错', e.code || e.name);
        if (!res.writableEnded) { res.write('data: ' + JSON.stringify({ type: 'error', status: 0, msg: '后端出错了' }) + '\n\n'); res.end(); }
      } finally { running.delete(ai); }
    })();
    await job.done;
    return out;
  }
  // 她优先：TA 正在主动开口，就让它停下（不存），她这句接着发
  async function yieldWake(ai) {
    const job = running.get(ai);
    if (!job?.wake) return;
    job.abort();
    await job.done.catch(() => {});
  }

  // 她发的图：data:image/…;base64 或 http(s) 网址。网址存下来，data: 的这批不存（只记张数）
  function checkImgs(img) {
    if (img == null) return [];
    if (!Array.isArray(img) || img.length > IMG_MAX) throw fail(400, `img 要是一个数组，最多 ${IMG_MAX} 张`);
    for (const u of img) {
      if (typeof u !== 'string' || !(/^data:image\/[A-Za-z0-9.+-]+;base64,/.test(u) || /^https?:\/\//.test(u) || /^\/api\/file\/f[a-z0-9]{12,20}$/.test(u))) throw fail(400, '图要是 data:image/…;base64,…、http(s) 网址，或者传上来的 /api/file/…');
    }
    return img;
  }

  // 她发的文件：只收传上来的那种（/api/file/…），名字和大小以后端存的为准
  function checkFiles(a) {
    if (a == null) return [];
    if (!Array.isArray(a) || a.length > 9) throw fail(400, 'files 要是一个数组，最多 9 个');
    return a.map((x) => {
      const id = /^\/api\/file\/(f[a-z0-9]{12,20})$/.exec(String(x?.url ?? x))?.[1];
      if (!id || !files) throw fail(400, '文件要先传上来（/api/upload）');
      const { meta } = files.get(id);
      return { url: '/api/file/' + id, name: meta.name, size: meta.size, kind: meta.kind };
    });
  }

  // 她发的语音：{ file: 文件编号（/api/voice/stt 回的）, dur: 秒数 }。只收传上来的录音
  function checkVoice(v) {
    if (v == null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) throw fail(400, 'voice 要是 { file, dur }');
    const id = /^(?:\/api\/file\/)?(f[a-z0-9]{12,20})$/.exec(String(v.file ?? ''))?.[1];
    if (!id || !files) throw fail(400, '语音要先传上来（/api/voice/stt）');
    let meta;
    try { meta = files.get(id).meta; } catch { throw fail(400, '找不到这条语音'); }
    if (meta.kind !== 'audio') throw fail(400, 'voice.file 不是录音');
    const dur = Number(v.dur ?? 0);
    if (!Number.isFinite(dur) || dur < 0 || dur > 3600) throw fail(400, 'voice.dur 要是秒数（0 到 3600）');
    return { file: id, dur: Math.round(dur * 10) / 10 };
  }

  // ---- 发一句 ----
  async function send(ai, body = {}, res) {
    const conf = confOf(ai);
    if (conf.kind === 'dsh') dsh.ready(conf); else ready(conf);
    if (body.text != null && typeof body.text !== 'string') throw fail(400, 'text 要是一段文字');
    const text = body.text || '', imgs = checkImgs(body.img), fl = checkFiles(body.files), voice = checkVoice(body.voice);
    if (!text.trim() && !imgs.length && !fl.length && !voice) throw fail(400, '要说点什么，或者发张图');
    await yieldWake(ai);
    const all = readAll(ai);
    if (body.quote != null && !all.some((m) => m.id === body.quote && !m.gone)) throw fail(400, '引用的那句找不到');
    if (running.has(ai)) throw fail(409, '上一句还在回，等它回完或者先停下');
    const urls = imgs.filter((u) => !u.startsWith('data:')), inline = imgs.length - urls.length;
    // timeTag 只拼在发给模型的那一份里，不存
    const her = { id: newId(), role: 'me', text, t: now(), ...(body.quote != null ? { quote: String(body.quote) } : {}), ...(body.action ? { action: true } : {}),
      ...(urls.length ? { img: urls } : {}), ...(inline ? { inlineImg: inline } : {}), ...(fl.length ? { files: fl } : {}), ...(voice ? { voice } : {}) };
    append(ai, her);
    const prior = all.filter(talks);
    const timeTag = typeof body.timeTag === 'string' ? cutTo(body.timeTag.trim(), 200) : '';
    // 她刚才拍了拍、还没带走的：拼在她这句前面带给 TA，带了就清掉（钩子的 before 就拿不到了，不会带两遍）
    let prefix = '';
    try { const n = pat ? pat.take(ai) : 0; if (n) prefix = pat.line(ai, n); } catch (e) { log('聊天', ai, '拍一拍读不出来：', e.code || e.name); }
    if (conf.kind === 'dsh') {
      // dsh 自己记着上下文：只交她这一句（带时间、拍一拍、引用），回复照常存进 chat.jsonl
      const byId = new Map([...all, her].map((m) => [m.id, m]));
      const input = [timeTag, prefix, says(her, byId)].filter(Boolean).join('\n');
      const save = (f) => {
        const m = { id: newId(), role: 'ai', t: now(), ...f };
        append(ai, m);
        if (!f.cut && f.text.trim()) Promise.resolve(onReply(ai, { id: m.id, text: f.text, again: false })).catch((e) => log('聊天', ai, '回完之后那一步出错：', e.code || e.name));
        return m.id;
      };
      return run(ai, res, (job) => dsh.answer(ai, conf, res, job, { me: her.id, text: input, imgs: imgOut(imgs), save }));
    }
    clearIdle(ai);
    const suffix = callTag(ai, body.call);
    try { return await run(ai, res, (job) => answer(ai, conf, res, job, { her, prior, all: [...all, her], focus: !!body.focus, timeTag, prefix, suffix, imgs })); } finally { turnEnd(ai); }
  }

  // ---- 重新生成：只许最后一句。是 TA 的就换一版（旧的留在 alts）；是她的（上次上游报错没回）就补一句回答 ----
  async function again(ai, id, body = {}, res) {
    const conf = confOf(ai);
    ready(conf);
    await yieldWake(ai);
    const all = readAll(ai), live = all.filter(talks), last = live.at(-1);
    if (!live.some((m) => m.id === id)) throw fail(404, '没有这条消息');
    if (last.id !== id) throw fail(400, '只能重新生成最后一句');
    if (running.has(ai)) throw fail(409, '上一句还在回，等它回完或者先停下');
    let j = live.length - 1;
    while (j >= 0 && live[j].role !== 'me') j--;
    if (j < 0) throw fail(400, '这一句前面没有她的话');
    const her = live[j], target = last.role === 'ai' ? last : null;
    const timeTag = typeof body.timeTag === 'string' ? cutTo(body.timeTag.trim(), 200) : '';
    clearIdle(ai);
    const suffix = callTag(ai, body.call);
    try { return await run(ai, res, (job) => answer(ai, conf, res, job, { her, prior: live.slice(0, j), all, focus: !!body.focus, timeTag, suffix, imgs: her.img || [], again: true, target })); } finally { turnEnd(ai); }
  }

  // ---- 单问一句（开屏字幕这类）：只带人格和这一句，不带聊天记录、不存、不碰记忆、不占「同时只跑一句」。回去掉小记后的整段文字 ----
  async function ask(ai, prompt, { what = 'ask', wait = ASK_WAIT } = {}) {
    const conf = confOf(ai), { url, key } = ready(conf), kind = STYLES[conf.style];
    const body = buildBody(conf, kind, [{ role: 'user', text: String(prompt || ''), img: [] }]), P = ASK[kind];
    let head = '';
    if (persona) { try { head = persona.inject(ai) || ''; } catch (e) { log('聊天', ai, '人格读不出来，这次不带：', e.code || e.name); } }
    if (head) P.head(body, head);
    let raw = '', bad = false;
    const used = {};
    const reader = makeReader(kind, { text: (x) => { raw += x; }, think: () => {}, step: () => {}, fail: () => { bad = true; }, usage: (u) => Object.assign(used, u) });
    const sse = sseSplit(reader.event);
    const job = { stopped: false, abort() { job.stopped = true; } };
    const tm = setTimeout(() => job.abort(), wait);
    let r;
    try {
      r = await upCall(ai, conf, url, key, body, job, {
        chunk: (x) => sse.push(x), end: () => { sse.end(); reader.end(); },
        whole: (x) => { try { const o = JSON.parse(x); Object.assign(used, usageOf(kind, o) || {}); wholeText(kind, o, (y) => { raw += y; }); } catch { bad = true; } },
      });
    } finally { clearTimeout(tm); }
    noteUsage(ai, conf, what, used);
    if (r.stopped) throw fail(504, '上游太久没写完');
    if (r.net) throw fail(502, '连不上上游');
    if (r.status && !r.ok && !r.broken) throw fail(502, human(r.status));
    if (r.broken || bad) throw fail(502, '上游中途断了');
    return split(raw).clean;
  }

  // ---- 停下：断开上游，已经流出来的存下、标 cut。等它存完再回 ----
  async function stop(ai) {
    store.folder(ai);
    const job = running.get(ai);
    if (!job) return { ok: true, stopped: false };
    job.abort();
    await job.done.catch(() => {}); // 出错由发的那一边报
    return { ok: true, stopped: true };
  }

  // ---- 说过什么：TA 主动开口说过的话，另记一份（留 30 天） ----
  const saidFile = (ai) => path.join(store.folder(ai), 'said.jsonl');
  function saidAll(ai) {
    let s;
    try { s = fs.readFileSync(saidFile(ai), 'utf8'); } catch { return []; }
    const cut = now() - SAID_KEEP, out = [];
    for (const l of s.split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (r && r.t >= cut) out.push(r); } catch { /* 坏的一行跳过 */ } }
    return out;
  }
  function saidAdd(ai, row) {
    const f = saidFile(ai), rows = [...saidAll(ai), row];
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', rows.map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f); // 先写旁边再换名（顺手清掉 30 天以前的）
  }
  // 给设置页：条数和时间，不给正文（正文在聊天记录里本来就有）
  function said(ai) { const rows = saidAll(ai); return { n: rows.length, items: rows.slice(-50).map((r) => ({ t: r.t, why: r.why })) }; }

  // ---- 守门要的几件事实：她上一句的时间、上一次 TA 主动说的（空下来的不算）她回了没有、TA 正不正在说 ----
  function info(ai) {
    let her = 0, wake = null;
    for (const m of readAll(ai)) {
      if (m.gone) continue;
      if (m.role === 'me') { her = m.t; if (wake) wake.answered = true; } else if (m.wake && m.wake.why !== 'idle') wake = { t: m.t, answered: false };
    }
    return { her, wake, busy: running.has(ai), said: said(ai) };
  }
  const busy = (ai) => running.has(ai);

  // ---- TA 主动开口 ----
  // why：knock / idle / later…；hint：来源给的一句（不存、不显示）；about：存在消息上给前端显示的一小句；push：要不要推送（交给 onWake）
  // 回 { said: true, id } 或 { said: false }。她这时发来一句：抛 409（requeue），收件箱晚点再来
  function wakePrompt(ai, why, hint, t) {
    const rows = saidAll(ai).slice(-SAID_SHOW);
    return [`〔这不是她说的话，是后端叫醒了你：${WHY[why] || why}〕`, hint ? String(hint).trim() : '',
      `〔现在 ${fmt.format(new Date(t))}〕`,
      rows.length ? '你最近主动说过：\n' + rows.map((r) => `- ${fmt.format(new Date(r.t))}（${WHY[r.why] ? r.why : '别的'}）${r.gist}`).join('\n') + '\n同一件事已经问过、她还没回的，别再问一遍。' : '',
      `想跟她说就直接说（一两句就好，她现在不一定在看）；不想说、或者现在不合适，就只回 ${SILENT}。小记照常可以写。`].filter(Boolean).join('\n');
  }
  // 不给前端流的那种请求（TA 主动开口、散场记）：带着这一场的开场、人格、按设置挑的聊天记录，最后一句是 prompt。回收到的整段文字
  async function quietCall(ai, conf, job, prompt, memo) {
    const { url, key } = ready(conf), kind = STYLES[conf.style];
    const all = readAll(ai), live = all.filter(talks), byId = new Map(all.map((m) => [m.id, m]));
    const { ms } = pick(ai, conf, live, all, len(prompt));
    const turns = lead(merge([...ms.map((m) => turnOf(m, byId)), { role: 'user', text: prompt, img: [] }]), ms[0] !== live[0]);
    const body = buildBody(conf, kind, turns), P = ASK[kind];
    if (memo.start) P.sys(body, memo.start);
    let head = '';
    if (persona) { try { head = persona.inject(ai) || ''; } catch (e) { log('聊天', ai, '人格读不出来，这次不带：', e.code || e.name); } }
    if (head) P.head(body, head);
    let raw = '', think = '', bad = false;
    const steps = [], used = {};
    const reader = makeReader(kind, { text: (x) => { raw += x; }, think: (x) => { think += x; }, step: (st) => steps.push({ kind: 'tool', name: st.name, input: st.input }), fail: () => { bad = true; }, usage: (u) => Object.assign(used, u) });
    const sse = sseSplit(reader.event);
    const r = await upCall(ai, conf, url, key, body, job, {
      chunk: (x) => sse.push(x), end: () => { sse.end(); reader.end(); },
      whole: (x) => { try { const o = JSON.parse(x); Object.assign(used, usageOf(kind, o) || {}); wholeText(kind, o, (y) => { raw += y; }); } catch { bad = true; } },
    });
    noteUsage(ai, conf, 'quiet', used);
    return { r, raw, think, steps, bad };
  }

  async function wake(ai, { why = 'knock', hint = '', about = '', push = true } = {}) {
    const conf = confOf(ai);
    ready(conf);
    if (running.has(ai)) throw fail(409, '正在回她的话，等这句说完');
    return run(ai, null, async (job) => {
      const all = readAll(ai), live = all.filter(talks);
      const t = now(), prompt = wakePrompt(ai, why, hint, t);
      // 开场：这一场还没开、或者隔了 6 小时以上，才重新取（跟她发一句时一样）
      const memo = memos.get(ai) || {};
      memos.set(ai, memo);
      if (memo.t == null || t - memo.t > SIX_H) {
        const { ms } = pick(ai, conf, live, all, len(prompt));
        memo.sid = 'c' + t.toString(36);
        memo.start = await step(ai, '开场', async () => (await hooks.start(ai, { source: 'startup' })).context);
        memo.first = ms[0]?.id ?? null;
        memo.ctxChanged = false;
      }
      memo.t = t;
      const { r, raw, think, steps, bad } = await quietCall(ai, conf, job, prompt, memo);
      if (r.stopped) throw Object.assign(fail(409, '她发来一句，这次让给她'), { requeue: true });
      if (r.net) { log('主动开口', ai, '连不上上游'); throw fail(502, '连不上上游'); }
      if (r.status && !r.ok && !r.broken) { log('主动开口', ai, '上游回了', r.status); throw fail(502, human(r.status)); }
      if (r.broken || bad) { log('主动开口', ai, '上游中途断了'); throw fail(502, '上游中途断了'); }
      const clean = split(raw).clean.trim();
      if (!clean || clean === SILENT) { // 选择不说：不存、不推；小记照常处理（那是 TA 自己的记忆）
        const rest = raw.split(SILENT).join('');
        if (rest.trim()) await step(ai, '回复之后', () => hooks.after(ai, { reply: rest, sid: memo.sid }));
        return { said: false };
      }
      const aft = await step(ai, '回复之后', () => hooks.after(ai, { reply: raw, sid: memo.sid }));
      const text = aft?.clean ?? split(raw).clean;
      const notes = [...(aft?.rows || []), ...noPat(aft?.marks)];
      const m = { id: newId(), role: 'ai', t: now(), text, wake: { why, ...(about ? { about: cutTo(about, 40) } : {}) },
        ...(think ? { think } : {}), ...(steps.length ? { steps } : {}), ...(notes.length ? { notes } : {}) };
      append(ai, m);
      taPats(ai, aft?.marks);
      saidAdd(ai, { t: m.t, why, gist: [...text.trim()].slice(0, SAID_GIST).join('') });
      try { await onWake(ai, m, { push }); } catch (e) { log('主动开口', ai, '之后那一步出错（不影响已经存下的）：', e.code || e.name); }
      return { said: true, id: m.id };
    }, { wake: true });
  }

  // ---- 散场记 ----
  // 她每发一句（回完以后）重新计时；她停 digestIdle 分钟，到点问一次
  function clearIdle(ai) { const h = idleT.get(ai); if (h != null) { timers.clear(h); idleT.delete(ai); } }
  // 一句回完：重新计时；这一句里跌进了 10%（快压缩），接着做一次散场记——跟空闲那次同一条路，她一说话就让给她
  function turnEnd(ai) {
    armIdle(ai);
    if (!due.delete(ai)) return;
    digest(ai, { why: 'compact' }).catch((e) => log('散场记', ai, '出错', e.code || e.name));
  }
  const idleMins = (ai) => { try { return hooks?.idle ? store.getCfg(ai).digestIdle : 0; } catch { return 0; } };
  // ms：多久以后问；不写就是整整 digestIdle 分钟
  function armIdle(ai, ms) {
    clearIdle(ai);
    const mins = idleMins(ai);
    if (!mins) return;
    idleT.set(ai, timers.set(() => { idleT.delete(ai); digest(ai).catch((e) => log('散场记', ai, '出错', e.code || e.name)); }, ms ?? mins * 60e3));
  }
  // 后端重启后定时器都丢了：对每个 AI 看「她最后一句的时间」（记忆库 sess.lastT，跟 idle 接口认的同一个）和「上次散场记的时间」（digestAt），
  // 还有没问过的新对话，就按剩下的时间重新挂；已经超过 digestIdle 的挂一个很短的延迟（BOOT_WAIT，等后端站稳再问），
  // 过点的不止一个就一个隔 BOOT_GAP 排开。回挂上了几个。
  // 重启前这一场的开场（memo）也丢了：这时问的散场记不带开场，只带人格和聊天记录（问话里自带小记的写法）
  function boot() {
    let n = 0, late = 0;
    for (const a of readAis()) {
      if (a.kind === 'dsh') continue;
      try {
        const mins = idleMins(a.id);
        if (!mins || idleT.has(a.id)) continue;
        const d = store.load(a.id), last = d.sess?.lastT;
        if (!last || last <= (d.digestAt || 0)) continue;
        const tail = readAll(a.id).filter((m) => !m.gone).at(-1); // 原来是回完那一刻才开始计时
        const from = Math.max(last, tail?.t2 || tail?.t || 0);
        const left = mins * 60e3 - (now() - from);
        armIdle(a.id, left > BOOT_WAIT ? left : BOOT_WAIT + BOOT_GAP * late++);
        n++;
      } catch (e) { log('散场记', a.id, '重启后没挂上：', e.code || e.name); }
    }
    return n;
  }
  // 问一次。回 { n, kinds }（记下了几条、哪几种）或 { skip: 原因 }。她这时发来一句：让给她，什么都不存
  // why：idle（她停下来了，定时器来调）、compact（快压缩了，turnEnd 来调）
  async function digest(ai, { why = 'idle' } = {}) {
    const conf = confOf(ai);
    ready(conf);
    if (running.has(ai)) return { skip: 'busy' };
    const memo = memos.get(ai) || {};
    const ask = await step(ai, '散场记', async () => (await hooks.idle(ai, { sid: memo.sid, why })).ask);
    if (!ask) return { skip: 'none' };
    if (running.has(ai)) return { skip: 'busy' };
    return run(ai, null, async (job) => {
      const { r, raw, bad } = await quietCall(ai, conf, job, ask, memo); // 用这一场的开场，不重新取、不动 memo
      if (r.stopped) return { skip: 'yield' };
      if (r.net || (r.status && !r.ok && !r.broken) || r.broken || bad) { log('散场记', ai, '没问成：', r.net ? '连不上上游' : r.status || '中途断了'); return { skip: 'error' }; }
      const aft = raw.trim() ? await step(ai, '散场记', () => hooks.after(ai, { reply: raw, sid: memo.sid, quiet: true })) : null;
      const n = aft?.notes || 0;
      if (!n) return { n: 0, kinds: [] };
      const kinds = aft.kinds || [];
      const last = readAll(ai).filter((m) => !m.gone).at(-1);
      if (last) {
        change(ai, last.id, (m) => {
          const k = new Set([...(m.digest?.kinds || []), ...kinds]);
          m.digest = { n: (m.digest?.n || 0) + n, kinds: [...k] };
        });
      }
      return { n, kinds };
    }, { wake: true });
  }

  // ---- 拍一拍 ----
  // 合成一条或新加一条：最后一条是同一方一分钟内拍的，n 加一
  function patAdd(ai, role) {
    const c = pat ? pat.get(ai) : {}, t = now();
    const tail = role === 'me' ? c.me : c.ai;
    const last = readAll(ai).filter((m) => !m.gone).at(-1);
    if (last?.pat && last.role === role && t - (last.t2 || last.t) <= PAT_MERGE) {
      return change(ai, last.id, (m) => { m.pat = { ...m.pat, n: (m.pat.n || 1) + 1 }; m.t2 = t; });
    }
    const m = { id: newId(), role, t, pat: { n: 1, ...(tail ? { tail } : {}) } };
    append(ai, m);
    return m;
  }
  // TA 在小记里拍了她：回复存好以后加一行
  function taPats(ai, marks) {
    if (!marks?.some((x) => x.kind === 'pat')) return null;
    try { return patAdd(ai, 'ai').id; } catch (e) { log('聊天', ai, '拍一拍存不进去：', e.code || e.name); return null; }
  }
  // 她拍了拍 TA。next：挂起，等她下一句话一起带；now：现在就让 TA 回（TA 正在回、或者这个 AI 不走这里的聊天，就退回挂起 / 交给调用的一方）
  function patMe(ai) {
    if (!pat) throw fail(404, '没有拍一拍');
    store.folder(ai);
    const c = pat.get(ai), m = patAdd(ai, 'me');
    if (c.reply !== 'now') { pat.hold(ai); return m; }
    let conf = null;
    try { conf = confOf(ai); ready(conf); } catch { conf = null; }
    // 不走这里聊天的（走钩子的平台）：由调用的一方把这一行当一句话送进去。
    // 每拍一下送一次，所以只说这一下（显示的那行合成了几下，前面那几下已经送过了，不再算进来）
    if (!conf) return { ...m, line: pat.line(ai, 1, { now: true }) };
    const job = running.get(ai);
    if (job && !job.wake) { pat.hold(ai); return m; } // TA 正在回她：排到她下一句
    const go = async () => {
      await yieldWake(ai);
      if (running.has(ai)) { pat.hold(ai); return; }
      const all = readAll(ai), her = all.find((x) => x.id === m.id) || m;
      const prior = all.filter((x) => talks(x) && x.t <= her.t && x.id !== her.id);
      const res = sink();
      clearIdle(ai);
      try { await run(ai, res, (j) => answer(ai, conf, res, j, { her, prior, all, prefix: pat.line(ai, her.pat?.n || 1, { now: true }), imgs: [] })); } finally { turnEnd(ai); }
    };
    go().catch((e) => log('拍一拍', ai, '回不了：', e.code || e.name));
    return m;
  }

  return { ais, setAis, usage, list, remove, restore, edit, getCtx, setCtx, send, again, stop, readAll, wake, info, busy, said, digest, boot, pat: patMe, ask, dsh };
}
