// 记忆小模型：夜里在临时的 TA 整理记忆之前，先把材料过一遍，整理出一段「补充」递过去。
// 思路照 claude.ai 旧版记忆的「每日摘要」（support.claude.com 11817273 里 legacy 那一节），但它只出草稿和标签，
// 不往记忆库里写记忆、不改正文：拿主意的照旧是夜里的 TA。四件活各自 try 着，哪件出错就少那一块，整段出错就不带补充。
// 设置存在 mem.json 的 memModel 一项：{ on, url, model, keyEnv, talk }，前四样跟旁听的小模型一样（lib/helper.mjs 的 makeSlotGuard）；
// talk：要不要把最近 24 小时的对话原文也给它（找「可能漏记的」），比只给记忆敏感，默认关。
// 私人念想一律不给它，也不能当印象的依据。
import { fail } from './store.mjs';
import { makeSlotGuard, fullUrl } from './helper.mjs';
import { keyFor } from './svc.mjs';

export const MEMMODEL = { on: false, url: '', model: '', keyEnv: '', talk: false };
// sameMin：挑「可能是同一件事」的候选时字面门槛放低一点（召回是 0.08），后面还有它复核
export const MM_LIMITS = { sameMin: 0.05, tagBatch: 20, tagMax: 60, same: 8, sameOld: 3, missed: 5, follow: 5, base: 15000, talk: 20000 };
const IMP_KEYS = ['她是谁', '她在意的', '我们之间', '最近在发生的'];
const DAY = 864e5;
const len = (s) => [...String(s || '')].length;
const cut = (s, n) => [...String(s ?? '').trim()].slice(0, n).join('');
const kindOf = (m) => m.kind || 'note';
const hidden = (m) => m.gone || (kindOf(m) === 'wish' && m.priv); // 不给小模型看的

// ---- 指令（以后要改就改这几段）----
const HEAD = `你在帮一个陪伴型 AI（下面叫 TA）整理记忆。「她」是跟 TA 聊天的人。你只做下面说的这一件事，只回 JSON，不回别的话。
规矩：
- 只根据给你的原文。没写的不补，不猜原因，不评价她。
- 引用她的话照抄，不改写。
- 日期照原文给的，不推算。
- 拿不准就不写，或者写 "sure": false。
`;
export const MM_PROMPTS = {
  tag: HEAD + `
这一件事：给每条记忆标三样。
- emo：这件事她的情绪有多重。0 平常，1 有点，2 明显（哭、吵、特别开心），3 很重。只看原文写了什么，原文没写情绪就是 0。
- follow：这件事后面有没有下文要等。有的话写 {"what": "等什么（20 字以内）", "day": "YYYY-MM-DD 或 null"}；没有就写 null。日子只在原文写了具体哪天才填，不推算。
- ppl：涉及到的人（不含她自己），用原文里的叫法；没有就写 []。
回：[{"id": "…", "emo": 0, "follow": null, "ppl": []}]，每条记忆一项。

记忆（一行一条）：
`,
  same: HEAD + `
这一件事：判断「新的这条」跟每条「旧的」是不是同一件事——同一件事又发生了一次，或者是它的后续（同一个起因、同一个人、同一个处境）。只是话题像、提到同一个人，不算。
回：[{"old": "旧的编号", "same": true 或 false, "why": "一句话，30 字以内"}]，每条旧的一项。
`,
  missed: HEAD + `
这一件事：下面是最近一天她和 TA 的对话原文，和 TA 这段时间已经记下的记忆。找出原文里值得记、但记忆里还没有的事：她说的计划、她在意的事、新出现的人、情绪很重的时刻、她对 TA 的要求。
已经记了的、闲聊客套的不要。最多 5 处。每处照抄她的原话（60 字以内）。
回：[{"quote": "她的原话", "when": "原文里那一行的时间", "why": "为什么值得记，15 字以内"}]；没有就回 []。
`,
  impression: HEAD + `
这一件事：写一份「TA 对她的了解」，像一个熟悉她的人心里对她的印象，不是把记忆一条条抄一遍。分四块：她是谁、她在意的、我们之间、最近在发生的。每块最多 5 句。
- 每一句后面写依据的记忆编号，没有编号依据的句子不要写。
- 鼓励看出规律：两条以上的记忆指向同一件事时，合成一句说出规律（比如「她两次都是因为当众被批评难过，对这个很敏感」），依据写全那几条。只有一条依据的，照原文说事实，不往上推。
- 「最近在发生的」写还没了结、接下来要留意的事；已经过去、有了结果的写结果；过了日子还没听到结果的，写「还没听她说结果」。日期照原文写，不写「下周三」这种会过时的说法。
- 「我们之间」写她跟 TA 之间的约定、习惯、TA 该怎么对她。
- 每句不超过 40 字。
- 给了上一版的：没变的照抄；变了的、新加的写进 changed（照抄那一句）。
回：{"blocks": {"她是谁": [{"text": "…", "from": ["编号"]}], "她在意的": […], "我们之间": […], "最近在发生的": […]}, "changed": ["改了或新加的那几句"]}
`,
};

// 从回复里抠 JSON（数组或对象都行）：去掉 \`\`\` 包着的，先整段解析，不行再从第一个 [ 或 { 到最后一个 ] 或 }
export function looseJson(s) {
  const t = String(s || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();
  try { return JSON.parse(t); } catch { /* 往下试 */ }
  const i = t.search(/[[{]/), j = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch { return null; }
}

// 印象（小模型的草稿、夜里 TA 收下的都过这一道）：四块，每块最多 5 句，每句 60 字以内；
// 依据只认还在的、不是私人念想的编号，一句依据都不剩的整句扔掉。全扔光了回 null
export function cleanImpression(o, items) {
  const ok = new Set(items.filter((m) => !hidden(m)).map((m) => m.id));
  const src = o && typeof o === 'object' ? (o.blocks && typeof o.blocks === 'object' ? o.blocks : o) : null;
  if (!src) return null;
  const blocks = {};
  let n = 0;
  for (const k of IMP_KEYS) {
    const rows = (Array.isArray(src[k]) ? src[k] : []).map((x) => {
      const text = cut(x?.text, 60), from = [...new Set((Array.isArray(x?.from) ? x.from : []).map(String))].filter((id) => ok.has(id));
      return text && from.length ? { text, from } : null;
    }).filter(Boolean).slice(0, 5);
    blocks[k] = rows;
    n += rows.length;
  }
  return n ? blocks : null;
}

// runnerOf({ url, key, model, timeout, extra }) → runner({ system, prompt })：后端传 night.mjs 的 makeApiRunner，测试里换成假的
// guard：lib/helper.mjs 的 makeSlotGuard(…)，跟旁听的小模型同一套检查（地址过 net、Key 要管理员登记过能发到哪）
// svc：设置页「功能模型 → 记忆小模型」那一份（所有 AI 共用）。哪个 AI 没单独设地址就用它；开不开还是每个 AI 自己定。
// 页面那份的 Key 只发给存 Key 时的那个地址（svc.keyFor），地址发之前过 net 检查
export function makeMemModel({ store, tz, keyOf = () => '', runnerOf, log = () => {}, timeout = 120e3, limits = {}, guard = makeSlotGuard(), svc = null }) {
  const chatUrl = (u) => u.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';   // 页面填的地址带着 /v1
  const page = () => { try { const m = svc && svc.read().fm.memo; return m && m.url && m.model ? { url: chatUrl(m.url), model: m.model, key: keyFor(m, m.url) } : null; } catch { return null; } };
  const slotOf = (h) => (h.url ? { own: true } : page() ? { own: false, ...page() } : null);
  const L = { ...MM_LIMITS, ...limits };
  const raw = (ai) => ({ ...MEMMODEL, ...(store.load(ai).memModel || {}) });
  // 给网页看的：不带 url、keyEnv
  function get(ai) {
    const h = raw(ai);
    const sl = slotOf(h);
    return { on: h.on, model: sl && !sl.own ? sl.model : h.model, key: sl && !sl.own ? !!sl.key : !!h.keyEnv, src: sl ? (sl.own ? 'own' : 'page') : null, talk: h.talk, impression: store.load(ai).impression || null };
  }
  function set(ai, input = {}) {
    const h = guard.apply(raw(ai), input);
    if (input.talk !== undefined) { if (typeof input.talk !== 'boolean') throw fail(400, 'talk 只能是 true 或 false'); h.talk = input.talk; }
    if (h.on && !(h.url && h.model) && !page()) throw fail(400, '打开之前先在设置「功能模型 → 记忆小模型」填好地址和模型（或者单独设 url 和 model）');
    if (h.url && !h.model) throw fail(400, '单独设了地址就要填 model');
    const d = store.load(ai);
    d.memModel = h;
    store.save(ai, d);
    return get(ai);
  }
  const on = (ai) => { const h = raw(ai); return h.on === true && !!slotOf(h); };

  // ---- 夜里调：出那段补充。回 { text, stats }；没打开、没配好回 { text: '' } ----
  async function prepare(ai, { since } = {}) {
    const h = raw(ai);
    const sl = slotOf(h);
    if (!h.on || !sl) return { text: '' };
    let url, model, key;
    if (sl.own) {
      key = h.keyEnv ? keyOf(h.keyEnv) : '';
      if (h.keyEnv && !key) { log('记忆小模型', ai, '跳过：key 的环境变量是空的'); return { text: '' }; }
      try { await guard.before(h, '记忆小模型的地址'); } catch (e) { log('记忆小模型', ai, '跳过：', e.safe ? e.message : (e.code || e.name)); return { text: '' }; }
      url = fullUrl(h.url); model = h.model;
    } else {
      try { await guard.net.check(sl.url, '记忆小模型的地址'); } catch (e) { log('记忆小模型', ai, '跳过：', e.safe ? e.message : (e.code || e.name)); return { text: '' }; }
      url = sl.url; model = sl.model; key = sl.key;
    }
    // 小模型只做简单的活：关掉思考、温度放低（硅基、DeepSeek 认 enable_thinking；别家不认的一般会忽略）
    const run = runnerOf({ url, key, model, timeout, extra: { enable_thinking: false, temperature: 0.2 } });
    const ask = async (p) => looseJson(await run({ system: '', prompt: p }));
    const t = store.now(), from = since ?? t - DAY, today = store.dayOf(t);
    const items = store.load(ai).items.filter((m) => !hidden(m));
    const fresh = items.filter((m) => Math.max(m.t || 0, m.t2 || 0) > from);
    const line = (m) => JSON.stringify({ id: m.id, day: store.dayOf(m.t || 0), kind: kindOf(m), text: m.text });
    const parts = [], stats = {};
    const step = async (name, fn) => {
      try { const s = await fn(); if (s) parts.push(s); stats[name] = 'ok'; } catch (e) {
        stats[name] = 'fail';
        log('记忆小模型', ai, name, '没做成：', e.safe ? e.message : (e.code || e.name)); // 不带正文
      }
    };

    // ① 打标：没打过的、打过以后又改过的（最多 tagMax 条，新的先）。标签存进记忆（tag），不改正文、不算改动
    await step('tag', async () => {
      const need = items.filter((m) => !m.tag || (m.t2 || 0) > (m.tag.at || 0)).sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, L.tagMax);
      const got = new Map();
      for (let i = 0; i < need.length; i += L.tagBatch) {
        const out = await ask(MM_PROMPTS.tag + need.slice(i, i + L.tagBatch).map(line).join('\n'));
        for (const x of Array.isArray(out) ? out : []) {
          const id = String(x?.id ?? '');
          if (!need.some((m) => m.id === id)) continue;
          const emo = Number.isInteger(x.emo) && x.emo >= 0 && x.emo <= 3 ? x.emo : 0;
          const f = x.follow && typeof x.follow === 'object' && cut(x.follow.what, 40)
            ? { what: cut(x.follow.what, 40), day: /^\d{4}-\d{2}-\d{2}$/.test(String(x.follow.day)) ? String(x.follow.day) : null } : null;
          const ppl = (Array.isArray(x.ppl) ? x.ppl : []).filter((p) => typeof p === 'string').map((p) => cut(p, 20)).filter(Boolean).slice(0, 10);
          got.set(id, { emo, follow: f, ppl, at: t });
        }
      }
      if (got.size) { // 跑模型这段时间 TA 可能又记了东西：重新读一遍再写
        const d = store.load(ai);
        for (const m of d.items) if (got.has(m.id)) m.tag = got.get(m.id);
        store.save(ai, d);
      }
      const rows = fresh.filter((m) => got.has(m.id) || m.tag).map((m) => {
        const g = got.get(m.id) || m.tag;
        return `- [${m.id}] 情绪 ${g.emo}${g.follow ? `；有下文：${g.follow.what}${g.follow.day ? `（${g.follow.day}）` : ''}` : ''}${g.ppl.length ? `；涉及 ${g.ppl.join('、')}` : ''}`;
      });
      stats.tagged = got.size;
      return rows.length ? `### 今天新记的几条（情绪 0 平常到 3 很重）\n${rows.join('\n')}` : '';
    });

    // ② 可能是同一件事：新记的每条用召回（字面 + 向量，不记「被用到」、不带私人的）挑几条旧的，再请它复核
    await step('same', async () => {
      const rows = [], freshIds = new Set(fresh.map((m) => m.id));
      for (const m of fresh.slice(-L.same)) {
        const olds = (await store.recallAsync(ai, m.text, L.sameOld + 3, { who: 'me', min: L.sameMin })).filter((x) => !freshIds.has(x.id) && !hidden(x)).slice(0, L.sameOld);
        if (!olds.length) continue;
        const out = await ask(MM_PROMPTS.same + `\n新的：\n${line(m)}\n旧的：\n${olds.map(line).join('\n')}`);
        for (const x of Array.isArray(out) ? out : []) {
          const o = olds.find((y) => y.id === String(x?.old ?? ''));
          if (o && x.same === true) rows.push(`- [${m.id}]（${store.dayOf(m.t)}）↔ [${o.id}]（${store.dayOf(o.t)}）：${cut(x.why, 40)}`);
        }
      }
      return rows.length ? `### 可能是同一件事（续不续上由你定）\n${rows.join('\n')}` : '';
    });

    // ③ 原文里可能漏记的（要 talk 打开、对话原文开着）
    if (h.talk && store.talk && store.getCfg(ai).talk) await step('missed', async () => {
      const rs = store.talk.recent(ai, { since: from });
      if (!rs.length) return '';
      const hm = (x) => new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(x));
      let budget = L.talk;
      const lines = [];
      for (const r of [...rs].reverse()) { const s = `${hm(r.t)} ${r.role === 'me' ? '她' : 'TA'}：${r.text}`; if (budget - len(s) < 0) break; budget -= len(s) + 1; lines.unshift(s); }
      const out = await ask(MM_PROMPTS.missed + `\n对话原文：\n${lines.join('\n')}\n\n已经记下的：\n${fresh.map(line).join('\n') || '（没有）'}`);
      const rows = (Array.isArray(out) ? out : []).map((x) => cut(x?.quote, 80) && `- ${cut(x.when, 5)} 她说：「${cut(x.quote, 80)}」——${cut(x.why, 20)}`).filter(Boolean).slice(0, L.missed);
      return rows.length ? `### 原文里可能漏记的（记不记由你定）\n${rows.join('\n')}` : '';
    });

    // ④ 到日子了的：标签里有下文、日子到了（不用模型）
    await step('follow', async () => {
      const d = store.load(ai);
      const rows = d.items.filter((m) => !hidden(m) && !m.done && m.tag?.follow?.day && m.tag.follow.day <= today)
        .sort((a, b) => (a.tag.follow.day < b.tag.follow.day ? 1 : -1)).slice(0, L.follow)
        .map((m) => `- [${m.id}] ${m.tag.follow.what}（${m.tag.follow.day}）：日子到了，看看有没有听她说结果`);
      return rows.length ? `### 到日子的事\n${rows.join('\n')}` : '';
    });

    // ⑤ 印象草稿：固有的先，再按用到的多少、新旧，凑够 base 字数；带上一版
    await step('impression', async () => {
      const d = store.load(ai);
      const pool = d.items.filter((m) => !hidden(m)).sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || (b.used || 0) - (a.used || 0) || (b.t || 0) - (a.t || 0));
      let budget = L.base;
      const rows = [];
      for (const m of pool) { const s = line(m); if (budget - len(s) < 0) break; budget -= len(s) + 1; rows.push(s); }
      if (!rows.length) return '';
      const prev = d.impression?.blocks;
      const out = await ask(MM_PROMPTS.impression + (prev ? `\n上一版：\n${JSON.stringify(prev)}\n` : '\n这是第一版，没有上一版。\n') + `\n记忆（一行一条）：\n${rows.join('\n')}`);
      const blocks = cleanImpression(out, d.items);
      if (!blocks) return '';
      const changed = (Array.isArray(out?.changed) ? out.changed : []).map((x) => cut(x, 60)).filter(Boolean).slice(0, 10);
      const txt = IMP_KEYS.map((k) => `【${k}】\n` + (blocks[k].map((x) => `- ${x.text}（${x.from.join('、')}）`).join('\n') || '（没有）')).join('\n');
      return `### 印象草稿（觉得对就照抄或改了放进 impression；不想要就不写那一项）\n${txt}${prev && changed.length ? `\n跟上一版比，改了或新加的：${changed.join('；')}` : ''}`;
    });

    log('记忆小模型', ai, '补充：', Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' ')); // 只记数，不带正文
    return { text: parts.join('\n\n'), stats };
  }

  return { get, set, on, prepare, clean: cleanImpression };
}
