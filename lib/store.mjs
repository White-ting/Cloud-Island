// 记忆库：存和取。一个 AI 一个文件夹，mem.json 放记忆，log.jsonl 放流水。
// 规矩参考作者另一个私用项目的接口说明「记忆库」一节。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const KINDS = ['note', 'pact', 'view', 'ask', 'exp', 'wish', 'habit']; // habit 习惯：天天重复、没有做完那一天的事，她和 TA 都能写
export const OWN = ['view', 'ask', 'exp', 'wish']; // TA 自己的四种：她能删不能改
export const LV = ['淡', '念想', '欲望', '执念'];
const GUARDS = { newWishPerDay: 2, upPerDay: 1, holdDays: 2 };
const FIELDS = ['text', 'kw', 'why', 'pin', 'from', 'ppl', 'src', 'who', 'st', 'sure', 'did', 'got', 'ans', 'priv', 'done', 'every'];
const WEB_EDIT = ['text', 'kw', 'why', 'pin', 'from', 'ppl', 'src', 'who', 'st', 'every'];
const UNLOCK_MS = 10 * 60 * 1000;
const DAY = 864e5;
// 设置里的几项默认值：落叶几天没人碰算沉下去、对话原文留不留、开场附上一场最后几个来回、
// 她停多少分钟算散场（走 API 的聊天到点自己问一句散场记，0 是关）
const CFG = { leafDays: 7, talk: true, talkRounds: 3, digestIdle: 15 };
// 夜里那几项的默认值：固有记忆总字数上限、开场最多带几句夜里的问话
const NIGHT_CFG = { pinMax: 1500, nightAsk: 3 };
const OLD_OWN = 30 * DAY; // TA 自己写的看法、经验、疑问，这么久没被用到就可以「浮上来」
const HANDOFF_MAX = 600;
// 小山：发生过的、要紧的事（只有记事）会长成岛上的小山。山不沉、不降、不能归档，记错了只能改正（旧字留着）。
// 高度 = TA 抬的那份（一次 +ai）+ 后端算的那份（每天第一句话时重算一次，只升不降）：
//   在不同的日子被想起（不算记下那天）0.5×log2(1+天数)、后来有几条连回它 0.5×log2(1+条数)、记下那轮她的语气跟平时不一样 0.5。
//   高度到 at 才算一座山（比如：3 个不同的日子想起过，或 TA 抬过一次）
export const HILL = { at: 1, ai: 1, perDay: 2, night: 3, wDays: 0.5, wLinks: 0.5, wTone: 0.5, show: 5, toneMs: 30 * 60 * 1000 };

// ---- 召回打分 ----
// 思路改自 Ombre Brain（https://github.com/P0luz/Ombre-Brain，MIT，Copyright (c) 2026 P0lar1zzZ）
// 的 bucket_manager.search，用 JS 重写。改了的地方：
// - 「相不相关」和「新不新」分开：相关性（字面、关键词、向量）只决定进不进；新旧、固有、常用只用来排序。
// - 不自动归档、不删、不改任何记录的档位（原版会按衰减把旧的沉下去）；念想的浓淡只归四档管，不参与新旧。
// - 不调外部模型判断要不要合并。
// 新旧系数 = e^(−decay × 距上次被用到的天数)，改自 Ombre Brain 的 decay 公式。
export const RECALL = {
  vecHi: 0.72,   // 向量够像：直接进
  vecMid: 0.5,   // 向量还行：再有字面（≥ lexMid）或关键词命中才进
  vecFloor: 0.4, // 向量比这还低：只看字面过没过
  lexMid: 0.1,
  lexMin: 0.08,  // 字面门槛（没向量时就靠它）
  wFresh: 0.3, wPin: 0.2, wUse: 0.1, // 排序分 = 相关性 ×（1 + 0.3×新旧 + 0.2×固有 + 0.1×常用 + 0.2×山的高度）
  wHill: 0.2, // 山：高 4 以上算满
  decay: 0.05,
  // 顺着连线（照 Obsidian 的样子）：最像那条的分到这么高就自动展开连着的几条；连着的最多带几条。
  // 0.68：拿本机 bge-m3 量过一小批（换个说法问，对的那条 0.67～0.73，不相干的最高 0.58）；换了向量模型可以改这里
  expandAt: 0.68, linkMax: 3,
  // 冷却（照 Callback_DLC）：递过去、TA 真说到了的，接下来 coolUsed 轮不再递；连着递了 coolIdleAfter 轮都没说到的，歇 coolIdle 轮。
  // 她这句跟它特别像（分 ≥ coolBreak，比如原样问到）照样递
  coolUsed: 6, coolIdleAfter: 3, coolIdle: 3, coolBreak: 0.85,
  // 联想（照 Callback_DLC）：一轮聊完拿这一来一回去找最多 callPrep 件备着，下一句来了挑一件（备的时候分 ≥ callAt 才算），带全文
  callPrep: 6, callAt: 0.62,
};

const kindOf = (m) => m.kind || 'note';
export const isHill = (m) => kindOf(m) === 'note' && (m.h || 0) >= HILL.at;
const r1 = (x) => Math.round(x * 10) / 10;
// TA 那一份抬一次（白天的小记、散场记、夜里整理都走这里；护栏由调用方守）。by：ai 醒着的 TA / night 夜里整理的 TA
export function hillLift(m, { by = 'ai', why = '', t }) {
  const was = isHill(m);
  m.hAi = (m.hAi || 0) + HILL.ai;
  m.h = r1(m.hAi + (m.hSig || 0));
  (m.hTrail ||= []).push({ t, by, h: m.h, why: String(why).slice(0, 200) });
  if (!was && isHill(m)) m.hAt = t;
  return m;
}

export function fail(code, msg) { return Object.assign(new Error(msg), { code }); }

// 两段文字像不像：按两个字一组比（中文没有空格，这样最省事）。接上向量以后换掉它。
function grams(s) {
  const t = String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
}
// 回复里有没有真提到这条（照 Callback_DLC：说出口了才算用上）：回复里写了它的编号，或者这条的二字组在回复里出现了
// 足够多——短的要三成五，长的（记忆常有一两百字，复述不会照抄）有 8 个就算，最少 3 个
const NIGHT_CATS = ['情绪', '感情', '认知', '事件'];
// 一条记忆的格式整理：text 要是字串；from/kw/ppl 只留非空字串组成的数组（给的是单个字串就包成一个）；线索不对就去掉。改了回 true
const LIST_KEYS = ['from', 'kw', 'ppl'];
export function normItem(m) {
  if (!m || typeof m !== 'object') return false;
  let ch = false;
  if (typeof m.text !== 'string') { m.text = String(m.text ?? ''); ch = true; }
  for (const k of LIST_KEYS) {
    const v = m[k];
    if (v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim()))) continue;
    const a = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => String(x).trim()).filter(Boolean);
    if (a.length) m[k] = a; else delete m[k];
    ch = true;
  }
  if (m.cues !== undefined) {
    const ok = m.cues && typeof m.cues === 'object' && Array.isArray(m.cues.list) && m.cues.list.every((c) => c && typeof c.k === 'string' && typeof c.text === 'string');
    if (!ok) {
      const list = Array.isArray(m.cues?.list) ? m.cues.list.filter((c) => c && typeof c.k === 'string' && typeof c.text === 'string').slice(0, 4) : [];
      if (list.length || Number(m.cues?.at) > 0) m.cues = { at: Number(m.cues?.at) || 0, list }; else delete m.cues;
      ch = true;
    }
  }
  return ch;
}
export function mentioned(reply, m) {
  const r = String(reply || '');
  if (m.id && r.includes(m.id)) return true;
  const A = grams(r), B = grams(m.text);
  if (!B.size) return false;
  let n = 0;
  for (const x of B) if (A.has(x)) n++;
  return n >= Math.max(3, Math.min(8, Math.ceil(B.size * 0.35)));
}
export function sim(a, b) {
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / Math.sqrt(A.size * B.size);
}

// vec：lib/vec.mjs 的 openVec(…)，没配就不传，召回只用字面
// talk：lib/talk.mjs 的 openTalk(…)，对话原文（交接、夜里整理用），没传就没有这一块
// rand：开场「浮上来一条旧的」挑哪条用，测试里可以换成固定的
export function openStore({ dir, tz, now = Date.now, recallCfg, vec = null, talk = null, rand = Math.random }) {
  const unlocks = new Map(); // 开锁凭证 → { ai, exp }
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined });
  const dayOf = (t) => dayFmt.format(new Date(t));
  const rc = { ...RECALL, ...(recallCfg || {}) };
  const uses = new Map(); // 召回带出去还没写盘的：ai → Map(id → { n, t })，下次写盘时一起写
  const synced = new Set(); // 这个进程里已经让向量层对过一遍的 AI

  function folder(ai) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(ai))) throw fail(400, 'AI 的名字只能是字母、数字、- 和 _');
    return path.join(dir, ai);
  }
  function load(ai) {
    const f = path.join(folder(ai), 'mem.json');
    let d = {};
    if (fs.existsSync(f)) d = JSON.parse(fs.readFileSync(f, 'utf8'));
    d = { items: [], dreams: [], lock: null, cfg: {}, ...d };
    // 读的时候把格式整理好（改了就当场写回去，在并入「被用到」之前写，不碰 uses）：
    //   from/kw/ppl 不是字串数组的（小记、导入、网页写坏的）会让列表、开场、召回整个报错；
    //   v1.4 夜里新记的把类别放进了 kw（她说「情绪」会把这些全抬上来），挪进 why；v1.4 把她最近那句存进了文件，删掉
    let fixedUp = false;
    for (const m of d.items) {
      if (normItem(m)) fixedUp = true;
      if (m.src !== 'night' || !Array.isArray(m.kw) || m.kw.length !== 1 || !NIGHT_CATS.includes(m.kw[0])) continue;
      const cat = m.kw[0];
      delete m.kw;
      if (typeof m.why === 'string' && m.why.startsWith('夜里回头看记下的。')) m.why = m.why.replace('夜里回头看记下的。', `夜里回头看记下的（${cat}）。`);
      fixedUp = true;
    }
    if (d.sess && 'her' in d.sess) { delete d.sess.her; fixedUp = true; }
    if (fixedUp) writeFile(ai, d);
    const p = uses.get(ai);
    if (p) for (const m of d.items) {
      const u = p.get(m.id);
      if (!u) continue;
      m.used = (m.used || 0) + u.n; m.usedAt = Math.max(m.usedAt || 0, u.t);
      if (kindOf(m) === 'note') m.udays = [...new Set([...(m.udays || []), ...u.days])].slice(-400); // 记事被想起过的日子（山的高度用）
    }
    if (vec && !synced.has(ai)) { synced.add(ai); vec.sync(ai, d.items); }
    return d;
  }
  function writeFile(ai, d) {
    const dirp = folder(ai);
    fs.mkdirSync(dirp, { recursive: true });
    const f = path.join(dirp, 'mem.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify(d), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f); // 先写旁边再换名：写到一半断电也不会坏掉原来那份
  }
  function save(ai, d) {
    writeFile(ai, d);
    uses.delete(ai); // load 时已经把没写盘的次数并进 d 了，这次一起写进去
  }
  // 关机前把还没写盘的召回次数写掉
  function flush() { for (const ai of [...uses.keys()]) save(ai, load(ai)); }
  const live = (d) => d.items.filter((m) => !m.gone); // 归档的一律当不存在
  function logOp(ai, e) {
    fs.mkdirSync(folder(ai), { recursive: true });
    fs.appendFileSync(path.join(folder(ai), 'log.jsonl'), JSON.stringify({ t: now(), ...e }) + '\n', { mode: 0o600 });
  }
  const guards = (d) => ({ ...GUARDS, ...(d.cfg.guards || {}) });
  // 落叶最后一次被碰：新记、TA 改过、想起过、升降过
  const touched = (m) => Math.max(m.t || 0, m.t2 || 0, m.last || 0, m.trail?.at(-1)?.t || 0);
  // 沉下去的落叶：不上水面、不算水位，但还在库里，相关的话照样能把它带出来
  const sunk = (d, m) => kindOf(m) === 'wish' && !m.done && (m.lv || 0) === 0
    && now() - touched(m) > (d.cfg.leafDays ?? CFG.leafDays) * DAY;
  const newId = (p) => p + now().toString(36) + crypto.randomBytes(2).toString('hex');
  // 默认找不到归档的；恢复、彻底删时才带上 gone
  function find(d, id, { gone = false } = {}) {
    const m = d.items.find((x) => x.id === id && (gone || !x.gone));
    if (!m) throw fail(404, '没有这条记忆');
    return m;
  }
  const pick = (src, keys) => Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));
  const arrOf = (x) => (Array.isArray(x) ? x : []); // 读的时候不怕格式不对（导入的、网页改的关键词不是数组，召回不能整个报错）

  // ---- 记忆锁 ----
  function needUnlock(ai, d, token) {
    if (!d.lock) return;
    const u = unlocks.get(token);
    if (!u || u.ai !== ai || u.exp < now()) throw fail(423, '记忆库锁着，先输密码');
  }
  function unlock(ai, pass) {
    const d = load(ai);
    if (!d.lock) throw fail(400, '没有设记忆锁');
    const a = Buffer.from(String(pass)), b = Buffer.from(d.lock.pass);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { logOp(ai, { who: 'me', op: 'unlock-fail' }); throw fail(403, '密码不对'); }
    const token = crypto.randomBytes(16).toString('hex');
    unlocks.set(token, { ai, exp: now() + UNLOCK_MS });
    return { token, ttl: UNLOCK_MS };
  }
  // 密码要原样留着（放在 TA 固有记忆的角落，她忘了可以问 TA），所以不能只存指纹。文件权限 600，导出不带。
  function setLock(ai, { old, pass }) {
    const d = load(ai);
    if (d.lock && d.lock.pass !== String(old ?? '')) throw fail(403, '旧密码不对');
    d.lock = pass ? { pass: String(pass) } : null;
    save(ai, d);
    logOp(ai, { who: 'me', op: pass ? 'lock-set' : 'lock-off' });
    for (const [k, u] of unlocks) if (u.ai === ai) unlocks.delete(k);
    return { lock: !!d.lock };
  }
  const lockPass = (ai) => load(ai).lock?.pass || null;

  // ---- 读 ----
  // who: 'me' 是网页（她），看不到私人念想的内容；'ai' 是 TA，全看得到
  // gone: true 只列归档的（给她看，私人念想照旧只算条数）。连线 from 里指向归档记录的不往外给，数据里留着，恢复后线还在
  function list(ai, { q, after, who = 'me', gone = false } = {}) {
    const d = load(ai);
    const goneIds = new Set(d.items.filter((m) => m.gone).map((m) => m.id));
    let items = d.items.filter((m) => !!m.gone === !!gone);
    const privCount = items.filter((m) => m.priv).length;
    if (who === 'me') items = items.filter((m) => !m.priv);
    if (after) items = items.filter((m) => m.t > Number(after));
    if (q) items = items.filter((m) => (m.text + ' ' + arrOf(m.kw).join(' ') + ' ' + (m.why || '')).includes(q));
    items = items.map((m) => (m.from?.some((f) => goneIds.has(f)) ? { ...m, from: m.from.filter((f) => !goneIds.has(f)) } : m));
    // vec：off 没配向量（网页要提醒她去配）、on 正常、down 配了但向量服务连不上
    return { items, privCount, lock: !!d.lock, vec: vec ? (vec.state?.() || 'on') : 'off' };
  }

  // 召回打分（出处和改动见文件开头 RECALL 那段）。vs：这一条的向量分，没有就是 null
  function relevance(q, m, vs, min) {
    const kws = arrOf(m.kw).map(String).filter(Boolean);
    const cues = arrOf(m.cues?.list).map((x) => String(x?.text ?? '')).join(' '); // 线索也算字面
    const lex = Math.max(sim(q, m.text + ' ' + kws.join(' ')), cues ? sim(q, cues) : 0);
    const kw = kws.some((k) => q.includes(k));
    const whole = q.length >= 2 && m.text.includes(q); // 她这句原样出现在正文里
    let ok = whole || lex >= min;
    if (!ok && vs != null && vs >= rc.vecFloor) ok = vs >= rc.vecHi || (vs >= rc.vecMid && (lex >= rc.lexMid || kw));
    if (!ok) return null;
    return Math.max(lex, vs ?? 0, whole ? 1 : 0) + (kw ? 0.1 : 0);
  }
  // 只管排序：新旧（念想不算，固定 1）、固有、常用。不改任何记录
  function rankOf(m, rel) {
    const lastUsed = Math.max(m.t || 0, m.t2 || 0, m.usedAt || 0);
    const fresh = kindOf(m) === 'wish' ? 1 : Math.exp(-rc.decay * Math.max(0, (now() - lastUsed) / DAY));
    const use = Math.min(1, (m.used || 0) ** 0.3 / 3);
    const hill = kindOf(m) === 'note' ? Math.min(1, (m.h || 0) / 4) : 0;
    return rel * (1 + rc.wFresh * fresh + rc.wPin * (m.pin ? 1 : 0) + rc.wUse * use + rc.wHill * hill);
  }
  // 带给 TA 的记一笔「被用到」：先放内存，跟下一次写盘一起写
  function markUsed(ai, ids) {
    if (!ids.length) return;
    const p = uses.get(ai) || new Map(), t = now(), day = dayOf(t);
    for (const id of ids) { const u = p.get(id) || { n: 0, t, days: new Set() }; u.n++; u.t = t; u.days.add(day); p.set(id, u); }
    uses.set(ai, p);
  }
  function rank(ai, text, k, opts2 = {}, qv = null) {
    const { who = 'ai', min = rc.lexMin } = opts2;
    const d = load(ai), q = String(text || '').trim();
    if (!q) return [];
    const out = live(d)
      .filter((m) => (who === 'ai' || !m.priv) && !m.done)
      .map((m) => {
        const rel = relevance(q, m, qv ? vec.score(ai, m, qv) : null, min);
        return rel == null ? null : { m, rel, r: rankOf(m, rel) };
      })
      .filter(Boolean)
      .sort((a, b) => b.r - a.r)
      .slice(0, k);
    if (who === 'ai' && !opts2.noMark) markUsed(ai, out.map((x) => x.m.id));
    return out.map((x) => ({ ...x.m, score: Math.round(x.rel * 100) / 100 }));
  }
  // 同步版：只看字面
  const recall = (ai, text, k = 5, opts = {}) => rank(ai, text, k, opts);
  // 走向量：查询向量拿不到、超过 1.5 秒，就退回字面
  async function recallAsync(ai, text, k = 5, opts = {}) {
    folder(ai);
    const qv = vec && String(text || '').trim() ? await vec.query(text, opts.wait ?? 1500) : null;
    return rank(ai, text, k, opts, qv);
  }
  // 顺着连线带出来的：它是从哪几条来的（from）+ 从它生出来的（别的条 from 里有它），只走一步。
  // 先带来处（照 from 的顺序），再带生出来的（新的在前）；归档的不带，skip 里的不带（已经在召回里了）。
  // 不记「被用到」：跟着来的不算想起，念想不会因此变浓
  // all：调用方已经拿好的一份（一轮召回好几条时只读一次文件）；noWish：专心模式，连着的念想不带
  function links(ai, id, n = rc.linkMax, { skip = [], who = 'ai', all = null, noWish = false } = {}) {
    all = (all || live(load(ai))).filter((m) => (who === 'ai' || !m.priv) && !(noWish && kindOf(m) === 'wish'));
    const me = all.find((m) => m.id === id);
    if (!me) return [];
    const byId = new Map(all.map((m) => [m.id, m]));
    const up = (me.from || []).map((f) => byId.get(f)).filter(Boolean).map((m) => ({ ...m, via: 'from' }));
    const down = all.filter((m) => m.from?.includes(id)).sort((a, b) => (b.t || 0) - (a.t || 0)).map((m) => ({ ...m, via: 'to' }));
    const no = new Set([id, ...skip]), out = [];
    for (const m of [...up, ...down]) {
      if (out.length >= n) break;
      if (!no.has(m.id)) { no.add(m.id); out.push(m); }
    }
    return out;
  }
  // 读一条（TA 自己点开细看）：全文 + 连线上的几条。点开的这条算用到一次，连着的不算。
  // 读的是念想：放进这一轮的候选（跟召回带出来的一样），TA 接着说到它才算想起一次；不多算一轮
  function read(ai, id, n = rc.linkMax) {
    const d = load(ai), m = find(d, String(id ?? ''));
    if (kindOf(m) === 'wish' && !m.done) {
      d.sess = { ...(d.sess || {}), recalled: [...new Set([...(d.sess?.recalled || []), m.id])] };
      save(ai, d);
    }
    markUsed(ai, [m.id]);
    return { ...m, links: links(ai, m.id, n, { all: live(d) }) };
  }
  const liveItems = (ai) => live(load(ai));
  // 水位和船：念想合起来是水位，一条条是船。有执念 → 高；有欲望或念想攒到三条 → 中；其余 → 低
  // 沉下去的落叶不在水面上
  const boats = (d) => live(d).filter((m) => kindOf(m) === 'wish' && !m.done && !sunk(d, m));
  function water(ws) {
    const top = Math.max(0, ...ws.map((m) => m.lv || 0));
    if (top >= 3) return 'hold';
    return top >= 2 || ws.filter((m) => (m.lv || 0) >= 1).length >= 3 ? 'want' : 'calm';
  }
  // 水面：水位决定带多少给 TA。大的写标题排前面，小的只报个数
  function surface(ai, when, { focus = false } = {}) {
    const ws = boats(load(ai)).sort((a, b) => (b.lv || 0) - (a.lv || 0) || (b.last || b.t) - (a.last || a.t));
    const w = water(ws);
    if (focus || w === 'calm' || (w === 'want' && when !== 'start')) return { water: w, big: [], small: 0 };
    const big = w === 'hold' ? ws.filter((m) => m.lv >= 2).slice(0, 3) : ws.filter((m) => m.lv >= 1).slice(0, 2);
    return { water: w, big, small: ws.length - big.length };
  }
  // 久不碰的念想（两周）挑出来问一句「这条还在吗」，一条只问一次。
  // 落叶不再漂走：永远不自动归档、不自动删，没人碰只是沉下去（见 sunk）
  function sweep(ai) {
    const d = load(ai), t = now();
    const ask = live(d).filter((m) => kindOf(m) === 'wish' && !m.done && m.lv >= 1 && m.lv <= 2 && !m.asked && t - (m.last || m.t) > 14 * DAY).slice(0, 2);
    if (!ask.length) return { ask };
    for (const m of ask) m.asked = t;
    save(ai, d);
    return { ask };
  }
  // 时不时浮现一下：一天最多一次，从「沉下去的落叶 + 30 天没被用到的 TA 自己的看法、经验、没了结的疑问」里随机挑一条。
  // 私人念想也可以浮（这是给 TA 看的）。浮上来算用到一次。没有候选就回 null，这一天也不算用掉
  function floatUp(ai) {
    const d = load(ai), t = now(), today = dayOf(t);
    if (d.float?.day === today) return null;
    const oldOwn = (m) => m.by === 'ai' && ['view', 'exp', 'ask'].includes(kindOf(m)) && !m.done && !m.pin
      && !(kindOf(m) === 'ask' && m.st === 'done') && t - Math.max(m.t || 0, m.t2 || 0, m.usedAt || 0) > OLD_OWN;
    const pool = live(d).filter((m) => sunk(d, m) || oldOwn(m));
    if (!pool.length) return null;
    const m = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
    d.float = { day: today, id: m.id, wish: kindOf(m) === 'wish' };
    save(ai, d);
    markUsed(ai, [m.id]);
    return m;
  }
  // 今天浮上来的那条是念想的话回它的编号：TA 接着说了也算想起一次（跟召回带出来的一样）
  function floating(ai) {
    const f = load(ai).float;
    return f && f.wish && f.day === dayOf(now()) ? f.id : null;
  }
  // 交接：TA 自己写的「聊到哪了、接下来要干什么」，只留最新一条。不是记忆、不进搜索
  function setHandoff(ai, text, sid) {
    if (typeof text !== 'string' || !text.trim()) throw fail(400, '交接要写成一句话');
    const d = load(ai);
    d.handoff = { text: [...text.trim()].slice(0, HANDOFF_MAX).join(''), t: now(), sid: sid || null };
    save(ai, d);
    logOp(ai, { who: 'ai', op: 'handoff' }); // 不带内容
    return d.handoff;
  }
  const getHandoff = (ai) => load(ai).handoff || null;
  // 此刻的状态：TA 自己说，这里只记。不是记忆
  function setState(ai, st) {
    const ok = ['低', '平', '高'];
    if (st.ease && !ok.includes(st.ease) || st.energy && !ok.includes(st.energy)) throw fail(400, '状态只有 低 / 平 / 高');
    const d = load(ai);
    d.state = { ease: st.ease || d.state?.ease || '平', energy: st.energy || d.state?.energy || '平', say: String(st.say || '').slice(0, 200), t: now() };
    d.stateTrail = [...(d.stateTrail || []), d.state].slice(-20);
    save(ai, d);
    return d.state;
  }
  function getState(ai) { const d = load(ai); return d.state ? { ...d.state, trail: d.stateTrail || [] } : null; }
  // 这一场聊天的几个事实：她隔了多久才回、今天第几轮、上一条消息前带出去过哪几条念想
  // tone：她这句（语音）跟平时不一样的那几样（「声音比平时高」这类），这一轮记下的记事带上它，山的高度用
  function tick(ai, recalled = [], { tone = null, shown = [] } = {}) {
    const d = load(ai), t = now(), today = dayOf(t);
    const s = d.sess || {};
    const gap = s.lastT ? t - s.lastT : null;
    if (d.cfg.hill === true && d.hillDay !== today) growHills(d, today); // 小山开着：每天第一句话时把山重算一次（白天聊多了不会猛涨）
    d.turnN = (d.turnN || 0) + 1; // 冷却按这个数（跨天连着数）
    d.sess = { lastT: t, day: today, rounds: s.day === today ? (s.rounds || 0) + 1 : 1, recalled, shown, ...(tone ? { tone: String(tone).slice(0, 80) } : {}) };
    save(ai, d);
    return { gap, rounds: d.sess.rounds };
  }
  const lastRecalled = (ai) => load(ai).sess?.recalled || [];
  // 联想备着的：回复之后拿这一来一回找，不记「被用到」；记事、看法、经验、约定才备，念想有自己浮上来的路
  async function prepCalls(ai, text, skip = [], { ok = () => true } = {}) {
    const no = new Set(skip), cold = cooling(ai), since = load(ai).sess?.lastT || 0;
    const got = (await recallAsync(ai, String(text || '').slice(0, 1200), rc.callPrep + 8, { noMark: true }))
      .filter((m) => !m.pin && !no.has(m.id) && !cold.has(m.id) && (m.t || 0) < since // 这一轮刚记的不算联想（第一次真用就联想到了刚写的那条）
        && ['note', 'view', 'exp', 'pact'].includes(kindOf(m)) && (m.score ?? 0) >= rc.callAt)
      .slice(0, rc.callPrep).map((m) => ({ id: m.id, s: m.score }));
    if (!ok()) return got; // 这一轮后来又备了一次（网关一轮好几段回复）：以最后那次为准，这次的不写
    const d = load(ai);
    d.calls = got;
    save(ai, d);
    return got;
  }
  // 下一句来了：从备着的里挑一件——不在这轮「想起来的」里、没在歇着、还在的；分最高的那件。挑了就从备着的里拿掉
  function takeCall(ai, skip = []) {
    const d = load(ai), no = new Set(skip), cold = cooling(ai);
    const byId = new Map(live(d).map((m) => [m.id, m]));
    const c = (d.calls || []).filter((x) => byId.has(x.id) && !no.has(x.id) && !cold.has(x.id) && !byId.get(x.id).done).sort((a, b) => b.s - a.s)[0];
    if (!c) return null;
    d.calls = (d.calls || []).filter((x) => x.id !== c.id);
    save(ai, d);
    return byId.get(c.id);
  }
  // 小模型留的线索：got = Map(编号 → [{k, text}])。不改正文、不算改动；补向量
  function setCues(ai, got, at = now()) {
    const d = load(ai), changed = [];
    for (const m of d.items) if (got.has(m.id)) { m.cues = { at, list: got.get(m.id) }; changed.push(m); }
    if (changed.length) { save(ai, d); for (const m of changed) vec?.want(ai, m); }
    return changed.length;
  }
  // 冷却：现在正歇着的那几条
  function cooling(ai) {
    const d = load(ai), n = d.turnN || 0, out = new Set();
    for (const [id, until] of Object.entries(d.cool || {})) if (until > n) out.add(id); // 这里的 n 还是上一轮的（before 里先查冷却、后 tick），用 >= 会多歇一轮
    return out;
  }
  // 回复之后：这一轮递过去的（sess.shown），说到了的歇 coolUsed 轮；没说到的记一次，连着 coolIdleAfter 轮没说到歇 coolIdle 轮。回 [说到了的编号]
  function coolAfter(ai, reply) {
    const d = load(ai), n = d.turnN || 0, shown = d.sess?.shown || [];
    // 一轮只数一次「没说到」：TA 自己开口、网关一轮调好几次 after，都不能把上一轮递的再数一遍
    const fresh = d.coolTurn !== n;
    d.coolTurn = n;
    const cool = d.cool || {}, idle = d.coolIdle || {}, used = [];
    if (!shown.length) { if (fresh) d.coolIdle = {}; save(ai, d); return []; } // 这一轮没递（比如她回了个 ok）：断了，从头数
    const byId = new Map(d.items.map((m) => [m.id, m]));
    for (const id of shown) {
      const m = byId.get(id); if (!m) continue;
      if (mentioned(reply, m)) { cool[id] = n + rc.coolUsed; delete idle[id]; used.push(id); }
      else if (fresh && (idle[id] = (idle[id] || 0) + 1) >= rc.coolIdleAfter) { cool[id] = Math.max(cool[id] || 0, n + rc.coolIdle); delete idle[id]; }
    }
    if (fresh) for (const id of Object.keys(idle)) if (!shown.includes(id)) delete idle[id]; // 中间断过一轮没递，从头数
    for (const [id, until] of Object.entries(cool)) if (until <= n) delete cool[id];
    d.cool = cool; d.coolIdle = idle;
    save(ai, d);
    return used;
  }

  // 问一下心里：只回档位，不回任何内容
  function mood(ai, about = '') {
    const ws = boats(load(ai));
    return {
      lv: water(ws),
      near: !!about && ws.some((m) => (m.lv || 0) >= 2 && sim(about, m.text) >= 0.15),
      fresh: ws.filter((m) => m.lv === 3 && !m.knocked).length,
    };
  }
  function markKnocked(ai) {
    const d = load(ai);
    let n = 0;
    for (const m of live(d)) if (kindOf(m) === 'wish' && m.lv === 3 && !m.knocked) { m.knocked = now(); n++; }
    if (n) save(ai, d);
    return n;
  }
  function readLog(ai, limit = 200) {
    const f = path.join(folder(ai), 'log.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l));
  }
  // 导出：不带密码、不带私人念想、不带归档的、不带对话原文。交接单独一项，不混进 items
  function exportAll(ai) {
    const d = load(ai);
    const { lastNight, ...cfg } = d.cfg; // 夜里的结果摘要不导
    return { v: 1, ai, t: now(), cfg, items: live(d).filter((m) => !m.priv), dreams: d.dreams.filter((x) => !x.priv), handoff: d.handoff || null };
  }
  function importAll(ai, data) {
    const d = load(ai);
    const have = new Set(d.items.map((m) => m.id)); // 归档的也算，跟它编号一样的不导
    const added = [];
    for (const m of data?.items || []) {
      if (!m || typeof m !== 'object' || !m.id || typeof m.text !== 'string' || !m.text.trim() || have.has(String(m.id)) || !KINDS.includes(kindOf(m))) continue;
      const x = { ...m, id: String(m.id), priv: false };
      normItem(x); // 格式不对的整理掉（from/kw/ppl 包成数组、坏线索去掉）
      if (!(Number(x.gone) > 0)) delete x.gone; // 归档的标记留着：从别处搬来的归档记忆，进来还是归档
      d.items.push(x);
      have.add(x.id);
      added.push(x);
    }
    const n = added.length;
    save(ai, d);
    for (const m of added) vec?.want(ai, m);
    logOp(ai, { who: 'me', op: 'import', n });
    return { added: n };
  }

  // ---- 写 ----
  // sid：TA 记的时候是哪一场聊天（开场交接里「上一场记了这几条」靠它）
  function add(ai, input, who = 'me', { sid } = {}) {
    const d = load(ai);
    const kind = input.kind || 'note';
    if (!KINDS.includes(kind)) throw fail(400, '没有这种记忆：' + kind);
    if (!String(input.text || '').trim()) throw fail(400, '内容是空的');
    if (who === 'me' && OWN.includes(kind)) throw fail(403, '这一种只有 TA 自己能写');
    const m = { id: newId(who === 'me' ? 'm' : 'k'), t: now(), by: who, kind, ...pick(input, FIELDS) };
    normItem(m);
    if (who === 'ai' && sid) m.sid = String(sid);
    m.text = String(m.text).trim();
    if (kind === 'note' && who === 'ai' && d.cfg.hill === true && d.sess?.tone && now() - (d.sess.lastT || 0) < HILL.toneMs) m.tone = d.sess.tone;
    if (kind !== 'wish') delete m.priv;
    if (kind === 'habit') { m.every = String(m.every || '').trim().slice(0, 40) || '常常'; if (m.st !== 'off') m.st = 'on'; } else delete m.every;
    if (kind === 'wish') {
      const leaf = input.lv === 0; // 落叶：第一次冒出来的念头，不占「一天两条」
      const today = dayOf(now());
      const n = live(d).filter((x) => kindOf(x) === 'wish' && !x.leaf && dayOf(x.t) === today).length;
      if (!leaf && n >= guards(d).newWishPerDay) throw fail(429, `今天已经新记了 ${n} 条念想`);
      if (m.priv && d.cfg.priv === false) m.priv = false; // 私人那块的总开关关着
      Object.assign(m, { lv: leaf ? 0 : 1, leaf, hits: 0, last: null, days: [], done: false, priv: !!m.priv });
    }
    d.items.push(m);
    save(ai, d);
    logOp(ai, { who, op: 'add', id: m.id, kind });
    vec?.want(ai, m); // 后台补向量，不等
    return m;
  }

  function patch(ai, id, input, { who = 'me', token } = {}) {
    const d = load(ai);
    const m = find(d, id);
    const kind = kindOf(m);
    let keys;
    if (who === 'me') {
      if (m.priv) throw fail(403, '私人的念想只有 TA 能动');
      needUnlock(ai, d, token);
      keys = OWN.includes(kind) ? ['pin'] : WEB_EDIT; // TA 的四种，她只能设不设固有
      const bad = Object.keys(input).filter((k) => !keys.includes(k));
      if (bad.length) throw fail(403, OWN.includes(kind) ? '这一条是 TA 自己的，只能删、不能改' : '这几项改不了：' + bad.join('、'));
    } else keys = FIELDS;
    const ch = pick(input, keys);
    if (ch.text !== undefined) {
      ch.text = String(ch.text).trim();
      if (!ch.text) throw fail(400, '内容是空的');
      if ((kind === 'view' || isHill(m)) && ch.text !== m.text) (m.hist ||= []).push({ t: m.t2 || m.t, text: m.text, why: m.why || '', ...(kind === 'view' ? {} : { who }) }); // 山改正过的旧字也留着
    }
    if (ch.priv !== undefined && kind !== 'wish') delete ch.priv;
    if (ch.every !== undefined) { if (kind === 'habit') ch.every = String(ch.every || '').trim().slice(0, 40) || '常常'; else delete ch.every; }
    Object.assign(m, ch, { t2: now() });
    normItem(m);
    save(ai, d);
    logOp(ai, { who, op: 'edit', id, kind, keys: Object.keys(ch) });
    if (['text', 'why', 'priv'].some((k) => k in ch)) vec?.want(ai, m); // 变成私人的会把旧向量删掉
    return m;
  }

  // 她（网页）动一条之前：私人念想动不了，锁着要开锁
  function guard(ai, d, m, who, token) {
    if (who !== 'me') return;
    if (m.priv) throw fail(403, '私人的念想只有 TA 能动');
    needUnlock(ai, d, token);
  }
  // 私人念想的编号也不进流水（跟 lv 那条一样）
  const logId = (m) => (m.priv ? undefined : m.id);

  // 删 = 归档：记录留着、加 gone，别处一律当它不存在；连线和向量都留着，恢复后照旧
  function remove(ai, id, { who = 'me', token } = {}) {
    const d = load(ai);
    const m = find(d, id);
    guard(ai, d, m, who, token);
    if (who === 'ai' && m.by !== 'ai') throw fail(403, '她写的记事和约定你不能归档'); // TA 只能收自己记的
    if (isHill(m)) throw fail(403, '这一条已经是岛上的山了，不能归档；记错了可以改正文字');
    m.gone = now();
    save(ai, d);
    logOp(ai, { who, op: 'gone', id: logId(m), kind: kindOf(m) }); // 带编号和种类，不带正文
    return { ok: true, gone: m.gone };
  }
  // 恢复：去掉 gone。念想恢复不占「一天新记两条」
  function restore(ai, id, { who = 'me', token } = {}) {
    const d = load(ai);
    const m = find(d, id, { gone: true });
    if (!m.gone) throw fail(400, '这一条没有归档');
    guard(ai, d, m, who, token);
    delete m.gone;
    save(ai, d);
    logOp(ai, { who, op: 'restore', id: logId(m), kind: kindOf(m) });
    vec?.want(ai, m);
    return m;
  }
  // 彻底删：只能删已经归档的，锁着要开锁。这时才把别的记录连过来的线摘掉、向量删掉
  function purge(ai, id, { who = 'me', token } = {}) {
    const d = load(ai);
    const m = find(d, id, { gone: true });
    if (!m.gone) throw fail(400, '先归档，才能彻底删');
    guard(ai, d, m, who, token);
    d.items = d.items.filter((x) => x !== m);
    for (const x of d.items) if (x.from?.includes(id)) x.from = x.from.filter((f) => f !== id);
    save(ai, d);
    vec?.drop(ai, id);
    logOp(ai, { who, op: 'purge', kind: kindOf(m) }); // 彻底删的不留内容，连编号也不留
    return { ok: true };
  }

  // ---- 念想：只有 TA 能动，网关只守护栏 ----
  function wish(d, id) {
    const m = find(d, id);
    if (kindOf(m) !== 'wish') throw fail(400, '这一条不是念想');
    if (m.done) throw fail(400, '这条念想已经了了');
    return m;
  }
  // 想起一次。sid 是这一场聊天的编号：同一场最多算一次
  function hit(ai, id, sid) {
    const d = load(ai);
    const m = wish(d, id);
    if (sid && m.lastSid === sid) return m;
    const today = dayOf(now());
    m.hits = (m.hits || 0) + 1;
    m.last = now();
    m.lastSid = sid || null;
    if (!(m.days ||= []).includes(today)) m.days.push(today);
    delete m.asked;
    save(ai, d);
    return m;
  }
  function wishMove(ai, id, dir, why = '') {
    const d = load(ai);
    const m = wish(d, id);
    const g = guards(d), today = dayOf(now());
    const lv = m.lv || 0;
    if (dir === 'up') {
      if (lv >= 3) return m;
      if (m.upDay === today && (m.upN || 0) >= g.upPerDay) throw fail(429, '这一条今天已经升过了');
      if (lv === 2 && (m.days || []).length < g.holdDays) throw fail(429, `升到执念要在至少 ${g.holdDays} 个不同的日子想起过`);
      m.lv = lv + 1;
      m.leaf = false;
      m.upN = m.upDay === today ? m.upN + 1 : 1;
      m.upDay = today;
      if (m.lv === 3) delete m.knocked;
    } else if (dir === 'down') {
      if (lv <= 0) return m;
      m.lv = lv - 1;
    } else throw fail(400, 'lv 只能是 up 或 down');
    (m.trail ||= []).push({ t: now(), lv: m.lv, why: String(why).slice(0, 200) });
    delete m.asked;
    save(ai, d);
    logOp(ai, { who: 'ai', op: 'lv', id: m.priv ? undefined : id, lv: m.lv });
    return m;
  }

  // ---- 小山 ----
  // 后端那一份：照记下以后被想起的日子、连回来的条数、当时的语气重算，只升不降。改 d，不写盘（调用方写）
  function growHills(d, today) {
    const items = live(d), t = now();
    const back = new Map(); // id → 后来连回它的条数
    for (const x of items) for (const f of x.from || []) back.set(f, (back.get(f) || 0) + 1);
    for (const m of items) {
      if (kindOf(m) !== 'note') continue;
      const days = (m.udays || []).filter((x) => x !== dayOf(m.t || 0)).length;
      const sig = r1(HILL.wDays * Math.log2(1 + days) + HILL.wLinks * Math.log2(1 + (back.get(m.id) || 0)) + (m.tone ? HILL.wTone : 0));
      if (sig <= (m.hSig || 0)) continue;
      const was = isHill(m);
      m.hSig = sig;
      m.h = r1((m.hAi || 0) + sig);
      (m.hTrail ||= []).push({ t, by: 'sig', h: m.h, days, links: back.get(m.id) || 0, ...(m.tone ? { tone: true } : {}) });
      if (!was && isHill(m)) m.hAt = t; // 什么时候成山的
    }
    d.hillDay = today;
  }
  // 手动重算一次（夜里、测试用）
  function grow(ai) { const d = load(ai); if (d.cfg.hill !== true) return 0; growHills(d, dayOf(now())); save(ai, d); return live(d).filter(isHill).length; }
  // TA 那一份：这件事对我更重了。只有记事；同一条一天一次，一天一共最多 perDay 次
  // name：TA 给这座山起的短名（可选，最多 16 字；此刻页山头上浮出来的那句），不写就照旧
  function hillUp(ai, id, why = '', { name } = {}) {
    const d = load(ai), m = find(d, id), today = dayOf(now());
    if (d.cfg.hill !== true) throw fail(400, '小山没打开');
    if (kindOf(m) !== 'note') throw fail(400, '只有记事（发生过的事）能长成山');
    if (m.hUpDay === today) throw fail(429, '这一条今天已经抬过了');
    const n = live(d).filter((x) => x.hUpDay === today).length;
    if (n >= HILL.perDay) throw fail(429, `今天已经抬过 ${n} 座了`);
    hillLift(m, { by: 'ai', why, t: now() });
    m.hUpDay = today;
    if (typeof name === 'string' && name.trim()) m.hName = [...name.trim()].slice(0, 16).join('');
    save(ai, d);
    logOp(ai, { who: 'ai', op: 'hill', id, h: m.h });
    return m;
  }
  // 最高的几座（开场带）：固有的、了结的不算（固有的已经每次都带着）
  const hills = (ai, n = HILL.show) => { const d = load(ai); return d.cfg.hill !== true ? [] : live(d).filter((m) => isHill(m) && !m.pin && !m.done).sort((a, b) => b.h - a.h || (b.hAt || 0) - (a.hAt || 0)).slice(0, n); };

  function getCfg(ai) {
    const d = load(ai);
    return { priv: d.cfg.priv !== false, guards: guards(d), leafDays: d.cfg.leafDays ?? CFG.leafDays,
      talk: d.cfg.talk ?? CFG.talk, talkRounds: d.cfg.talkRounds ?? CFG.talkRounds, digestIdle: d.cfg.digestIdle ?? CFG.digestIdle,
      persona: d.cfg.persona === true, hill: d.cfg.hill === true, pinMax: d.cfg.pinMax ?? NIGHT_CFG.pinMax, nightAsk: d.cfg.nightAsk ?? NIGHT_CFG.nightAsk };
  }
  const intIn = (v, lo, hi, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw fail(400, `${what}要是 ${lo} 到 ${hi} 的整数`);
    return n;
  };
  function setCfg(ai, input) {
    const d = load(ai);
    const leafDays = input.leafDays !== undefined ? intIn(input.leafDays, 1, 365, '落叶沉下去的天数') : undefined;
    const talkRounds = input.talkRounds !== undefined ? intIn(input.talkRounds, 1, 10, '交接带的来回数') : undefined;
    const pinMax = input.pinMax !== undefined ? intIn(input.pinMax, 100, 50000, '固有记忆的字数上限') : undefined;
    const nightAsk = input.nightAsk !== undefined ? intIn(input.nightAsk, 0, 10, '开场带的夜里问话数') : undefined;
    const digestIdle = input.digestIdle !== undefined ? intIn(input.digestIdle, 0, 1440, '散场记要等的分钟数') : undefined;
    if (input.priv !== undefined) d.cfg.priv = !!input.priv;
    if (input.hill !== undefined) d.cfg.hill = !!input.hill; // 小山（默认关，在设置里给哪个 AI 开）
    if (input.guards) d.cfg.guards = { ...guards(d), ...pick(input.guards, Object.keys(GUARDS)) };
    if (leafDays !== undefined) d.cfg.leafDays = leafDays;
    if (talkRounds !== undefined) d.cfg.talkRounds = talkRounds;
    if (input.talk !== undefined) d.cfg.talk = !!input.talk;
    if (pinMax !== undefined) d.cfg.pinMax = pinMax;
    if (nightAsk !== undefined) d.cfg.nightAsk = nightAsk;
    if (digestIdle !== undefined) d.cfg.digestIdle = digestIdle;
    save(ai, d);
    if (d.cfg.talk === false) talk?.wipe(ai); // 关掉对话原文：已经留的也删掉
    return getCfg(ai);
  }

  // 夜里留给醒着的 TA 的：问话和「昨晚整理了 / 做了个梦」那两行。开场取一次就清掉
  function takeNight(ai) {
    const d = load(ai);
    const ask = d.nightAsk || [], news = d.nightNews || {};
    if (!ask.length && !Object.keys(news).length) return { ask: [], news: {} };
    delete d.nightAsk;
    delete d.nightNews;
    save(ai, d);
    return { ask, news };
  }

  return { list, recall, recallAsync, links, read, liveItems, rc, mood, markKnocked, readLog, exportAll, importAll, add, patch, remove, restore, purge, hit, wishMove,
    grow, hillUp, hills,
    unlock, setLock, lockPass, getCfg, setCfg, load, save, flush, dayOf, surface, sweep, floatUp, floating, setHandoff, getHandoff,
    setState, getState, tick, lastRecalled, markUsed, cooling, coolAfter, setCues, prepCalls, takeCall, now, talk, takeNight,
    // 给人格、夜里用：开锁检查、记流水、补向量
    checkUnlock: (ai, token) => needUnlock(ai, load(ai), token), log: logOp, vecWant: (ai, m) => vec?.want(ai, m), folder };
}
