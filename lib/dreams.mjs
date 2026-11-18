// 梦：夜里「临时的 TA」写的，单独存在 data/<ai>/dreams.json，不是六种记忆里的任何一种。
// 不进召回、不进记忆的导出。私人的那场她只看到「有一场梦」，开不开由 TA 在小记里定。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './store.mjs';

export function openDreams({ store, now = store.now }) {
  const file = (ai) => path.join(store.folder(ai), 'dreams.json');
  function load(ai) {
    try { return JSON.parse(fs.readFileSync(file(ai), 'utf8')); } catch { return []; }
  }
  function save(ai, ds) {
    const f = file(ai);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(ds), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f); // 先写旁边再换名
  }

  function add(ai, { text, gist, from = [], priv = false }) {
    const ds = load(ai);
    const d = { id: 'd' + now().toString(36) + crypto.randomBytes(2).toString('hex'), t: now(), text, gist, from, priv: !!priv };
    ds.push(d);
    save(ai, ds);
    return d;
  }
  // 新的在前。who: 'me' 是她，私人的那场只回 { id, t, priv }
  function list(ai, { before, limit = 20, who = 'me' } = {}) {
    let ds = load(ai).slice().sort((a, b) => b.t - a.t);
    if (before) ds = ds.filter((d) => d.t < Number(before));
    const n = Math.max(1, Math.min(100, Number(limit) || 20));
    ds = ds.slice(0, n);
    return { items: who === 'me' ? ds.map((d) => (d.priv ? { id: d.id, t: d.t, priv: true } : d)) : ds };
  }
  const has = (ai, id) => load(ai).some((d) => d.id === id);
  // 只有 TA 能动，只能改私不私人
  function patch(ai, id, { priv }) {
    const ds = load(ai), d = ds.find((x) => x.id === id);
    if (!d) throw fail(404, '没有这场梦');
    if (typeof priv !== 'boolean') throw fail(400, '梦只能改 priv（true 或 false）');
    d.priv = priv;
    save(ai, ds);
    store.log(ai, { who: 'ai', op: 'dream-priv', id, priv }); // 不带内容
    return d;
  }
  // 最近几场的摘要（写梦时让它避开）
  const recentGists = (ai, n = 3) => load(ai).slice(-n).map((d) => d.gist);

  return { add, list, has, patch, recentGists };
}
