// 向量层（可选）：没配 EMBED_URL 就不打开，记忆库照只有字面匹配的样子工作。
// 思路改自 Ombre Brain（https://github.com/P0luz/Ombre-Brain，MIT，Copyright (c) 2026 P0lar1zzZ）
// 的向量召回，用 JS 重写。改了的地方：向量只决定「相不相关」，新旧另算（见 store.mjs 召回打分）；
// 不自动归档、不调外部模型判断要不要合并；不建索引，暴力全扫；私人念想不送去算。
//
// 每个 AI 一个文件 data/<ai>/vec.json：{ id: { h: 正文哈希, v: base64 的 float32, w: 「为什么记」那句的向量（可无） } }
// 写记忆永远不等向量：改了的放进队列，后台一次一条慢慢补；失败退避，同一条连着失败 3 次就放下，
// 等下次进程启动或这条记录再变时再试。向量服务挂了，召回照没配向量的样子走。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_CHARS = 2000; // 正文只取前 2000 字
const GIVE_UP = 3;

// OpenAI 兼容的 embeddings 地址（比如本机 Ollama 的 /v1/embeddings）。input 是几段文字，回同样条数的向量
export function makeEmbed({ url, model = '', key = '', timeout = 30000 }) {
  const fn = async (input, { ms = timeout } = {}) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(ms),
    });
    if (!r.ok) throw new Error('向量服务回了 ' + r.status);
    const j = await r.json();
    const data = (j.data || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== input.length) throw new Error('向量条数对不上');
    return data.map((x) => x.embedding);
  };
  fn.model = model;
  return fn;
}

export function cos(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return null; // 换过模型、长度不一样：当没有
  let x = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { x += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? x / Math.sqrt(na * nb) : null;
}
const enc = (v) => Buffer.from(new Float32Array(v).buffer).toString('base64');
const dec = (s) => new Float32Array(new Uint8Array(Buffer.from(s, 'base64')).buffer); // 先拷一份，免得对不齐
const isPriv = (m) => (m.kind || 'note') === 'wish' && !!m.priv;

export function openVec({ dir, embed, backoff = 2000, maxBackoff = 5 * 60e3, clock = Date.now }) {
  const cache = new Map();   // ai → { id: { h, v, w } }
  const decoded = new WeakMap(); // 一条 → 解开的 { v, w }，召回时不用每次重新解
  const queue = new Map();   // 键 → { ai, id, h, text, why }
  const fails = new Map();   // 键 → { h, n }
  const dirty = new Set();
  let timer = null, running = false, inFlight = null, cancelled = false, closed = false;
  let downUntil = 0, streak = 0, done = 0, waiters = [];
  const keyOf = (ai, id) => JSON.stringify([ai, id]);
  const file = (ai) => path.join(dir, ai, 'vec.json');

  function load(ai) {
    if (!cache.has(ai)) {
      let d = {};
      try { if (fs.existsSync(file(ai))) d = JSON.parse(fs.readFileSync(file(ai), 'utf8')); } catch { d = {}; }
      cache.set(ai, d);
    }
    return cache.get(ai);
  }
  function write(ai) {
    const f = file(ai);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(load(ai)), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f); // 先写旁边再换名
    dirty.delete(ai);
  }
  function writeDirty() { if (closed) return; for (const ai of [...dirty]) { try { write(ai); } catch { /* 下次再写 */ } } }

  // 线索：小模型给记忆留的处境、问法、细节、未完，拼成一段另算一个向量
  const cueOf = (m) => (m.cues?.list || []).map((x) => x.text).join('；').slice(0, MAX_CHARS);
  const hashOf = (m) => crypto.createHash('sha256')
    .update([embed.model || '', String(m.text || '').slice(0, MAX_CHARS), String(m.why || '').slice(0, MAX_CHARS), ...(cueOf(m) ? [cueOf(m)] : [])].join('\0')).digest('hex').slice(0, 24); // 没线索的跟以前一样，旧向量照用

  // 这一条要有向量：已经是最新的就不动；私人念想不送，有旧的也删掉
  function want(ai, m) {
    if (closed || !m || !m.id || m.gone) return;
    if (isPriv(m)) return drop(ai, m.id);
    const k = keyOf(ai, m.id), h = hashOf(m);
    if (load(ai)[m.id]?.h === h) { queue.delete(k); return; }
    const f = fails.get(k);
    if (f && f.h === h && f.n >= GIVE_UP) return; // 放下了，记录再变才再试
    queue.set(k, { ai, id: m.id, h, text: String(m.text || '').slice(0, MAX_CHARS), why: String(m.why || '').slice(0, MAX_CHARS), cue: cueOf(m) });
    kick();
  }
  function drop(ai, id) {
    const k = keyOf(ai, id);
    queue.delete(k);
    fails.delete(k);
    if (inFlight === k) cancelled = true;
    const d = load(ai);
    if (d[id]) { delete d[id]; if (!closed) write(ai); } // 关掉以后没写成的，下次启动对一遍时会删掉
  }
  // 进程里第一次碰这个 AI：没向量的、旧了的补上；文件里多出来的（记录已经不在了）删掉
  function sync(ai, items) {
    const d = load(ai), ids = new Set(items.map((m) => m.id));
    let pruned = false;
    for (const id of Object.keys(d)) if (!ids.has(id)) { delete d[id]; pruned = true; }
    if (pruned) write(ai);
    for (const m of items) if (isPriv(m)) drop(ai, m.id); else if (!m.gone) want(ai, m);
  }

  function kick() {
    if (running || timer || !queue.size) return;
    timer = setTimeout(run, Math.max(0, downUntil - clock()));
    timer.unref?.();
  }
  async function run() {
    timer = null;
    const [k, job] = queue.entries().next().value || [];
    if (!job) return settle();
    queue.delete(k);
    running = true; inFlight = k; cancelled = false;
    try {
      const ins = [job.text, ...(job.why ? [job.why] : []), ...(job.cue ? [job.cue] : [])];
      const vs = await embed(ins);
      if (!cancelled && !closed) {
        const e = { h: job.h, v: enc(vs[0]) };
        if (job.why) e.w = enc(vs[1]);
        if (job.cue) e.c = enc(vs[ins.length - 1]);
        load(job.ai)[job.id] = e;
        dirty.add(job.ai);
      }
      fails.delete(k);
      streak = 0; downUntil = 0; done++;
    } catch {
      streak++;
      downUntil = clock() + Math.min(maxBackoff, backoff * 2 ** (streak - 1)); // 退避：越失败等得越久
      const f = fails.get(k);
      const n = f && f.h === job.h ? f.n + 1 : 1;
      fails.set(k, { h: job.h, n });
      if (n < GIVE_UP && !queue.has(k) && !cancelled) queue.set(k, job); // 放回队尾
    } finally {
      running = false; inFlight = null;
    }
    if (!queue.size || done % 20 === 0) writeDirty(); // 攒一批再写，补几百条时不至于每条都重写一遍文件
    if (queue.size) kick(); else settle();
  }
  function settle() {
    writeDirty();
    if (!queue.size && !running) { const w = waiters; waiters = []; w.forEach((f) => f()); }
  }

  // 查询的向量：超时（默认 1.5 秒）、服务挂着、出错，都回 null，调用的一方退回字面
  async function query(text, ms = 1500) {
    if (clock() < downUntil) return null;
    let t;
    try {
      const v = await Promise.race([
        embed([String(text || '').slice(0, MAX_CHARS)], { ms }),
        new Promise((_, no) => { t = setTimeout(() => no(new Error('超时')), ms); }),
      ]);
      return v?.[0] ? Float32Array.from(v[0]) : null;
    } catch {
      downUntil = Math.max(downUntil, clock() + backoff); // 刚失败过，接下来一小会儿不再等它
      return null;
    } finally { clearTimeout(t); }
  }
  // 一条记忆的向量分 = max(正文向量, why 向量)。没有向量、或者正文改过还没补上：回 null
  function score(ai, m, qv) {
    if (!qv || isPriv(m)) return null;
    const e = load(ai)[m.id];
    if (!e || e.h !== hashOf(m)) return null;
    let x = decoded.get(e);
    if (!x) { x = { v: dec(e.v), w: e.w ? dec(e.w) : null, c: e.c ? dec(e.c) : null }; decoded.set(e, x); }
    const a = cos(qv, x.v), b = x.w ? cos(qv, x.w) : null, c = x.c ? cos(qv, x.c) : null;
    return a == null && b == null && c == null ? null : Math.max(a ?? -1, b ?? -1, c ?? -1);
  }

  // 测试和关机用：等队列空了
  const idle = () => (!queue.size && !running && !timer ? Promise.resolve() : new Promise((ok) => waiters.push(ok)));
  // 关掉：先把攒着的写掉，之后不再收、不再写（还在路上的那一条回来了也不写）
  function close() { clearTimeout(timer); timer = null; queue.clear(); writeDirty(); closed = true; settle(); }
  const has = (ai, id) => !!load(ai)[id];

  const state = () => (clock() < downUntil ? 'down' : 'on'); // 给网页提醒用：向量服务刚失败过就是 down
  return { want, drop, sync, query, score, idle, close, has, state };
}
