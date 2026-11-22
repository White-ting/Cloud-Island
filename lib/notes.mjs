// 小记：TA 在回复末尾写的 <!--note {…} -->。这里只管摘下来、照着存，不替 TA 判断。
import { sim, fail } from './store.mjs';

const RE = /<!--\s*note\s+([\s\S]*?)-->/g;

// 把回复拆成：给人看的正文 + 小记
export function split(reply) {
  const notes = [], bad = [];
  const clean = String(reply || '').replace(RE, (_, body) => {
    try {
      const o = JSON.parse(body.trim());
      if (o && typeof o === 'object' && !Array.isArray(o)) notes.push(o); else bad.push(body);
    } catch { bad.push(body); }
    return '';
  }).replace(/\s+$/, '');
  return { clean, notes, bad };
}

// 这条编号在记忆里吗（归档的不算）
const inMem = (store, ai, id) => store.load(ai).items.some((m) => m.id === id && !m.gone);

// 照小记去存。一条出错不影响别的。
// persona：lib/persona.mjs，TA 改自己的人格用；dreams：lib/dreams.mjs，TA 开关梦的私人用。没传就当没这两样
// later：TA 自己定的回头看（lib/knock.mjs 的 later：{ on(ai), add(ai, o), cancel(ai, id) }），没传或没打开就报「回头看没打开」
// marks：这句回复里要让界面留一行小字的（比如改了人格、定了一个回头看），调用的一方拿去显示
// rows：动了哪几条记忆，给聊天界面那一行小字用：{ id, kind, op: add|edit|up|down|done|gone|hill, leaf?, priv? }。
//   私人念想不带编号（跟流水一样）；只「想起一次」、状态、交接、梦不算
// digest：待整理（lib/digest.mjs）；diary：日记（lib/diary.mjs）。没传就报错，跟人格一样。why：散场记的时机，存进待整理
// 拍一拍 {"pat":true}：只放进 marks（{ kind: 'pat' }），聊天那边照着加一行
// kinds：每条存下来的小记是哪一种（digest、diary、state、handoff、pat、note、wish……），散场记那行小字用，不带内容
export function apply(store, ai, notes, { sid, persona, dreams, later, digest, diary, why } = {}) {
  const done = [], errors = [], marks = [], rows = [], kinds = [];
  const row = (m, op) => rows.push({ ...(m.priv ? { priv: true } : { id: m.id }), kind: m.kind || 'note', op, ...(op === 'add' && m.leaf ? { leaf: true } : {}) });
  const ok = (k, what = k) => { done.push(what); kinds.push(k); };
  for (const n of notes) {
    try {
      if (n.state) { store.setState(ai, n.state); ok('state'); continue; }
      if (n.handoff !== undefined) { store.setHandoff(ai, n.handoff, sid); ok('handoff'); continue; }
      if (n.digest !== undefined) {
        if (!digest) throw fail(400, '这里没有待整理');
        digest.add(ai, { text: n.digest, sid, by: 'ai', why }); // why：散场记哪个时机（聊天当中写的没有）
        ok('digest');
        continue;
      }
      if (n.diary !== undefined) {
        if (!diary) throw fail(400, '这里没有日记');
        const e = diary.addPart(ai, n.diary);
        // 补的是以前那天（凌晨没跑成的）：那天的待整理算写成日记了。今天的还在攒，不标
        if (digest && e.day < store.dayOf(store.now())) digest.markDone(ai, e.day);
        ok('diary');
        continue;
      }
      if (n.pat !== undefined) {
        if (n.pat !== true) throw fail(400, '拍一拍写成 {"pat":true}');
        marks.push({ kind: 'pat' });
        ok('pat');
        continue;
      }
      if (n.persona !== undefined) {
        if (!persona) throw fail(400, '这里没有人格可改');
        marks.push(persona.edit(ai, n.persona));
        ok('persona');
        continue;
      }
      if (n.later !== undefined) {
        if (!later || !later.on(ai)) throw fail(400, '回头看没打开');
        const o = n.later;
        if (o && typeof o === 'object' && o.cancel !== undefined) {
          later.cancel(ai, String(o.cancel));
          marks.push({ kind: 'later', op: 'cancel', id: String(o.cancel) });
        } else marks.push({ kind: 'later', op: 'add', id: later.add(ai, o).id });
        ok('later');
        continue;
      }
      // 梦的编号也是 d 开头的一串：先查记忆，记忆里没有、梦里有，才当梦
      if (n.id && dreams && /^d/.test(n.id) && !inMem(store, ai, n.id) && dreams.has(ai, n.id)) {
        const { id, ...rest } = n;
        if (Object.keys(rest).some((k) => k !== 'priv')) throw fail(400, '梦只能改 priv');
        dreams.patch(ai, id, rest);
        ok('dream', id);
        continue;
      }
      if (n.id) {
        const { id, lv, hit, why, gone, hill, name, ...rest } = n;
        const cur = store.load(ai).items.find((m) => m.id === id && !m.gone) || { id };
        // TA 自己收进归档：只能收自己记的。归档的 TA 看不到，所以不能自己捡回来
        if (gone !== undefined) {
          if (gone !== true) throw fail(400, '归档的你看不到，要捡回来得她在网页上做');
          store.remove(ai, id, { who: 'ai' });
          ok(cur.kind || 'note', id);
          row(cur, 'gone');
          continue;
        }
        // 山：这件事对我更重了（只有记事；山的高度另一份后端算）
        if (hill !== undefined) {
          if (hill !== 'up') throw fail(400, 'hill 只能写 up（山只会变高）');
          store.hillUp(ai, id, why, { name });
          if (Object.keys(rest).length) store.patch(ai, id, rest, { who: 'ai' });
          ok('note', id);
          row(cur, 'hill');
          continue;
        }
        if (lv) { store.hit(ai, id, sid); store.wishMove(ai, id, lv, why); }
        else if (hit) store.hit(ai, id, sid);
        if (why !== undefined && !lv) rest.why = why;
        if (Object.keys(rest).length) store.patch(ai, id, rest, { who: 'ai' });
        ok(cur.kind || 'note', id);
        if (lv) row(cur, lv);
        else if (Object.keys(rest).length) row(cur, rest.done === true ? 'done' : 'edit');
        continue;
      }
      const m = store.add(ai, n, 'ai', { sid });
      ok(m.kind || 'note', m.id);
      row(m, 'add');
    } catch (e) {
      // 护栏拦下的（带错误码）照说原因；意外的（比如磁盘写不进）也接住，不带原文，不往外抛
      errors.push(Number.isInteger(e.code) ? e.message : '这一条小记存不进去');
    }
  }
  const out = { done, errors };
  if (kinds.length) out.kinds = kinds;
  if (marks.length) out.marks = marks;
  if (rows.length) out.rows = rows;
  return out;
}

// 网关上一条消息前带出去的念想，TA 这次回复真的接着说了，才算想起一次
export function autoHit(store, ai, reply, { sid } = {}) {
  let n = 0;
  const ids = store.lastRecalled(ai);
  if (!ids.length) return n;
  const items = store.list(ai, { who: 'ai' }).items;
  for (const id of ids) {
    const m = items.find((x) => x.id === id);
    if (m && !m.done && m.lastSid !== sid && sim(reply, m.text) >= 0.2) { store.hit(ai, id, sid); n++; }
  }
  return n;
}
