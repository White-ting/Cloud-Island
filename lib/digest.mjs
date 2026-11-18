// 待整理：TA 白天攒的素材（散场记时写的，或者旁听的小模型写的），凌晨写日记时用。
// 规矩参考作者另一个私用项目的接口说明「聊天时不分心：待整理和日记」里「待整理」那一小节。
// 不是记忆：不进记忆列表、搜索、召回，不带给聊天中的 TA。
// 网页上看得到正文（TA 有时写错）：不改 TA 的原话，在那条下面加一句更正（fix），能再改、能删；
// 也能把一条收走（gone，不真删）。加更正、收走设了记忆锁要开锁，跟改记忆一样。夜里写日记时原文和更正一起带上，以她的为准。
// 导出（整库备份）里单独一项 digest，带正文和更正：导出的文件本来就在她手里（data 文件夹她也拿得到），备份不带正文就恢复不了。
// 文件 data/<ai>/digest.json：[{ id, t, day, text, sid, by: 'ai' | 'helper', why?, fix?: { text, t }, done?, gone? }]，原子写，权限 600。
// why：哪个散场记时机写的（idle | compact | end），聊天当中顺手写的没有。
// 写成日记以后标 done（记下 done 的时间），再留 30 天清掉；她收走的（gone）同样留 30 天，这期间哪儿都当它不存在。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './store.mjs';

export const DIGEST = { max: 1500, fix: 500, keep: 30 * 864e5 }; // 一条最长几个字；更正最长几个字；done / gone 以后留多久
const BY = ['ai', 'helper'];
const WHY = ['idle', 'compact', 'end'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const cut = (s, n) => [...s.trim()].slice(0, n).join('');

export function openDigest({ store, now = store.now }) {
  const file = (ai) => path.join(store.folder(ai), 'digest.json');
  // 读：done、gone 满 30 天的当作没有（下次写的时候真清掉）；坏文件当空的
  function load(ai) {
    let xs;
    try { xs = JSON.parse(fs.readFileSync(file(ai), 'utf8')); } catch { return []; }
    if (!Array.isArray(xs)) return [];
    const c = now() - DIGEST.keep;
    return xs.filter((x) => x && x.id && !(x.done && x.done < c) && !(x.gone && x.gone < c));
  }
  function save(ai, xs) {
    const f = file(ai);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(xs), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f); // 先写旁边再换名
  }

  // 存一条。day 由后端按设置的时区定；超过 1500 字截掉
  function add(ai, { text, sid, by = 'ai', why } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw fail(400, '待整理要写成一段话');
    if (!BY.includes(by)) throw fail(400, 'by 只能是 ai 或 helper');
    const xs = load(ai), t = now();
    const x = { id: 'g' + t.toString(36) + crypto.randomBytes(2).toString('hex'), t, day: store.dayOf(t),
      text: cut(text, DIGEST.max), sid: sid ? String(sid) : null, by, ...(WHY.includes(why) ? { why } : {}) };
    xs.push(x);
    save(ai, xs);
    store.log(ai, { who: by, op: 'digest' }); // 不带内容
    return x;
  }
  // 还没写成日记、也没被她收走的。from / to：只要这几天的（含 from、不含 to，都是 YYYY-MM-DD）
  function pending(ai, { from, to, day } = {}) {
    return load(ai).filter((x) => !x.done && !x.gone && (!day || x.day === day) && (!from || x.day >= from) && (!to || x.day < to));
  }
  // 每天几条
  function days(ai) {
    store.folder(ai);
    const n = new Map();
    for (const x of pending(ai)) n.set(x.day, (n.get(x.day) || 0) + 1);
    return { days: [...n].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, k]) => ({ day, n: k })) };
  }
  // 给网页的一条：不给会话编号
  const web = (x) => ({ id: x.id, t: x.t, day: x.day, by: x.by, ...(x.why ? { why: x.why } : {}), text: x.text, ...(x.fix ? { fix: x.fix } : {}) });
  // 给网页的：每天几条 + 每条正文（连她的更正）
  function list(ai) { return { ...days(ai), items: pending(ai).map(web) }; }

  // ---- 她（网页）动一条：只动还没写成日记、没收走的；锁着要开锁 ----
  function mine(ai, id, token) {
    store.folder(ai);
    const xs = load(ai), x = xs.find((y) => y.id === id && !y.done && !y.gone);
    if (!x) throw fail(404, '没有这条待整理（也许已经写成日记了）');
    store.checkUnlock(ai, token);
    return { xs, x };
  }
  // 加一句更正 / 改更正。TA 的原话不动
  function setFix(ai, id, text, token) {
    const { xs, x } = mine(ai, id, token);
    if (typeof text !== 'string' || !text.trim()) throw fail(400, '更正要写成一句话');
    x.fix = { text: cut(text, DIGEST.fix), t: now() };
    save(ai, xs);
    store.log(ai, { who: 'me', op: 'digest-fix', id }); // 不带内容
    return web(x);
  }
  // 删掉她的更正（没有更正也回这一条）
  function dropFix(ai, id, token) {
    const { xs, x } = mine(ai, id, token);
    if (x.fix) { delete x.fix; save(ai, xs); store.log(ai, { who: 'me', op: 'digest-unfix', id }); }
    return web(x);
  }
  // 收走 = 标 gone，不真删：夜里不写、TA 看不到、不导出，留 30 天再清掉
  function remove(ai, id, token) {
    const { xs, x } = mine(ai, id, token);
    x.gone = now();
    save(ai, xs);
    store.log(ai, { who: 'me', op: 'digest-gone', id });
    return { ok: true, gone: x.gone };
  }

  // 那一天写成日记了：那天还没 done 的都标上
  function markDone(ai, day) {
    const xs = load(ai), t = now();
    let k = 0;
    for (const x of xs) if (!x.done && !x.gone && x.day === day) { x.done = t; k++; }
    if (k) save(ai, xs);
    return k;
  }

  // 导出：全部（连 done 的，还在 30 天里的），带正文和更正；她收走的不带（跟归档的记忆一样当不存在）
  function exportAll(ai) { store.folder(ai); return load(ai).filter((x) => !x.gone); }
  // 导入：编号已经有的不导；看不懂的一条跳过，不报错；旧文件没有 why、fix 照样导。回导进来几条
  function importAll(ai, xs) {
    store.folder(ai);
    if (!Array.isArray(xs)) return { added: 0 };
    const have = load(ai), ids = new Set(have.map((x) => x.id)), c = now() - DIGEST.keep;
    let n = 0;
    for (const x of xs) {
      if (!x || typeof x.id !== 'string' || !x.id || ids.has(x.id) || typeof x.text !== 'string' || !x.text.trim() || !DAY_RE.test(x.day) || !BY.includes(x.by)) continue;
      if (Number(x.gone) > 0) continue; // 收走的当不存在
      const done = Number(x.done) > 0 ? Number(x.done) : 0;
      if (done && done < c) continue; // 本来就该清掉了
      const fix = x.fix && typeof x.fix.text === 'string' && x.fix.text.trim() ? { text: cut(x.fix.text, DIGEST.fix), t: Number(x.fix.t) || now() } : null;
      have.push({ id: x.id, t: Number(x.t) || now(), day: x.day, text: cut(x.text, DIGEST.max), sid: x.sid ? String(x.sid) : null, by: x.by,
        ...(WHY.includes(x.why) ? { why: x.why } : {}), ...(fix ? { fix } : {}), ...(done ? { done } : {}) });
      ids.add(x.id);
      n++;
    }
    if (n) { save(ai, have); store.log(ai, { who: 'me', op: 'import-digest', n }); } // 不带内容
    return { added: n };
  }

  return { add, pending, days, list, setFix, dropFix, remove, markDone, exportAll, importAll };
}
