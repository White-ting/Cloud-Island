// 拍一拍：设置和「还没带走的拍一拍」。规矩参考作者另一个私用项目的接口说明「拍一拍」一节。
// 聊天里那一行消息由 lib/chat.mjs 存；这里只管设置（存在记忆库设置的 cfg.pat）和挂起的那几下（mem.json 的 patWait）。
// 拍一拍不是记忆，不算「想起一次」。
import { fail } from './store.mjs';

export const PAT = { me: '', ai: '', reply: 'next', meName: '' };
const TAIL_MAX = 30;
const WAIT_MS = 6 * 3600e3; // 挂起太久（超过一场聊天的间隔）就不说「刚才」了
// 后半句前面的逗号由我们加：她自己打了逗号、顿号、空格的，去掉，免得出两个逗号
const LEAD = /^[\s，,、；;：:。]+/u; // 英文的点不去：「...」开头可能是她故意的

export function openPat({ store, now = store.now }) {
  const get = (ai) => ({ ...PAT, ...(store.load(ai).cfg.pat || {}) });
  function set(ai, input = {}) {
    const d = store.load(ai);
    const c = { ...PAT, ...(d.cfg.pat || {}) };
    for (const k of ['me', 'ai', 'meName']) {
      if (input[k] === undefined) continue;
      if (typeof input[k] !== 'string') throw fail(400, `${k} 要是一句话`);
      const s = k === 'meName' ? input[k].trim() : input[k].replace(LEAD, '').trim();
      if ([...s].length > TAIL_MAX) throw fail(400, `${k} 最长 ${TAIL_MAX} 个字`);
      c[k] = s;
    }
    if (input.reply !== undefined) {
      if (!['next', 'now'].includes(input.reply)) throw fail(400, 'reply 只能是 next 或 now');
      c.reply = input.reply;
    }
    d.cfg.pat = c;
    store.save(ai, d);
    return c;
  }
  // 她拍了一下，等她下一句话时一起带给 TA
  function hold(ai) {
    const d = store.load(ai), t = now();
    const w = d.patWait && t - d.patWait.t <= WAIT_MS ? d.patWait : { n: 0 };
    d.patWait = { n: w.n + 1, t };
    store.save(ai, d);
    return d.patWait.n;
  }
  // 拿走挂起的那几下（拿了就清掉）；没有回 0
  function take(ai) {
    const d = store.load(ai);
    if (!d.patWait) return 0;
    const w = d.patWait;
    delete d.patWait;
    store.save(ai, d);
    return now() - w.t <= WAIT_MS ? w.n : 0;
  }
  // 给 TA 的那一行：〔她刚才拍了拍你，然后揉了揉头发〕；拍了几下：〔她刚才拍了你 3 下，然后揉了揉头发〕；
  // 没填后半句就没有逗号：〔她刚才拍了拍你〕。now：拍完马上回的那种，不说「刚才」
  function line(ai, n = 1, { now: rightNow = false } = {}) {
    const tail = get(ai).me.replace(LEAD, '').trim();
    return `〔她${rightNow ? '' : '刚才'}${n > 1 ? `拍了你 ${n} 下` : '拍了拍你'}${tail ? '，' + tail : ''}〕`;
  }

  return { get, set, hold, take, line };
}
