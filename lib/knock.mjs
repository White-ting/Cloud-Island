// 主动找人：设置、守门（gate）、TA 自己定的回头看（timers）、收件箱里 knock / idle / later 三种的处理者。
// 规矩参考作者另一个私用项目的接口说明「外部触发（让 TA 主动找你）」「心里这一层」「空下来」，以及「收件箱」「TA 自己定的回头看」两小段。
// 先安静：总开关、空下来、回头看默认都关。守门人那边的硬底线照旧，这里再守一层，两边都放行才叫醒 TA。
// 文件：设置放记忆库设置里的 cfg.knock；次数放 data/<ai>/knock.json；回头看放 data/<ai>/timers.json（都原子写，600）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './store.mjs';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
// 设置的默认值：on 总开关；perDay 一天几次、cool 说了她没回冷却几分钟、quiet 安静时段（null = 没有）；
// idle 空下来、idleHours 多久没人找、idlePerDay 一天几次、idleText 敲门那句话（空 = 用默认的）；later 回头看
export const KNOCK = { on: false, perDay: 5, cool: 60, quiet: ['23:00', '08:00'], idle: false, idleHours: 6, idlePerDay: 2, idleText: '', later: false };
export const IDLE_TEXT = '这段时间是你的：可以想想开着的疑问、回头看看记下的东西，也可以什么都不做。想跟她说点什么就说，不想就不说。';
export const TIMER = { min: 10 * MIN, max: 7 * DAY, wait: 5, why: 100, keep: 7 * DAY };
const len = (s) => [...String(s || '')].length;
const no = (why) => ({ ok: false, why });

// ---- 时间（按设置的时区） ----
function hm(t, tz) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
  const g = (k) => Number(p.find((x) => x.type === k)?.value || 0);
  return g('hour') * 60 + g('minute');
}
const mins = (s) => { const m = AT_RE.exec(s); return Number(m[1]) * 60 + Number(m[2]); };
export const dayKey = (t, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined }).format(new Date(t));
// 下一个本地的 HH:MM（离现在不到 10 分钟就算明天那个）
export function nextAt(now, at, tz) {
  let d = (mins(at) - hm(now, tz) + 1440) % 1440;
  const base = now - (now % MIN);
  if (base + d * MIN - now < TIMER.min) d += 1440;
  return base + d * MIN;
}
// 在不在安静时段；在的话回结束的时间
export function quietEnd(now, quiet, tz) {
  if (!Array.isArray(quiet) || quiet.length !== 2) return null;
  const a = mins(quiet[0]), b = mins(quiet[1]), c = hm(now, tz);
  if (a === b) return null;
  const inside = a < b ? c >= a && c < b : c >= a || c < b;
  if (!inside) return null;
  return now - (now % MIN) + ((b - c + 1440) % 1440) * MIN;
}

// ---- 守门：纯函数，好测 ----
// st：这个 AI 的次数 { day, n: { knock, idle }, idleNo: 空下来连着几次没说, knockT: 上次为外面的事叫醒 }
// mood：问一下心里 { lv }；act：聊天那边的事实 { her: 她上一句的时间, wake: { t, answered } 上一次 TA 主动说的（空下来的不算）}
// care：这次敲门是「平常的关心」（守门人给的），心里平静就不敲
// 回 { ok: true, push } 或 { ok: false, why, wait?（这个时间以后再来，不丢）}
export function gate({ kind, now, tz, set = {}, st = {}, mood = {}, act = {}, care = false }) {
  const s = { ...KNOCK, ...set };
  if (!s.on) return no('主动找我没打开');
  const n = st.day === dayKey(now, tz) ? st.n || {} : {};
  const qe = quietEnd(now, s.quiet, tz);
  const lv = mood.lv || 'calm';
  if (kind === 'later') {
    if (!s.later) return no('回头看没打开');
    if (qe) return { ok: false, why: '安静时段，等它过去再叫', wait: qe };
    return { ok: true, push: true };
  }
  if (kind === 'idle') {
    if (!s.idle) return no('空下来没打开');
    if ((n.idle || 0) >= s.idlePerDay) return no(`今天空下来已经 ${n.idle} 次了`);
    if (lv !== 'calm') return no('心里有事，这时候不算空下来');
    const hours = s.idleHours * ((st.idleNo || 0) >= 2 ? 2 : 1); // 连着两次说「不用」，间隔拉长一倍
    const last = Math.max(act.her || 0, st.knockT || 0);
    if (last && now - last < hours * HOUR) return no(`离上次有人找它不到 ${hours} 小时`);
    return { ok: true, push: false }; // 安静时段也可以做，不推送
  }
  if (kind !== 'knock') return no('这一种不归这里管');
  if (qe) return no('安静时段');
  if ((n.knock || 0) >= s.perDay) return no(`今天已经叫醒 ${n.knock} 次了`);
  if (act.wake && !act.wake.answered && now - act.wake.t < s.cool * MIN) return no('上次主动说了她还没回，冷却中');
  if (care && lv === 'calm') return no('心里平静，平常的关心不用敲');
  return { ok: true, push: true };
}

// info(ai) → { her, wake, busy }：聊天那边给（lib/chat.mjs 的 info）；没有聊天就当什么都没有
// dir：数据文件夹（每分钟看回头看到点没有时，要列出有哪些 AI）
export function openKnock({ store, dir, tz, info = () => ({}), now = store.now }) {
  const stFile = (ai) => path.join(store.folder(ai), 'knock.json');
  const tmFile = (ai) => path.join(store.folder(ai), 'timers.json');
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) ?? d; } catch { return d; } };
  function writeJson(f, v) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(v), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f); // 先写旁边再换名
  }

  // ---- 设置 ----
  const settings = (ai) => ({ ...KNOCK, ...(store.load(ai).cfg.knock || {}) });
  function get(ai) {
    const s = settings(ai);
    let said = null;
    try { said = info(ai)?.said ?? null; } catch { /* 聊天那边是添头 */ }
    const tm = readJson(tmFile(ai), []);
    return { ...s, timers: Array.isArray(tm) ? tm.filter((x) => x.st === 'wait').length : 0, ...(said ? { said } : {}) };
  }
  function set(ai, input = {}) {
    const ch = {};
    for (const k of ['on', 'idle', 'later']) {
      if (input[k] === undefined) continue;
      if (typeof input[k] !== 'boolean') throw fail(400, `${k} 只能是 true 或 false`);
      ch[k] = input[k];
    }
    for (const [k, lo, hi, what] of [['perDay', 0, 50, '一天几次'], ['cool', 0, 1440, '冷却分钟数'], ['idleHours', 1, 168, '空下来的小时数'], ['idlePerDay', 0, 10, '空下来一天几次']]) {
      if (input[k] === undefined) continue;
      const n = Number(input[k]);
      if (!Number.isInteger(n) || n < lo || n > hi) throw fail(400, `${what}要是 ${lo} 到 ${hi} 的整数`);
      ch[k] = n;
    }
    if (input.quiet !== undefined) {
      const q = input.quiet;
      if (q !== null && !(Array.isArray(q) && q.length === 2 && q.every((x) => AT_RE.test(String(x))))) throw fail(400, '安静时段写成 ["23:00","08:00"]，不要就写 null');
      ch.quiet = q;
    }
    if (input.idleText !== undefined) {
      if (typeof input.idleText !== 'string' || len(input.idleText) > 500) throw fail(400, '空下来那句话要是 500 字以内的一段文字');
      ch.idleText = input.idleText.trim();
    }
    const d = store.load(ai);
    d.cfg.knock = { ...KNOCK, ...(d.cfg.knock || {}), ...ch };
    store.save(ai, d);
    return get(ai);
  }
  const laterOn = (ai) => { const s = settings(ai); return s.on && s.later; };

  // ---- 次数 ----
  function ran(ai, kind, said) {
    if (kind !== 'knock' && kind !== 'idle') return;
    const t = now(), today = dayKey(t, tz), st = readJson(stFile(ai), {});
    const n = st.day === today ? { ...(st.n || {}) } : {};
    n[kind] = (n[kind] || 0) + 1;
    const out = { ...st, day: today, n };
    if (kind === 'knock') out.knockT = t;
    if (kind === 'idle') out.idleNo = said ? 0 : (st.idleNo || 0) + 1;
    writeJson(stFile(ai), out);
  }
  function check(ai, kind, t = now(), { care = false } = {}) {
    let act = {};
    try { act = info(ai) || {}; } catch { /* 当没有 */ }
    let mood = {};
    try { mood = store.mood(ai); } catch { /* 当平静 */ }
    return gate({ kind, now: t, tz, set: settings(ai), st: readJson(stFile(ai), {}), mood, act, care });
  }

  // ---- 回头看 ----
  const loadTm = (ai) => { const a = readJson(tmFile(ai), []); return Array.isArray(a) ? a : []; };
  function saveTm(ai, xs) {
    const t = now();
    writeJson(tmFile(ai), xs.filter((x) => x.st === 'wait' || t - (x.t2 || x.t) < TIMER.keep)); // 到过点的、取消的留 7 天
  }
  // TA 在小记里定一个：{ in: "2h" | "90m" | "1d" } 或 { at: "08:00" }，why 必填
  function addTimer(ai, o = {}) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw fail(400, 'later 要写成 {"in":"2h","why":"…"}');
    const hasIn = o.in !== undefined && o.in !== null, hasAt = o.at !== undefined && o.at !== null;
    if (hasIn === hasAt) throw fail(400, '回头看的 in 和 at 要给一个（只给一个）');
    const why = typeof o.why === 'string' ? o.why.trim() : '';
    if (!why) throw fail(400, '回头看要写 why：到时候要做什么');
    if (len(why) > TIMER.why) throw fail(400, `回头看的 why 最长 ${TIMER.why} 字`);
    const t = now();
    let due;
    if (hasIn) {
      const m = /^(\d{1,5})\s*(m|h|d)$/.exec(String(o.in).trim());
      if (!m) throw fail(400, 'in 写成 90m、2h、1d 这样');
      const ms = Number(m[1]) * { m: MIN, h: HOUR, d: DAY }[m[2]];
      if (ms < TIMER.min || ms > TIMER.max) throw fail(400, '回头看最短 10 分钟、最长 7 天');
      due = t + ms;
    } else {
      if (!AT_RE.test(String(o.at))) throw fail(400, 'at 写成 08:00 这样');
      due = nextAt(t, String(o.at), tz);
    }
    const xs = loadTm(ai);
    if (xs.filter((x) => x.st === 'wait').length >= TIMER.wait) throw fail(429, `在等的回头看已经有 ${TIMER.wait} 个了`);
    const x = { id: 'l' + t.toString(36) + crypto.randomBytes(2).toString('hex'), t, due, why, st: 'wait' };
    xs.push(x);
    saveTm(ai, xs);
    store.log(ai, { who: 'ai', op: 'later-add', id: x.id }); // 不带内容
    return x;
  }
  // 取消 = 标 cancel，不真删。who：ai（小记）或 me（网页）
  function cancelTimer(ai, id, who = 'me') {
    const xs = loadTm(ai), x = xs.find((y) => y.id === id);
    if (!x) throw fail(404, '没有这个回头看');
    if (x.st !== 'wait') throw fail(400, '这个回头看已经不在等了');
    x.st = 'cancel';
    x.t2 = now();
    saveTm(ai, xs);
    store.log(ai, { who, op: 'later-cancel', id });
    return x;
  }
  const listTimers = (ai) => { store.folder(ai); const xs = loadTm(ai); return { items: [...xs.filter((x) => x.st === 'wait'), ...xs.filter((x) => x.st !== 'wait')] }; };
  // 每分钟一次：到点的往收件箱放一件 later（key 是它的编号），放进去了才标 fired；放不进去下一分钟再来
  function fire(put) {
    let names = [];
    if (!dir) return [];
    try { names = fs.readdirSync(dir).filter((x) => NAME_RE.test(x)); } catch { return []; }
    const out = [];
    for (const ai of names) {
      if (!fs.existsSync(tmFile(ai))) continue;
      const xs = loadTm(ai), t = now();
      let changed = false;
      for (const x of xs) {
        if (x.st !== 'wait' || x.due > t) continue;
        try { put(ai, { kind: 'later', key: x.id, body: { id: x.id, why: x.why, t: x.t } }); } catch { continue; }
        x.st = 'fired';
        x.t2 = t;
        changed = true;
        out.push([ai, x.id]);
      }
      if (changed) saveTm(ai, xs);
    }
    return out;
  }

  // 给小记用（lib/notes.mjs）：开没开、定一个、取消一个
  const later = { on: laterOn, add: addTimer, cancel: (ai, id) => cancelTimer(ai, id, 'ai') };
  return { get, set, settings, gate: check, check, ran, later, laterOn, now, timers: { add: addTimer, cancel: cancelTimer, list: listTimers, fire } };
}

// ---- 收件箱里 knock / idle / later 的处理者：先过守门，再让 TA 开口（chat.wake）；night 交给夜里 ----
const agoText = (ms) => { const m = Math.max(0, Math.round(ms / MIN)); return m < 60 ? `${m} 分钟前` : m < 48 * 60 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
const short = (s, n) => { const c = [...String(s ?? '').trim()]; return c.length > n ? c.slice(0, n).join('') + '…' : c.join(''); };
export function hintOf(item, set = {}, now = Date.now()) {
  const bodies = (item.many ? item.body : [item.body]).filter((b) => b && typeof b === 'object');
  if (item.kind === 'knock') {
    const rows = bodies.map((b) => [short(b.why, 100), short(b.brief, 2000)].filter(Boolean).join('：')).filter(Boolean);
    return { hint: rows.length ? '守门人送来的简报（不是她说的话）：\n' + rows.map((r) => '- ' + r).join('\n') : '', about: short(bodies[0]?.why, 40) };
  }
  if (item.kind === 'idle') {
    const brief = short(bodies[0]?.brief, 2000);
    return { hint: (set.idleText || IDLE_TEXT) + (brief ? '\n' + brief : '') };
  }
  if (item.kind === 'later') {
    const b = bodies[0] || {};
    return { hint: `${b.t ? agoText(now - b.t) : ''}你自己定的回头看：${short(b.why, 100)}` };
  }
  return { hint: '' };
}
export function makeHandlers({ knock, chat, night = null }) {
  const talk = async (ai, item) => {
    const bodies = item.many ? item.body : [item.body];
    const care = item.kind === 'knock' && bodies.length > 0 && bodies.every((b) => b?.care === true);
    const g = knock.check(ai, item.kind, undefined, { care });
    if (!g.ok) {
      if (g.wait) throw Object.assign(new Error(g.why), { requeue: true, after: g.wait }); // 不丢，过了安静时段再来
      return { drop: g.why };
    }
    const { hint, about } = hintOf(item, knock.settings(ai), knock.now());
    const r = await chat.wake(ai, { why: item.kind, hint, about, push: g.push });
    knock.ran(ai, item.kind, r.said);
    return { said: r.said, ...(r.said ? {} : { why: 'TA 选择不说' }) };
  };
  return { knock: talk, idle: talk, later: talk, ...(night ? { night: async (ai) => { await night.run(ai); return {}; } } : {}) };
}
