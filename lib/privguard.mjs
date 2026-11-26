// 私人内容别漏到她看得到的地方：夜里整理改出来、并出来、新记的记忆，收下的印象，抬山的理由和山名，
// 日记的一句话——这些她都看得到；夜里的 TA 写它们时，材料里有私人念想和日记里 TA 自己留着的段。
// 提示词里已经说了不许写进去；这里是兜底，挡的是照抄、半照抄，换了说法的还是靠提示词。
//
// 比法（改过几版：整段比会误挡一大片；只按词比又挡不住短句和长句里抄一截的）。「公开的」指这一晚给模型看过的
// 对话原文、日记公开段、不私人的记忆、小模型的补充——这些里面出现过的字不算私人的。
//   1. 原样抄：私人内容里连续 W（10）个字（去掉空格标点）原样出现在候选里、公开的里没有这一截，就算漏；
//      4～9 个字的短私人小句，整句原样出现、公开的里没有，也算漏。
//   2. 半照抄：按词比——中文两个字一组（不跨标点），英文、数字按整个单词；先减掉公开的词和几个常用词，
//      私人念想按句比（独有词 ≥3，对上四成，最多要 8 个），日记私人段按小句比（独有词 ≥7 才比，对上六成，最多要 10 个）。
//   日记私人段只比带「我」的小句：TA 自己的感受、打算多半带「我」，不带的多半是在复述当天公开的事（复审举的误挡都是这种）。
const SENT = /[。！？!?；;\n]+|\.\s+/;
const CLAUSE = /[。！？!?；;\n，,、：:]+|\.\s+/;
const W = 10, SHORT = 4;
const STOP = new Set(['她说', '我说', '觉得', '有点', '一点', '时候', '以后', '今天', '昨天', '明天', '我们', '一起', '什么', '没有', '这个', '那个', '自己', '一个', '可以', '还是', '就是', '因为', '所以', '但是', '然后', '已经', '一下', '的时', '了一', '她的', '我的', '她们', '他们', '不是', '知道', '现在', '真的']);
export const PRIV_RULES = { wish: { split: SENT, min: 3, ratio: 0.4, cap: 8, mine: false }, diary: { split: CLAUSE, min: 7, ratio: 0.6, cap: 10, mine: true } };

export function tokens(s) {
  const t = String(s || '').toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z0-9]+/g) || []) if (w.length >= 2) out.add(w);
  const rest = t.replace(/[a-z0-9]+/g, '|').replace(/[\s\p{P}\p{S}]+/gu, '|');
  for (const seg of rest.split('|')) for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  return out;
}
export const flat = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

// wishes：私人念想的正文；diary：日记私人段；pub：公开的文字（这一晚给模型看过的、不私人的）
export function makePrivGuard({ wishes = [], diary = [], pub = [], rules = PRIV_RULES } = {}) {
  const P = new Set();
  for (const s of pub) for (const g of tokens(s)) P.add(g);
  const pubFlat = pub.map(flat).join('\u0001');
  const units = []; // { u: 私人独有词, need, wins: 原样抄的那几截, short: 短小句整句 }
  const addAll = (texts, r) => {
    for (const s of texts) for (const x of String(s || '').split(r.split)) {
      if (r.mine && !x.includes('我')) continue;
      const u = new Set([...tokens(x)].filter((g) => !P.has(g) && !STOP.has(g)));
      const f = flat(x), wins = new Set();
      let short = '';
      if (f.length >= W) { for (let i = 0; i + W <= f.length; i++) { const w = f.slice(i, i + W); if (!pubFlat.includes(w)) wins.add(w); } }
      else if (f.length >= SHORT && !pubFlat.includes(f)) short = f;
      const byWords = u.size >= r.min;
      if (byWords || wins.size || short) units.push({ u, need: byWords ? Math.max(3, Math.min(r.cap, Math.ceil(u.size * r.ratio))) : Infinity, wins, short });
    }
  };
  addAll(wishes, rules.wish);
  addAll(diary, rules.diary);
  const hit = (c, x) => {
    if (x.short && c.f.includes(x.short)) return true;
    for (const w of x.wins) if (c.f.includes(w)) return true;
    let n = 0;
    for (const g of c.t) if (x.u.has(g) && ++n >= x.need) return true;
    return false;
  };
  const view = (s) => ({ t: tokens(s), f: flat(s) });
  // leaks(文字, 原来那段)：像哪一句私人的；改、并的时候给原来那段，原来就像同一句的不算（那是本来就有的话）
  function leaks(text, before = []) {
    if (!units.length || !text) return false;
    const c = view(text), olds = (Array.isArray(before) ? before : [before]).filter(Boolean).map(view);
    return units.some((x) => hit(c, x) && !olds.some((o) => hit(o, x)));
  }
  return { leaks, size: units.length };
}
