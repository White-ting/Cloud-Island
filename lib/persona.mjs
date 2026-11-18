// 人格 md：给走 API 的 TA 一份说明书。规矩参考作者另一个私用项目的接口说明「人格 md」一节。
// 每个 AI：data/<ai>/persona.md（正文）、data/<ai>/persona/（@ 引用的文件）、data/<ai>/persona.hist.json（最近 20 版旧的）。
// 开关在记忆库设置的 cfg.persona（默认关），只管网关带不带；她和 TA 改文件不看开关。
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './store.mjs';

const HIST_MAX = 20;
const DEPTH = 3;          // @ 最多套三层
const TA_MAX = 4000;      // TA 一次最多写这么多字
const WARN_AT = 8000;     // 展开后超过这么多字提醒一句
const WARN = '人格超过 8000 字了：每一场都会带上，越长越不照着做';
const NAME_RE = /^[A-Za-z0-9_\-.㐀-鿿]+$/;
// 行内或独占一行的 @名字.md；前面紧挨着字母数字（比如邮箱）的不算
const REF_RE = /(?<![A-Za-z0-9_.@])@([A-Za-z0-9_\-.㐀-鿿]+)/g;

// 引用文件的名字：字母数字中文下划线短横点，.md 结尾，不许斜杠、不许 ..
export function okName(name) {
  const n = String(name || '');
  return n.length <= 80 && NAME_RE.test(n) && !n.includes('..') && /^[^.].*\.md$/.test(n);
}
function checkName(name) {
  if (!okName(name)) throw fail(400, '文件名只能用字母、数字、中文、_ - .，以 .md 结尾，不能带斜杠和 ..');
  return String(name);
}

// 展开 @：read(名字) → 内容，找不到回 null。循环引用、超过三层的原样留着
export function expand(text, read, depth = 0, stack = new Set()) {
  return String(text).replace(REF_RE, (all, raw) => {
    const name = raw.replace(/\.+$/, ''), tail = raw.slice(name.length); // 句末的点不算名字
    if (!okName(name) || depth >= DEPTH || stack.has(name)) return all;
    const body = read(name);
    if (body == null) return all;
    return expand(body, read, depth + 1, new Set([...stack, name])) + tail;
  });
}

// 前后两版只留中间变了的那段（各截 200 字），给她看「改了哪句」
function diff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const cut = (s) => (s.length > 200 ? s.slice(0, 200) + '…' : s);
  return { old: cut(a.slice(i, a.length - j)), new: cut(b.slice(i, b.length - j)) };
}

export function openPersona({ store, now = store.now }) {
  const base = (ai) => store.folder(ai); // 顺带校验 AI 的名字
  const mdFile = (ai) => path.join(base(ai), 'persona.md');
  const subDir = (ai) => path.join(base(ai), 'persona');
  const histFile = (ai) => path.join(base(ai), 'persona.hist.json');

  function readOr(f, d) { try { return fs.readFileSync(f, 'utf8'); } catch { return d; } }
  function writeAtomic(f, s) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', s, { mode: 0o600 });
    fs.renameSync(f + '.tmp', f); // 先写旁边再换名
  }
  const raw = (ai) => readOr(mdFile(ai), '');
  const readFile = (ai, name) => (okName(name) ? readOr(path.join(subDir(ai), name), null) : null);
  function names(ai) {
    try { return fs.readdirSync(subDir(ai)).filter(okName).sort(); } catch { return []; }
  }
  const full = (ai) => expand(raw(ai), (n) => readFile(ai, n));
  function hist(ai) { try { return JSON.parse(readOr(histFile(ai), '[]')); } catch { return []; } }
  // 留一版：full 是改之前的全文；file 有值说明改的是那个引用文件
  function keep(ai, e) {
    const h = hist(ai);
    let t = now();
    if (h.length && t <= h.at(-1).t) t = h.at(-1).t + 1; // 同一毫秒改两次也分得开，退回时按 t 找
    h.push({ t, ...e });
    writeAtomic(histFile(ai), JSON.stringify(h.slice(-HIST_MAX)));
    return t;
  }

  const isOn = (ai) => store.getCfg(ai).persona;
  function view(ai) {
    const text = raw(ai), out = { on: isOn(ai), text, files: names(ai) };
    if (full(ai).length > WARN_AT) out.warn = WARN;
    return out;
  }
  function get(ai) {
    return { ...view(ai), hist: hist(ai).map(({ full: _, ...e }) => e).reverse() }; // 新的在前；全文不往外给
  }
  // 网关用：开着且不空才回展开后的全文，否则 ''
  function inject(ai) {
    if (!isOn(ai)) return '';
    const s = full(ai);
    return s.trim() ? s : '';
  }

  // 写正文，留一版。没变就不留
  function setText(ai, text, who, e = {}) {
    const old = raw(ai);
    if (text === old) return false;
    keep(ai, { who, ...(e.old !== undefined ? { old: e.old, new: e.new } : diff(old, text)), full: old });
    writeAtomic(mdFile(ai), text);
    return true;
  }

  // ---- 她（网页）改 ----
  function put(ai, { on, text } = {}, token) {
    if (text !== undefined) {
      if (typeof text !== 'string') throw fail(400, '人格要是一段文字');
      store.checkUnlock(ai, token);
    }
    if (on !== undefined) {
      const d = store.load(ai);
      d.cfg.persona = !!on;
      store.save(ai, d);
    }
    if (text !== undefined && setText(ai, text, 'me')) store.log(ai, { who: 'me', op: 'persona' });
    return view(ai);
  }
  function getFile(ai, name) {
    const s = readFile(ai, checkName(name));
    if (s == null) throw fail(404, '没有这个文件');
    return { name, text: s };
  }
  function putFile(ai, name, text, token) {
    checkName(name);
    if (typeof text !== 'string') throw fail(400, '内容要是一段文字');
    store.checkUnlock(ai, token);
    const f = path.join(subDir(ai), name), old = readOr(f, null);
    if (old === text) return { name, text };
    keep(ai, { who: 'me', file: name, ...diff(old || '', text), full: old });
    writeAtomic(f, text);
    store.log(ai, { who: 'me', op: 'persona-file' });
    return { name, text };
  }
  // 真删这个文件；旧的内容照样留一版，退得回来
  function delFile(ai, name, token) {
    checkName(name);
    store.checkUnlock(ai, token);
    const f = path.join(subDir(ai), name), old = readOr(f, null);
    if (old == null) throw fail(404, '没有这个文件');
    keep(ai, { who: 'me', file: name, old: '', new: '', full: old });
    fs.rmSync(f, { force: true });
    store.log(ai, { who: 'me', op: 'persona-file-del' });
    return { ok: true };
  }
  // 退回：回到 t 那一次改动之前的样子。退回本身也留一版
  function back(ai, t, token) {
    store.checkUnlock(ai, token);
    const e = hist(ai).find((x) => x.t === Number(t));
    if (!e) throw fail(404, '没有这一版');
    if (e.file) {
      const f = path.join(subDir(ai), e.file), cur = readOr(f, null);
      keep(ai, { who: 'me', file: e.file, back: e.t, ...diff(cur || '', e.full || ''), full: cur });
      if (e.full == null) fs.rmSync(f, { force: true }); else writeAtomic(f, e.full);
    } else {
      const cur = raw(ai);
      keep(ai, { who: 'me', back: e.t, ...diff(cur, e.full || ''), full: cur });
      writeAtomic(mdFile(ai), e.full || '');
    }
    store.log(ai, { who: 'me', op: 'persona-back' });
    return view(ai);
  }
  function exportMd(ai) {
    return { ai, t: now(), text: raw(ai), files: names(ai).map((n) => ({ name: n, text: readFile(ai, n) })) };
  }

  // ---- TA 在小记里改：{ old, new }。old 空 = 末尾另起一段 ----
  function edit(ai, p) {
    if (!p || typeof p !== 'object') throw fail(400, '改人格要写成 {"old":"…","new":"…"}');
    const o = typeof p.old === 'string' ? p.old : '', n = typeof p.new === 'string' ? p.new : '';
    if ([...n].length > TA_MAX) throw fail(400, `一次最多改 ${TA_MAX} 字`);
    const cur = raw(ai);
    let next;
    if (!o) {
      if (!n.trim()) throw fail(400, '要加进人格的内容是空的');
      next = cur.trim() ? cur.replace(/\s+$/, '') + '\n\n' + n : n;
    } else {
      const i = cur.indexOf(o);
      if (i < 0) throw fail(400, '人格里找不到要改的那句');
      if (cur.indexOf(o, i + 1) >= 0) throw fail(400, '那句不止一处，写长一点');
      next = cur.slice(0, i) + n + cur.slice(i + o.length);
    }
    setText(ai, next, 'ai', { old: o, new: n });
    store.log(ai, { who: 'ai', op: 'persona' }); // 不带内容
    return { kind: 'persona', op: 'edit' };
  }

  return { get, put, inject, full, raw, getFile, putFile, delFile, back, exportMd, edit, names };
}

// ---- 导入：只转不存 ----
const sub = (s, name, user) => String(s ?? '')
  .replace(/\{\{\s*char\s*\}\}|<BOT>/gi, name)
  .replace(/\{\{\s*user\s*\}\}|<USER>/gi, user);

// 一张酒馆角色卡（v1 / v2 / v3）→ { text, firstMes, skipped }。认不出回 null
export function cardToMd(o, { user = '她' } = {}) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const v2 = /^chara_card_v[23]$/.test(String(o.spec || '')) && o.data && typeof o.data === 'object';
  const c = v2 ? o.data : o;
  const name = String(c.name ?? c.char_name ?? '').trim();
  const pick = (...ks) => { for (const k of ks) if (typeof c[k] === 'string' && c[k].trim()) return c[k].trim(); return ''; };
  const fields = {
    desc: pick('description', 'char_persona'), pers: pick('personality'), scen: pick('scenario', 'world_scenario'),
    ex: pick('mes_example', 'example_dialogue'), first: pick('first_mes', 'char_greeting'),
  };
  if (!name || !(v2 || fields.desc || fields.pers || fields.first)) return null;
  const s = (t) => sub(t, name, user).trim();
  const extra = [pick('system_prompt'), pick('post_history_instructions')].filter(Boolean).map(s).join('\n\n');
  const parts = [`# ${name}`];
  for (const [h, t] of [['设定', fields.desc], ['性格', fields.pers], ['场景', fields.scen], ['说话的样子', fields.ex]]) if (t) parts.push(`## ${h}\n\n${s(t)}`);
  if (extra) parts.push(`## 另外的要求\n\n${extra}`);
  const firstMes = [fields.first, ...(Array.isArray(c.alternate_greetings) ? c.alternate_greetings : [])]
    .filter((x) => typeof x === 'string' && x.trim()).map(s);
  const book = c.character_book || o.character_book;
  const skipped = [];
  if (book && typeof book === 'object') {
    const n = Array.isArray(book.entries) ? book.entries.length : Object.keys(book.entries || {}).length;
    skipped.push(`世界书 ${n} 条`);
  }
  return { name, text: parts.join('\n\n') + '\n', firstMes, skipped };
}

// 带卡的 PNG：一块块走过去找 tEXt 里的 ccv3（先用）或 chara。不解压图像
export function pngCard(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw fail(400, '不是 PNG 图片');
  const found = {};
  let i = 8;
  while (i < buf.length) {
    if (i + 8 > buf.length) throw fail(400, 'PNG 的块长度不对，图可能坏了');
    const len = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8);
    if (i + 12 + len > buf.length) throw fail(400, 'PNG 的块长度不对，图可能坏了');
    if (type === 'tEXt') {
      const data = buf.subarray(i + 8, i + 8 + len), z = data.indexOf(0);
      if (z > 0) {
        const k = data.toString('latin1', 0, z);
        if (k === 'chara' || k === 'ccv3') found[k] = data.toString('latin1', z + 1);
      }
    }
    i += 12 + len;
    if (type === 'IEND') break;
  }
  const v = found.ccv3 ?? found.chara;
  if (v == null) throw fail(400, '这张图里没有角色卡（没找到 chara / ccv3）');
  try { return JSON.parse(Buffer.from(v, 'base64').toString('utf8')); } catch { throw fail(400, '图里的角色卡解不开'); }
}

// 导入：{ name, text } 或 { name, base64 }（PNG）。files 是一起传的引用文件（Claude Code 说明书 @ 的），只校验名字原样带回
export function importPersona(body = {}) {
  const name = String(body.name || ''), ext = (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] || '').toLowerCase();
  const user = typeof body.user === 'string' && body.user.trim() ? body.user.trim() : '她';
  const files = [];
  for (const f of Array.isArray(body.files) ? body.files : []) {
    if (!f || !okName(f.name) || typeof f.text !== 'string') throw fail(400, '一起传的文件名字不对：' + String(f?.name ?? '').slice(0, 40));
    files.push({ name: f.name, text: f.text });
  }
  const fromCard = (o) => {
    if (o && typeof o === 'object' && !o.name && !o.data && o.entries) throw fail(400, '这是世界书，不是角色卡，现在不转');
    const c = cardToMd(o, { user });
    if (!c) throw fail(400, '认不出这个 JSON：不是酒馆角色卡');
    const out = { text: c.text, files, firstMes: c.firstMes };
    if (c.skipped.length) out.skipped = c.skipped;
    return out;
  };
  if (ext === 'png' || (body.base64 !== undefined && !ext)) {
    if (typeof body.base64 !== 'string') throw fail(400, 'PNG 要用 base64 传');
    return fromCard(pngCard(Buffer.from(body.base64, 'base64')));
  }
  if (typeof body.text !== 'string') throw fail(400, '要传 text（文字）或 base64（PNG）');
  if (ext === 'md' || ext === 'txt' || ext === 'markdown') return { text: body.text, files };
  if (ext === 'json') {
    let o;
    try { o = JSON.parse(body.text); } catch { throw fail(400, '这个 JSON 坏了，解不开'); }
    return fromCard(o);
  }
  throw fail(400, '认不出这种文件：只认 .md、.txt、角色卡 .json 和 .png');
}
