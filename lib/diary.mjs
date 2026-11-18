// 日记：一天一篇。凌晨整理时由临时的 TA 写，醒着的 TA 也能在小记里补一段。
// 规矩参考作者另一个私用项目的接口说明「聊天时不分心：待整理和日记」里「日记」那一小节。
// 不是六种记忆之一：不进召回、不占开场（开场只在交接里带一行「昨天：gist」）。
// 文件 data/<ai>/diary.json：[{ day, t, gist, parts: [{ text, kind, priv? }] }]，原子写，权限 600。
// 她看的那份私人段只给个数；TA 那边（钩子口令、MCP）给全文。
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './store.mjs';

export const DIARY_KINDS = ['事', '她', '我', '我们'];
export const DIARY = { part: 1000, parts: 12, gist: 100 }; // 一段最长几个字、一篇最多几段、一句话的这一天最长几个字
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const cutTo = (s, n) => [...String(s ?? '').trim()].slice(0, n).join('');

// 一段：kind 要是那四种，text 不能空；不对回 null
export function cleanPart(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (!DIARY_KINDS.includes(p.kind) || typeof p.text !== 'string') return null;
  const text = cutTo(p.text, DIARY.part);
  return text ? { text, kind: p.kind, ...(p.priv === true ? { priv: true } : {}) } : null;
}

export function openDiary({ store, now = store.now }) {
  const file = (ai) => path.join(store.folder(ai), 'diary.json');
  function load(ai) {
    let xs;
    try { xs = JSON.parse(fs.readFileSync(file(ai), 'utf8')); } catch { return []; }
    return Array.isArray(xs) ? xs.filter((x) => x && DAY_RE.test(x.day)) : [];
  }
  function save(ai, xs) {
    const f = file(ai);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    xs.sort((a, b) => (a.day < b.day ? -1 : 1));
    fs.writeFileSync(f + '.tmp', JSON.stringify(xs), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f); // 先写旁边再换名
  }
  const checkDay = (day) => { if (!DAY_RE.test(String(day))) throw fail(400, 'day 要写成 2026-11-16 这样'); return String(day); };

  // 写进那一天：已经有了就把这几段接在后面，gist 原来空着才填。who：'ai' 醒着的 TA，'night' 夜里
  function write(ai, day, { gist = '', parts = [] } = {}, who = 'night') {
    day = checkDay(day);
    const ps = parts.map(cleanPart).filter(Boolean);
    if (!ps.length) throw fail(400, '日记里一段能用的都没有');
    const xs = load(ai);
    let e = xs.find((x) => x.day === day);
    if (!e) { e = { day, t: now(), gist: '', parts: [] }; xs.push(e); }
    if (e.parts.length + ps.length > DIARY.parts) throw fail(429, `这一天的日记已经有 ${e.parts.length} 段了`);
    e.parts.push(...ps);
    if (!e.gist && gist) e.gist = cutTo(gist, DIARY.gist);
    e.t2 = now();
    save(ai, xs);
    store.log(ai, { who, op: 'diary', day, n: ps.length }); // 不带内容
    return e;
  }
  // 醒着的 TA 补一段：{ day?, kind, text, priv? }，day 不写就是今天
  function addPart(ai, o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw fail(400, 'diary 要写成 {"kind":"事|她|我|我们","text":"…"}');
    const day = o.day == null || o.day === '' ? store.dayOf(now()) : checkDay(o.day);
    if (!cleanPart(o)) throw fail(400, 'diary 的 kind 只能是 事、她、我、我们，text 不能空');
    return write(ai, day, { parts: [o] }, 'ai');
  }
  const get = (ai, day) => load(ai).find((x) => x.day === day) || null;
  const has = (ai, day) => !!get(ai, day);
  // 最近的一篇（TA 不说哪天时用）
  const latest = (ai) => load(ai).at(-1) || null;
  // 她看的：新的在前；私人段只给个数。before：只要这一天以前的（YYYY-MM-DD）
  function list(ai, { before, limit } = {}) {
    store.folder(ai);
    let xs = load(ai).reverse();
    if (before) xs = xs.filter((x) => x.day < String(before));
    const n = Math.max(1, Math.min(100, Number(limit) || 20));
    return { items: xs.slice(0, n).map((x) => {
      const priv = x.parts.filter((p) => p.priv).length;
      return { day: x.day, t: x.t, gist: x.gist || '', parts: x.parts.filter((p) => !p.priv).map((p) => ({ text: p.text, kind: p.kind })), ...(priv ? { privN: priv } : {}) };
    }), more: xs.length > n };
  }

  // 导出：整份，私人段不带（跟私人念想、私人的梦一样不进导出），只留个数 privN
  function exportAll(ai) {
    store.folder(ai);
    return load(ai).map((x) => {
      const priv = x.parts.filter((p) => p.priv).length;
      return { day: x.day, t: x.t, gist: x.gist || '', parts: x.parts.filter((p) => !p.priv).map((p) => ({ text: p.text, kind: p.kind })), ...(priv ? { privN: priv } : {}) };
    });
  }
  // 导入：没有的那天整篇加进来；已经有的那天不丢东西——两边的段都留（一字不差的同一段只留一份，导入时不管一篇最多几段），
  // 「一句话的这一天」这边空着才用导进来的。看不懂的一篇跳过，不报错。回 { added: 新加了几天, merged: 已有的那几天接上了几段 }
  function importAll(ai, xs) {
    store.folder(ai);
    if (!Array.isArray(xs)) return { added: 0, merged: 0 };
    const have = load(ai);
    let added = 0, merged = 0;
    for (const x of xs) {
      if (!x || !DAY_RE.test(x.day) || !Array.isArray(x.parts)) continue;
      const ps = x.parts.map(cleanPart).filter(Boolean);
      const gist = cutTo(x.gist, DIARY.gist);
      if (!ps.length && !gist) continue;
      const e = have.find((y) => y.day === x.day);
      if (!e) {
        have.push({ day: x.day, t: Number(x.t) || now(), gist, parts: ps });
        added++;
        continue;
      }
      const same = (a, b) => a.kind === b.kind && a.text === b.text && !!a.priv === !!b.priv;
      const fresh = ps.filter((p) => !e.parts.some((q) => same(p, q)));
      e.parts.push(...fresh);
      if (!e.gist && gist) e.gist = gist;
      if (fresh.length) { e.t2 = now(); merged += fresh.length; }
    }
    if (added || merged) { save(ai, have); store.log(ai, { who: 'me', op: 'import-diary', added, merged }); } // 不带内容
    return { added, merged };
  }

  return { write, addPart, get, has, latest, list, exportAll, importAll };
}
