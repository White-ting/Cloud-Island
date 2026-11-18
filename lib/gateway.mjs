// 网关转发：App 把「接口地址」填成 http://本机:端口/gw/{ai}，网关站在 App 和模型中间，自己做四个时机里的三个
// （开场、每条消息前、回复之后），再原样转给上游。规矩参考作者另一个私用项目的接口说明「走 API 的：网关认四种协议」。
// 记忆是添头，聊天是正事：记忆这边任何一步出错，都当这一步没有，原样转、原样回，只记一行日志。
// App 带来的口令（请求头、网址里的 key=）原样转给上游，这里不存、不进日志。
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { split } from './notes.mjs';

// 比口令：先各算一遍指纹再比，长短不同也花一样的时间
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameKey = (a, b) => !!a && !!b && crypto.timingSafeEqual(sha(a), sha(b));

const MAX_BODY = 32 * 1024 * 1024; // 请求体比这还大就不看了，边读边原样转
const SIX_H = 6 * 3600e3;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);
const OURS = new Set(['host', 'content-length', 'x-focus', 'x-session-id']); // 要重算的、只给网关看的，不转给上游
const NAME = { openai: 'UPSTREAM_OPENAI', anthropic: 'UPSTREAM_ANTHROPIC', gemini: 'UPSTREAM_GEMINI' };

// 认地址：四种协议之一；别的返回 null（不看不改，原样转）
function kindOf(method, rest) {
  if (method !== 'POST') return null;
  if (rest === '/v1/chat/completions') return 'chat';
  if (rest === '/v1/responses') return 'resp';
  if (rest === '/v1/messages') return 'claude';
  if (/^\/v1beta\/models\/[^/:]+:(generateContent|streamGenerateContent)$/.test(rest)) return 'gemini';
  return null;
}
// 按路径猜上游是哪家
const familyOf = (rest) => (rest.startsWith('/v1/messages') ? 'anthropic' : rest.startsWith('/v1beta/') ? 'gemini' : 'openai');

// ---- 请求这边：每种协议里，她的话在哪、开场放哪 ----
const textOf = (c, type) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === type && typeof b.text === 'string').map((b) => b.text).join('\n') : '');
function addTo(m, ctx, type) {
  if (typeof m.content === 'string') m.content += '\n\n' + ctx; // 字符串就接字符串
  else if (Array.isArray(m.content)) m.content.push({ type, text: ctx }); // 块数组就多加一块，别的块不碰
  else throw new Error('认不出这条消息的内容');
}
const ASK = {
  chat: {
    list: (b) => b.messages,
    user: (m) => m?.role === 'user',
    text: (m) => textOf(m.content, 'text'),
    add: (b, m, ctx) => addTo(m, ctx, 'text'),
    sys: (b, ctx) => b.messages.unshift({ role: 'system', content: ctx }),
    head: (b, s) => b.messages.unshift({ role: 'system', content: s }),
  },
  resp: {
    // input 可以直接是一句话（字符串），当成只有一条她的话
    list: (b) => (typeof b.input === 'string' ? [{ role: 'user', content: b.input, whole: true }] : b.input),
    user: (m) => m?.role === 'user' && (m.type ?? 'message') === 'message',
    text: (m) => textOf(m.content, 'input_text'),
    add: (b, m, ctx) => (m.whole ? (b.input += '\n\n' + ctx) : addTo(m, ctx, 'input_text')),
    sys: (b, ctx) => { b.instructions = b.instructions ? b.instructions + '\n\n' + ctx : ctx; },
    head: (b, s) => { b.instructions = b.instructions ? s + '\n\n' + b.instructions : s; },
  },
  claude: {
    list: (b) => b.messages,
    // 工具结果也是 role:user，那不是她说的话
    user: (m) => m?.role === 'user' && !(Array.isArray(m.content) && m.content.some((x) => x?.type === 'tool_result')),
    text: (m) => textOf(m.content, 'text'),
    add: (b, m, ctx) => addTo(m, ctx, 'text'),
    sys: (b, ctx) => {
      if (Array.isArray(b.system)) b.system.push({ type: 'text', text: ctx }); // 接在最后，App 标的 cache_control 不动
      else b.system = b.system ? b.system + '\n\n' + ctx : ctx;
    },
    head: (b, s) => {
      if (Array.isArray(b.system)) b.system.unshift({ type: 'text', text: s }); // 放最前面一块，App 标的 cache_control 跟着它自己那块走
      else b.system = b.system ? s + '\n\n' + b.system : s;
    },
  },
  gemini: {
    list: (b) => b.contents,
    user: (m) => (m?.role ?? 'user') === 'user' && Array.isArray(m.parts) && m.parts.some((p) => typeof p?.text === 'string')
      && !m.parts.some((p) => p?.functionResponse || p?.function_response),
    text: (m) => m.parts.filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('\n'),
    add: (b, m, ctx) => m.parts.push({ text: ctx }),
    sys: (b, ctx) => {
      const k = 'system_instruction' in b ? 'system_instruction' : 'systemInstruction'; // 两种写法上游都认，App 用哪种就跟哪种
      const s = b[k];
      if (Array.isArray(s?.parts)) s.parts.push({ text: ctx });
      else b[k] = { ...(s && typeof s === 'object' ? s : {}), parts: [...(typeof s === 'string' ? [{ text: s }] : []), { text: ctx }] };
    },
    head: (b, txt) => {
      const k = 'system_instruction' in b ? 'system_instruction' : 'systemInstruction';
      const s = b[k];
      if (Array.isArray(s?.parts)) s.parts.unshift({ text: txt });
      else b[k] = { ...(s && typeof s === 'object' ? s : {}), parts: [{ text: txt }, ...(typeof s === 'string' ? [{ text: s }] : [])] };
    },
  },
};

// ---- 回复这边：边收边剥小记 ----
// push(一段文字) → 这次能放出去的部分。一出现 <!--note 就扣住，等 --> 到了整条丢掉；
// 末尾刚好是 <!--note 的前半截（比如 <!--no）也先扣着，下一段来了再判断。流结束时扣着的直接扔。
const HEAD = /^<!--\s*note\s/; // 跟 notes.mjs 认小记的写法一致
const maybeHead = (t) => (t.length <= 4 ? '<!--'.startsWith(t) : t.startsWith('<!--') && /^\s*(n|no|not|note)?$/.test(t.slice(4)));
export function makeCut() {
  let hold = '', inNote = false;
  return function push(s) {
    let buf = hold + s, out = '';
    hold = '';
    for (;;) {
      if (inNote) {
        const j = buf.indexOf('-->');
        if (j < 0) { hold = buf.slice(-2); return out; } // 留两个字，防 --> 断在两段之间
        buf = buf.slice(j + 3);
        inNote = false;
      }
      let i = buf.indexOf('<');
      for (; i >= 0; i = buf.indexOf('<', i + 1)) {
        const t = buf.slice(i);
        if (HEAD.test(t)) break;
        if (maybeHead(t)) { hold = t; return out + buf.slice(0, i); }
      }
      if (i < 0) return out + buf;
      out += buf.slice(0, i);
      buf = buf.slice(i + 4);
      inNote = true;
    }
  };
}

// 每种协议的回复里文字在哪。ev：流式的一个事件；whole：整个回复。
// cut(键, 增量, 算不算进回复原文) 走上面的扣字；fix(整段文字, 算不算) 直接用 split 剥。
const fixItem = (it, fix, keep) => { if (it?.type === 'message') (it.content || []).forEach((p) => fixPart(p, fix, keep)); };
const fixPart = (p, fix, keep) => { if (p?.type === 'output_text' && typeof p.text === 'string') p.text = fix(p.text, keep); };
const REPLY = {
  chat: {
    ev(o, cut) { (o.choices || []).forEach((c, i) => { const k = c?.index ?? i; if (typeof c?.delta?.content === 'string') c.delta.content = cut(k, c.delta.content, k === 0); }); },
    whole(o, fix) { (o.choices || []).forEach((c, i) => { if (typeof c?.message?.content === 'string') c.message.content = fix(c.message.content, (c.index ?? i) === 0); }); },
  },
  resp: {
    ev(o, cut, fix) {
      if (o.type === 'response.output_text.delta' && typeof o.delta === 'string') o.delta = cut(`${o.item_id}/${o.content_index}`, o.delta, true);
      else if (o.type === 'response.output_text.done' && typeof o.text === 'string') o.text = fix(o.text, false);
      else { // 收尾那几个事件里带着整段文字，也要剥
        if (o.part) fixPart(o.part, fix, false);
        if (o.item) fixItem(o.item, fix, false);
        if (o.response) (o.response.output || []).forEach((it) => fixItem(it, fix, false));
      }
    },
    whole(o, fix) { (o.output || []).forEach((it) => fixItem(it, fix, true)); },
  },
  claude: {
    ev(o, cut) {
      if (o.type === 'content_block_delta' && o.delta?.type === 'text_delta' && typeof o.delta.text === 'string') o.delta.text = cut(o.index, o.delta.text, true);
      else if (o.type === 'content_block_start' && o.content_block?.type === 'text' && o.content_block.text) o.content_block.text = cut(o.index, o.content_block.text, true);
    },
    whole(o, fix) { (o.content || []).forEach((b) => { if (b?.type === 'text' && typeof b.text === 'string') b.text = fix(b.text, true); }); },
  },
  gemini: {
    ev(o, cut) {
      (o.candidates || []).forEach((c, i) => {
        const k = c?.index ?? i;
        (c?.content?.parts || []).forEach((p) => { if (typeof p?.text === 'string' && !p.thought) p.text = cut(k, p.text, k === 0); });
      });
    },
    whole(o, fix, cut) {
      if (Array.isArray(o)) return o.forEach((x) => REPLY.gemini.ev(x, cut)); // 没带 alt=sse 的流式：一整个数组，按流的办法剥
      (o.candidates || []).forEach((c, i) => {
        (c?.content?.parts || []).forEach((p) => { if (typeof p?.text === 'string' && !p.thought) p.text = fix(p.text, (c.index ?? i) === 0); });
      });
    },
  },
};

// 聊天（lib/chat.mjs）也要用：她的话在哪、开场放哪（ASK），回复里的文字在哪（下面两个）。
// 只读不改：fn(一段文字) 收到的是这一家回复里「算进回复原文」的那部分（跟网关交给回复之后的一样）
export { ASK };
export function eachText(kind, o, fn) { REPLY[kind].ev(o, (k, s, keep) => { if (keep) fn(s); return s; }, (t) => t); }
export function wholeText(kind, o, fn) {
  const keep = (k, s, on) => { if (on) fn(s); return s; };
  REPLY[kind].whole(o, (t, on) => keep(0, t, on), keep);
}

function makeReply(kind) {
  const P = REPLY[kind], cuts = new Map(), parts = new Map(), raw = [];
  let touched = false;
  const cut = (k, s, keep) => {
    if (keep) parts.set(k, (parts.get(k) || '') + s);
    if (!cuts.has(k)) cuts.set(k, makeCut());
    const o = cuts.get(k)(s);
    if (o !== s) touched = true;
    return o;
  };
  const fix = (t, keep) => {
    if (keep) raw.push(t);
    const r = split(t);
    if (!r.notes.length && !r.bad.length) return t; // 没小记的一个字都不动
    touched = true;
    return r.clean;
  };
  return {
    // SSE 的一个事件（不含结尾空行）。看不懂的、没改动的原样回
    block(b) {
      const lines = b.split(/\r?\n/);
      const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
      if (!data.length || data.join('\n') === '[DONE]') return b;
      touched = false;
      const o = JSON.parse(data.join('\n'));
      P.ev(o, cut, fix);
      if (!touched) return b;
      let put = false;
      return lines.flatMap((l) => (!l.startsWith('data:') ? [l] : put ? [] : (put = true, ['data: ' + JSON.stringify(o)]))).join('\n');
    },
    whole(o) { touched = false; P.whole(o, fix, cut); return touched; },
    reply: () => [...raw, ...parts.values()].join('\n'), // 回复原文（含小记），交给回复之后
  };
}

// 读请求体；超过上限就停下，剩下的留给调用方边读边转
function readBody(req, max) {
  return new Promise((ok, no) => {
    const chunks = [];
    let n = 0;
    const onData = (c) => {
      chunks.push(c);
      n += c.length;
      if (n > max) { req.off('data', onData); req.off('end', onEnd); req.pause(); ok({ buf: Buffer.concat(chunks), more: true }); }
    };
    const onEnd = () => ok({ buf: Buffer.concat(chunks), more: false });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', no);
  });
}

function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

// persona(ai) → 人格全文（开着且不空才有，否则 ''）。每次请求都放在 system 最前面，在开场那段之前；没传就不带
export function makeGateway({ key, upstream = {}, hooks, persona = null, log = () => {}, now = Date.now, maxBody = MAX_BODY }) {
  // 每个 AI 一份，只在内存里：上一次请求的时间、她上一句、带过的开场和每条消息前的文字
  const memos = new Map();

  // 记忆这边的一步：出错就当没有，只记一行。每条消息前那步是 async（要等向量），这里一起 await
  async function step(ai, what, fn) {
    if (!hooks) return null;
    try { return (await fn()) || null; } catch (e) { log('网关', ai, what + '这一步跳过：', e.code || e.name, String(e.message || '').slice(0, 80)); return null; }
  }

  // 改请求体：开场放开头，每条消息前的接在她最后那句后面。改了回 true
  async function dress(kind, body, ai, focus) {
    const P = ASK[kind], list = P.list(body);
    if (!Array.isArray(list) || !list.length) throw new Error('认不出格式');
    const memo = memos.get(ai) || {};
    memos.set(ai, memo);
    const t = now(), users = list.filter(P.user), last = list[list.length - 1], her = users[users.length - 1];
    if (P.user(last)) { // 她新说了一句（不是工具回来的中间一步）
      // Responses 用 previous_response_id 时，对话存在上游那边，每次都只带新的一句，不能拿条数认开场
      const remote = kind === 'resp' && (body.previous_response_id || body.conversation);
      const fresh = memo.t == null || t - memo.t > SIX_H || (users.length === 1 && !remote);
      const shrunk = !fresh && users.length < memo.n; // 消息变少了 = App 自己压缩过，再带一遍
      if (fresh || shrunk) memo.start = await step(ai, '开场', async () => (await hooks.start(ai, { source: fresh ? 'startup' : 'compact', focus })).context);
      memo.text = P.text(last);
      memo.before = await step(ai, '每条消息前', async () => (await hooks.before(ai, { text: memo.text, focus })).context);
      memo.n = users.length;
    }
    memo.t = t;
    // 工具回来的中间一步也照样带上同一段，前面那一大段才跟上一次一样，缓存用得上
    let changed = false;
    if (memo.before && her && P.text(her) === memo.text) { P.add(body, her, memo.before); changed = true; }
    if (memo.start) { P.sys(body, memo.start); changed = true; }
    // 人格：固定的头，每次都带；读不出来就当没有
    let head = '';
    if (persona) { try { head = persona(ai) || ''; } catch (e) { log('网关', ai, '人格读不出来，这次不带：', e.code || e.name); } }
    if (head) { P.head(body, head); changed = true; }
    return changed;
  }

  return async function handle(req, res) {
    const q = req.url.indexOf('?');
    const pathname = q < 0 ? req.url : req.url.slice(0, q), search = q < 0 ? '' : req.url.slice(q);
    // 地址是 /gw/{口令}/{ai}/…。口令不进日志
    if (!key) { req.resume(); return sendJson(res, 503, { error: { message: '网关还没设口令（.env 里的 GATEWAY_KEY），先不开' } }); }
    const k = /^\/gw\/([^/]*)(\/.*)?$/.exec(pathname);
    if (!k) { req.resume(); return sendJson(res, 404, { error: { message: '网关地址是 /gw/{口令}/{ai}/…' } }); }
    let pass = k[1];
    try { pass = decodeURIComponent(pass); } catch { /* 原样比 */ }
    if (!sameKey(pass, key)) { req.resume(); log('网关', '口令不对，拦下了'); return sendJson(res, 401, { error: { message: '网关口令不对' } }); }
    const m = /^\/([^/]+)(\/.*)?$/.exec(k[2] || '');
    if (!m) { req.resume(); return sendJson(res, 404, { error: { message: '网关地址是 /gw/{口令}/{ai}/…' } }); }
    let ai = m[1];
    try { ai = decodeURIComponent(ai); } catch { /* 原样用 */ }
    const rest = m[2] || '/', fam = familyOf(rest), base = upstream[fam];
    if (!base) { req.resume(); return sendJson(res, 502, { error: { message: `网关没配 ${NAME[fam]}，不知道往哪转` } }); }
    let target;
    try { target = new URL(base.replace(/\/+$/, '') + rest + search); } catch {
      req.resume(); return sendJson(res, 502, { error: { message: `${NAME[fam]} 写得不对` } });
    }
    const kind = kindOf(req.method, rest);
    const got = await readBody(req, maxBody);

    let out = got.buf;
    if (kind && !got.more && out.length) {
      try {
        const body = JSON.parse(out.toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('认不出格式');
        if (await dress(kind, body, ai, req.headers['x-focus'] === '1')) out = Buffer.from(JSON.stringify(body));
      } catch (e) {
        out = got.buf; // 不是 JSON、认不出格式：原样转（不记 e.message，里面会带她的原话）
        log('网关', ai, rest, '请求看不懂，原样转：', e instanceof SyntaxError ? '不是 JSON' : String(e.message).slice(0, 80));
      }
    }

    const h = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !OURS.has(k)) h[k] = v;
    if (kind) h['accept-encoding'] = 'identity'; // 要读回复剥小记，不要压缩的
    if (!got.more) { if (out.length || req.headers['content-length'] !== undefined) h['content-length'] = String(out.length); }
    else if (req.headers['content-length'] !== undefined) h['content-length'] = req.headers['content-length'];

    const up = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers: h });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); }); // App 走了，上游也断开
    up.on('error', () => {
      log('网关', ai, rest, '上游连不上或中途断了');
      if (!res.headersSent) sendJson(res, 502, { error: { message: '网关连不上上游' } });
      else res.destroy();
    });
    up.on('response', (r) => answer(r));
    if (got.more) { up.write(out); req.pipe(up); } else up.end(out);

    // 回复之后：原文收齐了才交给记忆库
    const after = (reply) => {
      if (reply.trim()) step(ai, '回复之后', () => hooks.after(ai, { reply, sid: req.headers['x-session-id'] || undefined }));
    };

    function answer(r) {
      const headers = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) headers[k] = v;
      const ok = r.statusCode >= 200 && r.statusCode < 300;
      const enc = r.headers['content-encoding'];
      r.on('error', () => {});
      r.on('close', () => { if (!r.complete) res.destroy(); }); // 上游中途断了：App 这边也断，扣着的半截不往外放

      // 不认得的、上游报错的、压缩过的：原样回
      if (!kind || !ok || (enc && enc !== 'identity')) { res.writeHead(r.statusCode, headers); r.pipe(res); return; }

      const rp = makeReply(kind);
      if (/text\/event-stream/i.test(String(r.headers['content-type'] || ''))) {
        delete headers['content-length'];
        res.writeHead(r.statusCode, headers);
        res.flushHeaders();
        const dec = new TextDecoder();
        let buf = '';
        const block = (b) => { try { return rp.block(b); } catch { return b; } }; // 解析不了的事件原样转
        const take = () => {
          let mm;
          while ((mm = /\r?\n\r?\n/.exec(buf))) { res.write(block(buf.slice(0, mm.index)) + mm[0]); buf = buf.slice(mm.index + mm[0].length); }
        };
        r.on('data', (c) => { buf += dec.decode(c, { stream: true }); take(); });
        r.on('end', () => {
          buf += dec.decode();
          take();
          if (buf) res.write(block(buf));
          res.end();
          after(rp.reply());
        });
        return;
      }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        let body = Buffer.concat(chunks), reply = '';
        try {
          const o = JSON.parse(body.toString('utf8'));
          if (rp.whole(o)) body = Buffer.from(JSON.stringify(o));
          reply = rp.reply();
        } catch { log('网关', ai, rest, '回复看不懂，原样回'); }
        headers['content-length'] = String(body.length);
        res.writeHead(r.statusCode, headers);
        res.end(body);
        after(reply);
      });
    }
  };
}
