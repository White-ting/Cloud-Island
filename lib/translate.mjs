// 思考翻译：把 TA 回话之前的英文思考译成中文。
// POST /api/translate { texts: [英文…] } → { ok, zh: [中文…], by: ['api'|'cache'|'skip'|'fail'…] }
// GET  /api/translate → { on, model }：配没配（网页据此决定出不出「翻译」）
// 用哪家：先看设置里「翻译」那一项（svc 的 fm.trans：地址 + 模型 + Key）；没填就看 .env 的 TRANSLATE_BASE / TRANSLATE_MODEL / TRANSLATE_KEY；
// 都没配就关：接口回 503「没配翻译」。只认 OpenAI 兼容的 /chat/completions（本机 Ollama 的 /v1 也是这种）。
// 翻过的存在 data/translate-cache.jsonl（模型 + 原文的 sha1 → 译文），同一段思考不翻第二遍。
// 一次只翻一段，排队做（本机模型同时只跑一个）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './store.mjs';
import { keyFor } from './svc.mjs';
import { makeNet } from './net.mjs';

const SYS = '把用户给的英文译成自然、通顺的简体中文。这是一个 AI 回话之前的思考过程：照原意译，不增不减，不解释、不总结；代码、文件名、命令、专有名词照原样保留。只输出译文。';
const MAX_N = 20, MAX_LEN = 12000, CACHE_MAX = 5000;

// 地址写到 /v1 这一层（或者写完整的 …/chat/completions）
export const chatUrl = (base) => { const b = String(base || '').replace(/\/+$/, ''); return /\/chat\/completions$/.test(b) ? b : b + '/chat/completions'; };

// svc：lib/svc.mjs（可以不传）；env：{ base, model, key }（.env 里那三项）
// 设置里填的那一家：Key 只带去存 Key 时的那个地址（svc.keyFor），地址要过 lib/net.mjs 的检查；.env 里写的是管理员自己定的，不查。上游回跳转当失败
export function openTranslate({ dir, svc = null, env = {}, log = () => {}, fetchFn = fetch, net = makeNet() } = {}) {
  const file = path.join(dir, 'translate-cache.jsonl');
  let cache = null, chain = Promise.resolve();
  const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
  // 现在用哪一家：{ url, model, key } 或 null（没配）
  function conf() {
    let t = null;
    try { t = svc?.read().fm?.trans || null; } catch { t = null; }
    if (t?.url && t?.model) return { url: chatUrl(t.url), model: t.model, key: keyFor(t, t.url), web: true };
    if (env.base && env.model) return { url: chatUrl(env.base), model: env.model, key: env.key || '' };
    return null;
  }
  function load() {
    if (cache) return cache;
    cache = new Map();
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try { const o = JSON.parse(line); if (o.h && typeof o.zh === 'string') { cache.delete(o.h); cache.set(o.h, o.zh); } } catch { /* 坏的一行跳过 */ }
      }
    } catch { /* 还没有 */ }
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return cache;
  }
  function keep(h, zh) {
    const c = load(); c.set(h, zh);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ h, zh, t: Date.now() }) + '\n', { mode: 0o600 });
    if (c.size > CACHE_MAX) {     // 太多了：只留新的那些，整份重写
      while (c.size > CACHE_MAX) c.delete(c.keys().next().value);
      fs.writeFileSync(file + '.tmp', [...c].map(([k, v]) => JSON.stringify({ h: k, zh: v })).join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    }
  }
  async function viaApi(c, text) {
    if (c.web) await net.check(c.url, '翻译服务的地址');
    const r = await fetchFn(c.url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(c.key ? { authorization: 'Bearer ' + c.key } : {}) },
      signal: AbortSignal.timeout(Math.min(240000, 30000 + text.length * 60)),
      body: JSON.stringify({ model: c.model, stream: false, temperature: 0.2, max_tokens: 8192, messages: [{ role: 'system', content: SYS }, { role: 'user', content: text }] }) });
    if (!r.ok) throw new Error('翻译服务回了 ' + r.status);
    const j = await r.json(), out = String(j?.choices?.[0]?.message?.content || '').trim();
    if (!out) throw new Error('翻译服务回的是空的');
    return out;
  }
  async function one(c, raw) {
    const text = String(raw == null ? '' : raw).trim().slice(0, MAX_LEN);
    if (!text || !/[A-Za-z]{3}/.test(text)) return { zh: text, by: 'skip' };   // 空的、本来就不是英文的：不翻
    const h = sha(c.model + '\n' + text), hit = load().get(h);
    if (hit != null) return { zh: hit, by: 'cache' };
    const zh = await viaApi(c, text); keep(h, zh); return { zh, by: 'api' };
  }
  function status() { const c = conf(); return { on: !!c, ...(c ? { model: c.model } : {}) }; }
  function run(body) {
    const texts = body && Array.isArray(body.texts) ? body.texts : null;
    if (!texts || !texts.length) throw fail(400, '要给 texts（一组要翻的话）');
    if (texts.length > MAX_N) throw fail(400, `一次最多 ${MAX_N} 段`);
    const c = conf();
    if (!c) throw fail(503, '没配翻译：在设置「翻译」里填地址和模型，或者在 .env 里写 TRANSLATE_BASE、TRANSLATE_MODEL');
    const job = async () => {
      const zh = [], by = [];
      for (const t of texts) {
        try { const r = await one(c, t); zh.push(r.zh); by.push(r.by); }
        catch (e) { zh.push(''); by.push('fail'); log('翻译', '没翻成：' + e.message); }
      }
      return { ok: true, zh, by };
    };
    const p = chain.then(job, job); chain = p.catch(() => {});
    return p;
  }
  return { run, status, conf };
}
