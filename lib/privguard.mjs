// 私人内容别漏到她看得到的地方：夜里整理改出来、并出来、新记的记忆，收下的印象，抬山的理由和山名，
// 日记的一句话——这些她都看得到；夜里的 TA 写它们时，材料里有私人念想和日记里 TA 自己留着的段。
// 提示词里已经说了不许写进去；这里是兜底，挡的是照抄、半照抄，换了说法的还是靠提示词。
//
// 比法（以前整段拿 mentioned 比，私人段一长，常用词就凑够了，不相干的也被挡）：
//   1. 先减掉「公开的」词：当晚的对话原文、日记公开段、不私人的记忆里出现过的，都不算私人的；
//   2. 私人念想（短、具体）：按句比，候选里出现了这句私人独有词的四成以上（至少 3 个）就算漏；
//   3. 日记私人段（长，常先复述当天的事再写自己的感受）：按小句（逗号也切）比，私人独有词不到 7 个的小句不比
//      （多半是在复述公开的事），要六成以上对上才算漏。
// 词：中文两个字一组（不跨标点），英文、数字按整个单词算（python 不再拆成 5 组）。
const SENT = /[。！？!?；;\n]+/;
const CLAUSE = /[。！？!?；;\n，,、：:]+/;
const STOP = new Set(['她说', '我说', '觉得', '有点', '一点', '时候', '以后', '今天', '昨天', '明天', '我们', '一起', '什么', '没有', '这个', '那个', '自己', '一个', '可以', '还是', '就是', '因为', '所以', '但是', '然后', '已经', '一下', '的时', '了一', '她的', '我的', '她们', '他们', '不是', '知道', '现在', '真的']);
export const PRIV_RULES = { wish: { split: SENT, min: 3, ratio: 0.4 }, diary: { split: CLAUSE, min: 7, ratio: 0.6 } };

export function tokens(s) {
  const t = String(s || '').toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z0-9]+/g) || []) if (w.length >= 2) out.add(w);
  const rest = t.replace(/[a-z0-9]+/g, '|').replace(/[\s\p{P}\p{S}]+/gu, '|');
  for (const seg of rest.split('|')) for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  return out;
}

// wishes：私人念想的正文；diary：日记私人段；pub：公开的文字（对话原文、日记公开段、不私人的记忆）
export function makePrivGuard({ wishes = [], diary = [], pub = [], rules = PRIV_RULES } = {}) {
  const P = new Set();
  for (const s of pub) for (const g of tokens(s)) P.add(g);
  const sents = []; // { u: 私人独有词, need: 要对上几个 }
  const addAll = (texts, r) => {
    for (const s of texts) for (const x of String(s || '').split(r.split)) {
      const u = new Set([...tokens(x)].filter((g) => !P.has(g) && !STOP.has(g)));
      if (u.size >= r.min) sents.push({ u, need: Math.max(3, Math.ceil(u.size * r.ratio)) });
    }
  };
  addAll(wishes, rules.wish);
  addAll(diary, rules.diary);
  const hit = (cand, x) => { let n = 0; for (const g of cand) if (x.u.has(g) && ++n >= x.need) return true; return false; };
  // leaks(文字, 原来那段)：像哪一句私人的；改、并的时候给原来那段，原来就像同一句的不算（那是本来就有的话）
  function leaks(text, before = []) {
    if (!sents.length || !text) return false;
    const c = tokens(text), olds = (Array.isArray(before) ? before : [before]).filter(Boolean).map(tokens);
    return sents.some((x) => hit(c, x) && !olds.some((o) => hit(o, x)));
  }
  return { leaks, size: sents.length };
}
