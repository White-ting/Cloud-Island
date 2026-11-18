// 开屏字幕：锁屏上时间日期下面那一句。按 8 个时段，每段几句英文，可以带中文小字。
// 存在 data/lockwords/<ai>.json（权限 600）。写法参考作者另一个私用项目：让 TA 用自己的口气写一套，只回草稿，存要另外调 PUT（或者带 save: true）。
// GET  /api/lockwords?ai=      → { words: {…} | null }
// PUT  /api/lockwords?ai=      { words } → { ok, words }
// POST /api/lockwords/write    { ai, save? } → { ok, words }（TA 用它自己的模型写；同一个 AI 同时只写一次）
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './store.mjs';

export const SLOTS = ['late_night', 'dawn', 'morning', 'noon', 'afternoon', 'dusk', 'evening', 'night'];
export const PROMPT = '你在给她的手机网页写开屏锁屏上的一句话（屏幕中间、时间日期下方、衬线大字）。'
  + '用你自己的性格和口气（就是上面人格里写的你）。要求：英文；每句 2 到 6 个词；'
  + '不用 emoji、不用感叹号；不提 AI 或模型的名字；可以有一点小幽默或温度。'
  + '按 8 个时段各写 3 句：late_night(0-5点) dawn(5-8) morning(8-11) noon(11-13) '
  + 'afternoon(13-17) dusk(17-19) evening(19-22) night(22-24)。'
  + '每句再自己翻成中文，放在开屏英文下面的小字：用你自己的口气意译，不要翻译腔，每句不超过 14 个字。'
  + '只输出一个 JSON 对象：键是这 8 个时段名，值是 3 个英文字符串的数组；另加一个键 zh，值是同样 8 个时段、'
  + '同样顺序的中文数组。不要任何别的文字，也不要写小记。';

// 核对格式：8 个时段，每段 1–5 句，每句不超过 60 字；zh 可以没有，有的话要 8 段都在、条数够。不对回 null
export function clean(words) {
  if (!words || typeof words !== 'object' || Array.isArray(words)) return null;
  const out = {};
  for (const k of SLOTS) {
    const v = words[k];
    if (!Array.isArray(v)) return null;
    const a = v.map((x) => [...String(x ?? '').trim()].slice(0, 60).join('')).filter(Boolean).slice(0, 5);
    if (!a.length) return null;
    out[k] = a;
  }
  const zh = words.zh;
  if (zh && typeof zh === 'object' && !Array.isArray(zh)) {
    const z = {};
    for (const k of SLOTS) {
      const v = zh[k];
      if (Array.isArray(v) && v.length >= out[k].length) z[k] = v.slice(0, out[k].length).map((x) => [...String(x ?? '').trim()].slice(0, 30).join(''));
    }
    if (Object.keys(z).length === SLOTS.length) out.zh = z;
  }
  return out;
}

// 从模型的回复里抠出那个 JSON（前后可能有别的字、可能包在 ``` 里）
export function pickJson(text) {
  const s = String(text || ''), i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; }
}

// folder(ai)：校验 AI 名字（store.folder）；ask(ai, 提示) → 模型回的整段文字（chat.ask）
export function openLockwords({ dir, folder = () => {}, ask = null, log = () => {} }) {
  const base = () => path.join(dir, 'lockwords');
  const fileOf = (ai) => { folder(ai); return path.join(base(), ai + '.json'); };
  const writing = new Set();
  function get(ai) {
    const f = fileOf(ai);
    try { return { words: clean(JSON.parse(fs.readFileSync(f, 'utf8'))) }; } catch { return { words: null }; }
  }
  function put(ai, body = {}) {
    const f = fileOf(ai);
    const words = clean(body && body.words !== undefined ? body.words : body);
    if (!words) throw fail(400, '格式不对：要 8 个时段（' + SLOTS.join('、') + '），每段 1 到 5 句');
    fs.mkdirSync(base(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f + '.tmp', JSON.stringify(words, null, 1), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f);
    return { ok: true, words };
  }
  async function write(body = {}) {
    const ai = String(body.ai ?? '');
    fileOf(ai);
    if (!ask) throw fail(404, '没有这个地址');
    if (writing.has(ai)) throw fail(409, '上一次还在写');
    writing.add(ai);
    try {
      const t0 = Date.now();
      const text = await ask(ai, PROMPT);
      const words = clean(pickJson(text));
      log('开屏字幕', ai, `写了 ${Math.round((Date.now() - t0) / 1000)} 秒，${words ? '成了' : '没成（格式不对）'}`);
      if (!words) throw fail(502, '没写成（回来的不是那个格式），再试一次');
      if (body.save === true) put(ai, { words });
      return { ok: true, words, ...(body.save === true ? { saved: true } : {}) };
    } finally { writing.delete(ai); }
  }
  return { get, put, write };
}
