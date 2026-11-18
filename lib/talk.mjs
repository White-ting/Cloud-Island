// 对话原文：她的话和 TA 给人看的正文（小记摘掉以后的），只留最近 48 小时。开场交接、夜里整理拿它对原话。
// 不存思考、不存工具输出、不存注入的上下文。不进导出、不进搜索，没有任何 HTTP 接口能把它读出去。
// 每个 AI 一个文件 data/<ai>/talk.jsonl，一行 { t, sid, role: 'me' | 'ai', text }，权限 600。
// 开不开由记忆库设置里的 talk 管（默认开），关掉时 store.setCfg 会调 wipe。
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './store.mjs';

const MAX_TEXT = 8000;        // 一句超过这么多字就截断
const PRUNE_MS = 3600e3;      // 过期的行最多攒一小时……
const PRUNE_N = 200;          // ……或者攒到写了这么多行，再重写一次文件清掉

export function openTalk({ dir, now = Date.now, keepMs = 48 * 3600e3 }) {
  const pruned = new Map(); // ai → { at: 上次清的时间, n: 之后又写了几行 }

  function file(ai) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(ai))) throw fail(400, 'AI 的名字只能是字母、数字、- 和 _');
    return path.join(dir, ai, 'talk.jsonl');
  }
  // 读出没过期的行；坏的一行跳过
  function rows(ai) {
    const f = file(ai);
    if (!fs.existsSync(f)) return { all: 0, keep: [] };
    const cut = now() - keepMs, keep = [];
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      try { const r = JSON.parse(l); if (r && r.t >= cut) keep.push(r); } catch { /* 坏的一行不要了 */ }
    }
    return { all: lines.length, keep };
  }
  // 清掉过期的：有要清的才重写（先写旁边再换名）
  function prune(ai) {
    pruned.set(ai, { at: now(), n: 0 });
    const { all, keep } = rows(ai);
    if (keep.length === all) return;
    const f = file(ai);
    fs.writeFileSync(f + '.tmp', keep.map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f);
  }

  // replace：重新生成的那一版。最后一行是同一方说的（上一版），就换掉它，不另加一行
  function add(ai, { sid, role, text } = {}, { replace = false } = {}) {
    if (role !== 'me' && role !== 'ai') throw fail(400, 'role 只能是 me 或 ai');
    const s = String(text ?? '').trim();
    if (!s) return null;
    const cs = [...s]; // 按字截，不把一个字劈成两半
    const row = { t: now(), sid: sid ? String(sid) : null, role, text: cs.length > MAX_TEXT ? cs.slice(0, MAX_TEXT).join('') : s };
    const f = file(ai);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (replace) {
      const { keep } = rows(ai);
      if (keep.length && keep.at(-1).role === role) {
        keep[keep.length - 1] = row;
        fs.writeFileSync(f + '.tmp', keep.map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
        fs.renameSync(f + '.tmp', f); // 先写旁边再换名（顺手清掉过期的）
        pruned.set(ai, { at: now(), n: 0 });
        return row;
      }
    }
    fs.appendFileSync(f, JSON.stringify(row) + '\n', { mode: 0o600 });
    const p = pruned.get(ai);
    if (!p || now() - p.at >= PRUNE_MS || ++p.n >= PRUNE_N) prune(ai); // 进程里头一次写也清一遍
    return row;
  }
  // since：只要这个时间以后的；sid：只要这一场的；limit：只要最后几行
  function recent(ai, { since, limit, sid } = {}) {
    let r = rows(ai).keep;
    if (since != null) r = r.filter((x) => x.t > Number(since));
    if (sid) r = r.filter((x) => x.sid === sid);
    return limit ? r.slice(-limit) : r;
  }
  // 最后 n 个来回：一来回 = 她一句 + TA 一句，回 [{ me, ai }]（缺的那一边是 null）
  function lastRounds(ai, n = 3) {
    const out = [];
    for (const r of rows(ai).keep) {
      const cur = out.at(-1);
      if (r.role === 'me' || !cur || cur.ai) out.push({ me: r.role === 'me' ? r : null, ai: r.role === 'ai' ? r : null });
      else cur.ai = r;
    }
    return out.slice(-n);
  }
  function wipe(ai) {
    const f = file(ai);
    fs.rmSync(f, { force: true });
    fs.rmSync(f + '.tmp', { force: true });
    pruned.delete(ai);
  }

  return { add, recent, lastRounds, wipe, keepMs };
}
