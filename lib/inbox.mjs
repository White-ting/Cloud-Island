// 收件箱：所有会叫醒 TA 的事先进这张表，不直接去叫。思路照 Anthropic《Building always-on agents》（2026-11-13）。
// 一件事 { id, t, kind, key?, body, st: new|doing|done|fail|drop, tries, why?, t1?（开始做）, t2?（做完）, after?（这之前不取）}。
// 每个 AI 一个文件 data/<ai>/inbox.json（整份原子写，权限 600）。这是流水，不是记忆：做完的留 7 天就清。
// 一个 AI 同时只做一件；做的人（handlers）是注入的，每种一个 async 函数 (ai, 这件事) → { said?, why?, drop? }。
//   回 { drop: 原因 }：不做了，标 drop；抛出带 requeue 或 409 的错：放回去晚点再来（不算一次失败）；
//   抛出 4xx（409 除外）、503：做不了，标 drop、原因照错误那句话；别的错：算失败一次，隔一阵再试，试满 3 次标 fail。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './store.mjs';

export const KINDS = ['knock', 'idle', 'night', 'later', 'sched'];
const DAY = 864e5;
const HANG = 10 * 60e3;   // doing 超过这么久没做完算挂了
const KEEP = 7 * DAY;     // 做完的留几天
const TRIES = 3;
const KEY_MAX = 200, BODY_MAX = 16 * 1024;
const ROUND = 20;         // 一次最多连着做几件，免得绕圈
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

// 给设置页看的：不带 body
const pub = (x) => ({ id: x.id, t: x.t, kind: x.kind, st: x.st, ...(x.why ? { why: x.why } : {}) });

// busy(ai)：TA 正在回她的话（或者正在手动跑夜里），这时不取件。auto：放进来就顺手开始做（后端开着，测试里关着手动调 pump）
export function openInbox({ dir, store, handlers = {}, busy = () => false, log = () => {}, now = store.now, hangMs = HANG, auto = false }) {
  const pumping = new Set();
  const file = (ai) => path.join(store.folder(ai), 'inbox.json');
  function load(ai) {
    try { const a = JSON.parse(fs.readFileSync(file(ai), 'utf8')); return Array.isArray(a) ? a.filter((x) => x && x.id) : []; } catch { return []; }
  }
  // 存之前顺手清掉做完满 7 天的
  function save(ai, xs) {
    const t = now(), f = file(ai);
    const keep = xs.filter((x) => x.st === 'new' || x.st === 'doing' || t - (x.t2 || x.t) < KEEP);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(keep), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f); // 先写旁边再换名
  }
  // 收尾一件：并进它的那几件跟着它走
  function close(xs, x, st, why) {
    const t = now();
    for (const y of [x, ...xs.filter((z) => z.into === x.id)]) {
      y.st = st;
      y.t2 = t;
      if (why) y.why = why; else if (y === x) delete y.why;
    }
    delete x.t1;
  }
  // 放回去：count 是不是算一次失败；满 3 次就不再试
  function back(xs, x, { after, count, why }) {
    if (count) x.tries = (x.tries || 0) + 1;
    if (x.tries >= TRIES) return close(xs, x, 'fail', `试了 ${TRIES} 次都没做完`);
    x.st = 'new';
    delete x.t1;
    if (after) x.after = after; else delete x.after;
    if (why) x.why = why;
  }
  // 挂了的 doing：超过 10 分钟没做完（all：进程刚起来，遗留的都算）
  function heal(xs, all = false) {
    const t = now();
    let n = 0;
    for (const x of xs) if (x.st === 'doing' && (all || t - (x.t1 || x.t) >= hangMs)) { back(xs, x, { count: true, why: '上次没做完' }); n++; }
    return n;
  }

  function put(ai, { kind, key, body } = {}) {
    if (!KINDS.includes(kind)) throw fail(400, 'kind 只能是 ' + KINDS.join('、'));
    if (key != null && (typeof key !== 'string' && typeof key !== 'number')) throw fail(400, 'key 要是一段文字');
    const k = key == null || key === '' ? null : String(key);
    if (k && k.length > KEY_MAX) throw fail(400, `key 最长 ${KEY_MAX} 字`);
    if (body !== undefined && Buffer.byteLength(JSON.stringify(body) || '') > BODY_MAX) throw fail(413, '内容太大');
    const xs = load(ai), t = now();
    // 同一种、同一个来源编号，24 小时内再来一次：不新加，回原来那件
    const dup = k && xs.find((x) => x.kind === kind && x.key === k && t - x.t < DAY);
    if (dup) return { ...pub(dup), dup: true };
    const x = { id: 'q' + t.toString(36) + crypto.randomBytes(3).toString('hex'), t, kind, ...(k ? { key: k } : {}), body: body ?? null, st: 'new', tries: 0 };
    xs.push(x);
    save(ai, xs);
    if (auto) setImmediate(() => pump(ai).catch((e) => log('收件箱', ai, '出错', e.code || e.name)));
    return pub(x);
  }

  // 取最老的一件 new 标成 doing。已经有 doing（没挂）、或者 TA 正忙，回 null。排队的几件 knock 合成一件（body 变数组）
  function take(ai) {
    if (busy(ai)) return null;
    const xs = load(ai), t = now();
    const healed = heal(xs);
    if (xs.some((x) => x.st === 'doing')) { if (healed) save(ai, xs); return null; }
    const ready = xs.filter((x) => x.st === 'new' && (x.after || 0) <= t);
    const x = ready[0];
    if (!x) { if (healed) save(ai, xs); return null; }
    if (x.kind === 'knock') {
      const more = ready.filter((y) => y !== x && y.kind === 'knock');
      if (more.length) {
        x.body = [...(x.many ? x.body : [x.body]), ...more.flatMap((y) => (y.many ? y.body : [y.body]))];
        x.many = true;
        for (const y of more) {
          for (const z of xs) if (z.into === y.id) z.into = x.id;
          Object.assign(y, { st: 'done', into: x.id, t2: t, why: '跟前面那件合成一件了' });
        }
      }
    }
    x.st = 'doing';
    x.t1 = t;
    save(ai, xs);
    return JSON.parse(JSON.stringify(x));
  }

  // 做完一件：ok → done；drop → drop；不然 fail。不是 doing 的（比如算挂了已经放回去）不动，回 null
  function finish(ai, id, { ok = true, drop = false, why, said } = {}) {
    const xs = load(ai), x = xs.find((y) => y.id === id && y.st === 'doing');
    if (!x) return null;
    close(xs, x, ok ? 'done' : drop ? 'drop' : 'fail', why ? String(why).slice(0, 200) : '');
    if (said !== undefined) x.said = !!said;
    save(ai, xs);
    return pub(x);
  }
  function requeue(ai, id, opt) {
    const xs = load(ai), x = xs.find((y) => y.id === id && y.st === 'doing');
    if (!x) return null;
    back(xs, x, opt);
    save(ai, xs);
    return pub(x);
  }

  const HUNG = Symbol('hung');
  async function handle(ai, x) {
    const fn = handlers[x.kind];
    if (!fn) return finish(ai, x.id, { ok: false, drop: true, why: '没有处理这一种的（没配 AI，或者这一种还没做）' });
    let r, timer;
    try {
      r = await Promise.race([fn(ai, x), new Promise((ok) => { timer = setTimeout(() => ok(HUNG), hangMs); timer.unref?.(); })]);
    } catch (e) {
      if (e.requeue || e.code === 409) return requeue(ai, x.id, { after: e.after || now() + 60e3, count: false });
      if (Number.isInteger(e.code) && ((e.code >= 400 && e.code < 500) || e.code === 503)) return finish(ai, x.id, { ok: false, drop: true, why: e.message });
      log('收件箱', ai, x.kind, '没做成：', e.code || e.name);
      return requeue(ai, x.id, { after: now() + 5 * 60e3 * ((x.tries || 0) + 1), count: true, why: '出错了' });
    } finally { clearTimeout(timer); }
    if (r === HUNG) { log('收件箱', ai, x.kind, '十分钟没做完，算挂了'); return null; } // 留着 doing，下次取件时按挂了处理
    if (r?.drop) return finish(ai, x.id, { ok: false, drop: true, why: r.drop });
    return finish(ai, x.id, { ok: true, why: r?.why, said: r?.said });
  }

  // 把这个 AI 排着的一件件做掉（同一个 AI 不会同时跑两份）
  async function pump(ai) {
    if (pumping.has(ai)) return 0;
    pumping.add(ai);
    let n = 0;
    try {
      for (; n < ROUND; n++) {
        const x = take(ai);
        if (!x) break;
        await handle(ai, x);
      }
    } finally { pumping.delete(ai); }
    return n;
  }
  function ais() {
    try { return fs.readdirSync(dir).filter((x) => NAME_RE.test(x) && fs.existsSync(path.join(dir, x, 'inbox.json'))); } catch { return []; }
  }
  async function pumpAll() {
    for (const ai of ais()) { try { await pump(ai); } catch (e) { log('收件箱', ai, '出错', e.code || e.name); } }
  }
  // 进程刚起来：遗留的 doing 都按挂了处理
  function boot() {
    for (const ai of ais()) {
      try { const xs = load(ai); if (heal(xs, true)) save(ai, xs); } catch (e) { log('收件箱', ai, '启动时整理出错', e.code || e.name); }
    }
  }
  const doing = (ai) => load(ai).some((x) => x.st === 'doing');
  function list(ai) { store.folder(ai); return { items: load(ai).map(pub) }; }

  return { put, take, finish, requeue, pump, pumpAll, boot, doing, list, load };
}
