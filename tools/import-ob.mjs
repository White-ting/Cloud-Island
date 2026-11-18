#!/usr/bin/env node
// 把 Ombre Brain（原版 https://github.com/P0luz/Ombre-Brain，main 分支 3.6.14）的记忆库文件夹
// 转成我们 POST /api/memory/{ai}/import 收的 {items:[…]}。只读源文件夹，绝不写它；不往后端发。
// 用法见 tools/import-ob.说明.md。零依赖。
//
// 原版的存储（照 src/bucket_manager.py）：一个桶 = 一个 .md，开头是 YAML 头（python-frontmatter + PyYAML 写的），
// 放在数据目录的 permanent/ dynamic/ feel/ plans/ letters/ archive/ 下（再往下按主题域或状态分子文件夹）。
// 同一个数据目录里还有 config.yaml、_app（程序本身）、_media、embeddings.db，这些都不碰。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BUCKET_DIRS = ['permanent', 'dynamic', 'feel', 'plans', 'letters', 'archive'];
export const LONG = 4000;               // 超过这么多字提醒可能要拆
export const PART_BYTES = 900 * 1024;   // 后端一次最多收 1 MB，超了就分成几个文件
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/; // 跟 lib/store.mjs 里 AI 名字的规矩一样
// 一对一搬进我们字段的，不再放进 ob；其余全部原样进 ob
const MAPPED = new Set(['id', 'tags', 'why_remembered', 'created', 'last_active', 'activation_count']);
const PACT_ST = { resolved: '做到了', abandoned: '不作数了', active: '还作数' };

// ---------------- YAML 头：只认原版实际写出来的那几种写法 ----------------
// 标量、单双引号（含跨行折叠）、行内列表/对象、短横列表（含列表里套键值）、| 和 > 多行。
// 认不出的写法（锚点、别名、!!标签……）原样当字符串留着；连「键: 值」都不是的行才算读不懂。
class YamlError extends Error {}

function scalar(s) {
  const t = s.trim();
  if (t === '' || t === '~' || /^(null|Null|NULL)$/.test(t)) return null;
  if (/^(true|True|TRUE|yes|Yes|YES|on|On|ON)$/.test(t)) return true; // PyYAML 是 YAML 1.1，yes/on 也算真
  if (/^(false|False|FALSE|no|No|NO|off|Off|OFF)$/.test(t)) return false;
  if (/^[-+]?(0|[1-9][0-9_]*)$/.test(t)) return Number(t.replace(/_/g, ''));
  if (/^[-+]?(\.[0-9]+|[0-9][0-9_]*(\.[0-9_]*)?)([eE][-+]?[0-9]+)?$/.test(t)) return Number(t.replace(/_/g, ''));
  if (/^[-+]?\.(inf|Inf|INF)$/.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(t)) return NaN;
  return t;
}

// 跨行的引号串、普通串：换行折成空格，空行变成真换行
function fold(lines, dq) {
  let out = '', gap = 0, glue = ' ';
  for (let k = 0; k < lines.length; k++) {
    const last = k === lines.length - 1;
    let l = k > 0 ? lines[k].trimStart() : lines[k], next = ' ';
    if (!last) {
      l = l.trimEnd();
      if (dq && /(^|[^\\])(\\\\)*\\$/.test(l)) { l = l.slice(0, -1); next = ''; } // 行尾一个反斜杠：直接接上，不加空格
    }
    if (k > 0 && !last && l === '') { gap++; continue; }
    if (k > 0) out += gap ? '\n'.repeat(gap) : glue;
    out += l;
    gap = 0;
    glue = next;
  }
  return out;
}

const ESC = { 0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' };
function unescapeDq(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (m, c) => {
    if (c.length > 1) return String.fromCodePoint(parseInt(c.slice(1), 16));
    return c in ESC ? ESC[c] : m;
  });
}

function parseYaml(src) {
  const lines = src.split('\n').map((l) => l.replace(/\r$/, ''));
  let i = 0;
  const indOf = (l) => l.match(/^ */)[0].length;
  const blank = (l) => /^\s*(#.*)?$/.test(l);
  const skip = () => { while (i < lines.length && blank(lines[i])) i++; };

  // 引号串：从 rest 开头的引号读到配对的引号，可能跨好几行
  function quoted(rest) {
    const q = rest[0], dq = q === '"';
    const parts = [];
    let cur = rest.slice(1);
    for (;;) {
      let j = 0, end = -1;
      while (j < cur.length) {
        if (dq && cur[j] === '\\') { j += 2; continue; }
        if (cur[j] === q) {
          if (!dq && cur[j + 1] === "'") { j += 2; continue; }
          end = j; break;
        }
        j++;
      }
      if (end >= 0) {
        parts.push(cur.slice(0, end));
        const tail = cur.slice(end + 1).trim();
        if (tail && !tail.startsWith('#')) throw new YamlError('引号后面还有东西');
        break;
      }
      parts.push(cur);
      i++;
      if (i >= lines.length) throw new YamlError('引号没有收尾');
      cur = lines[i];
    }
    i++;
    const s = fold(parts, dq);
    return dq ? unescapeDq(s) : s.replace(/''/g, "'");
  }

  // 行内的 [a, b] / {k: v}，可能跨行
  function flow(rest) {
    let buf = rest, depth = 0, inQ = null;
    const balanced = () => {
      depth = 0; inQ = null;
      for (let j = 0; j < buf.length; j++) {
        const c = buf[j];
        if (inQ) { if (c === '\\' && inQ === '"') j++; else if (c === inQ) inQ = null; continue; }
        if (c === '"' || c === "'") inQ = c;
        else if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') depth--;
      }
      return depth <= 0;
    };
    while (!balanced()) { i++; if (i >= lines.length) throw new YamlError('括号没有收尾'); buf += ' ' + lines[i].trim(); }
    i++;
    let p = 0;
    const ws = () => { while (p < buf.length && /\s/.test(buf[p])) p++; };
    function val() {
      ws();
      const c = buf[p];
      if (c === '[') {
        p++; const a = [];
        for (;;) { ws(); if (buf[p] === ']') { p++; return a; } a.push(val()); ws(); if (buf[p] === ',') p++; else if (buf[p] === ']') { p++; return a; } else throw new YamlError('列表写法不对'); }
      }
      if (c === '{') {
        p++; const o = {};
        for (;;) {
          ws(); if (buf[p] === '}') { p++; return o; }
          const k = val(); ws();
          let v = null;
          if (buf[p] === ':') { p++; v = val(); ws(); }
          o[String(k)] = v;
          if (buf[p] === ',') p++; else if (buf[p] === '}') { p++; return o; } else throw new YamlError('对象写法不对');
        }
      }
      if (c === '"' || c === "'") {
        let j = p + 1;
        while (j < buf.length) { if (c === '"' && buf[j] === '\\') { j += 2; continue; } if (buf[j] === c) { if (c === "'" && buf[j + 1] === "'") { j += 2; continue; } break; } j++; }
        const raw = buf.slice(p + 1, j); p = j + 1;
        return c === '"' ? unescapeDq(raw) : raw.replace(/''/g, "'");
      }
      let j = p;
      while (j < buf.length && !/[,\]}]/.test(buf[j]) && !(buf[j] === ':' && /\s|$/.test(buf[j + 1] || ''))) j++;
      const raw = buf.slice(p, j); p = j;
      return scalar(raw);
    }
    const v = val();
    ws();
    if (p < buf.length && !buf.slice(p).trim().startsWith('#')) throw new YamlError('括号后面还有东西');
    return v;
  }

  // | 或 > 开头的多行串
  function block(head, n) {
    const m = head.match(/^([|>])([+-]?)([1-9]?)([+-]?)\s*(#.*)?$/);
    if (!m) throw new YamlError('多行串的写法不对');
    const style = m[1], chomp = m[2] || m[4], explicit = m[3] ? Number(m[3]) : 0;
    i++;
    const body = [];
    let bi = explicit ? n + explicit : 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) { body.push(''); i++; continue; }
      const k = indOf(l);
      if (!bi) { if (k <= n) break; bi = k; }
      if (k < bi) break;
      body.push(l.slice(bi));
      i++;
    }
    let trail = 0;
    while (body.length && body[body.length - 1] === '') { body.pop(); trail++; }
    let s;
    if (style === '|') s = body.join('\n');
    else { // > 折叠：相邻的普通行折成空格，隔着空行的变成换行，缩进更深的行原样保留换行
      s = '';
      let empty = 0, prev = null;
      for (const l of body) {
        if (l === '') { empty++; continue; }
        const kind = /^\s/.test(l) ? 'deep' : 'flat';
        if (prev === null) s += '\n'.repeat(empty) + l;
        else if (prev === 'flat' && kind === 'flat') s += (empty ? '\n'.repeat(empty) : ' ') + l;
        else s += '\n'.repeat(empty + 1) + l;
        empty = 0;
        prev = kind;
      }
    }
    if (chomp === '-' || !body.length) return s;
    return s + (chomp === '+' ? '\n'.repeat(trail + 1) : '\n');
  }

  // 一个值：rest 是同一行冒号或短横后面的部分，n 是它所属那一层的缩进（续行要比它深）
  function value(rest, n) {
    const r = rest.trim();
    if (r === '' || r.startsWith('#')) {
      i++; skip();
      if (i >= lines.length) return null;
      const k = indOf(lines[i]);
      if (k > n) return node(k);
      if (k === n && /^-(\s|$)/.test(lines[i].slice(n))) return seq(n); // PyYAML 的短横列表跟键对齐
      return null;
    }
    if (r[0] === '"' || r[0] === "'") return quoted(r);
    if (r[0] === '[' || r[0] === '{') return flow(r);
    if (r[0] === '|' || r[0] === '>') return block(r, n);
    // 普通串：后面缩进更深的行都是它的续行
    const parts = [r.replace(/\s+#.*$/, '')];
    i++;
    while (i < lines.length && (/^\s*$/.test(lines[i]) || indOf(lines[i]) > n)) {
      if (/^\s*$/.test(lines[i])) { let j = i; while (j < lines.length && /^\s*$/.test(lines[j])) j++; if (j >= lines.length || indOf(lines[j]) <= n) break; }
      parts.push(lines[i].replace(/\s+#.*$/, ''));
      i++;
    }
    if (parts.length > 1) { parts.push(parts.pop()); return fold(parts.map((x) => x.trim()), false); }
    return scalar(parts[0]);
  }

  const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\-?:[\]{}][^:]*?|-[^\s:][^:]*?)\s*:(?=\s|$)(.*)$/;
  function map(n) {
    const o = {};
    for (;;) {
      skip();
      if (i >= lines.length) return o;
      const l = lines[i], k = indOf(l);
      if (k < n) return o;
      if (k > n) throw new YamlError('缩进不对');
      const m = l.slice(n).match(KEY);
      if (!m) {
        if (/^-(\s|$)/.test(l.slice(n))) return o; // 跟父级键对齐的短横列表，交回去
        throw new YamlError('这一行不是「键: 值」');
      }
      let key = m[1];
      if (key[0] === '"') key = unescapeDq(key.slice(1, -1));
      else if (key[0] === "'") key = key.slice(1, -1).replace(/''/g, "'");
      o[key] = value(m[2], n);
    }
  }
  function seq(n) {
    const a = [];
    for (;;) {
      skip();
      if (i >= lines.length) return a;
      const l = lines[i];
      if (indOf(l) !== n || !/^-(\s|$)/.test(l.slice(n))) return a;
      const after = l.slice(n + 1);
      const sp = after.match(/^ */)[0].length;
      const rest = after.slice(sp);
      const c = n + 1 + sp; // 短横后面那段内容的缩进
      if (rest && (/^-(\s|$)/.test(rest) || (KEY.test(rest) && !/^["'[{|>]/.test(rest)))) {
        lines[i] = ' '.repeat(c) + rest; // 「- 键: 值」= 一个对象，第一个键在短横后面
        a.push(node(c));
      } else a.push(value(rest, n));
    }
  }
  function node(k) {
    skip();
    return /^-(\s|$)/.test(lines[i].slice(k)) ? seq(k) : map(k);
  }

  skip();
  if (i >= lines.length) return {};
  const root = node(indOf(lines[i]));
  skip();
  if (i < lines.length) throw new YamlError('后面还有读不懂的行');
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new YamlError('YAML 头不是键值');
  return root;
}
export { parseYaml };

// 一个 .md：拆成 YAML 头和正文（照 python-frontmatter：第一行 --- 开头，到下一行 --- 为止）
export function splitFront(text) {
  const lines = text.replace(/^﻿/, '').split('\n');
  const fence = (l) => /^---[ \t]*\r?$/.test(l);
  if (!fence(lines[0])) return { meta: {}, body: lines.join('\n') }; // 没有头：原版也认，编号取文件名
  const end = lines.findIndex((l, k) => k > 0 && fence(l));
  if (end < 0) throw new YamlError('YAML 头没收尾');
  return { meta: parseYaml(lines.slice(1, end).join('\n')), body: lines.slice(end + 1).join('\n') };
}

// ---------------- 字段对应 ----------------
const truthy = (v) => v === true || v === 1 || (typeof v === 'string' && /^(true|yes|on|1)$/i.test(v.trim()));
function ms(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? v : v * 1000;
  const t = Date.parse(String(v).trim().replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [v]);
const isLetter = (meta, top) => top === 'letters' || String(meta.type || '').trim().toLowerCase() === 'letter'
  || String(meta.source_tool || '').trim().toLowerCase() === 'letter'
  || list(meta.tags).some((x) => String(x).trim().toLowerCase() === '__letter__');

// 归档以后原版把 type 改成了 archived，原来是哪种丢了：从留下的字段猜
function kindOf(meta) {
  let type = String(meta.type || '').trim().toLowerCase();
  if (type === 'archived') {
    if (meta.status != null || meta.change_log != null) type = 'plan';
    else if (/^feel_/.test(String(meta.id || ''))) type = 'feel';
    else if (meta.i_from_candidate != null) type = 'i';
  }
  if (type === 'feel') return 'exp';
  if (type === 'plan') return 'pact';
  if (type === 'i' || type === 'self') return 'view';
  return 'note';
}

// 一个桶 → 一条记录。返回 null 时 why 说明为什么不转
export function toItem(meta, body, { stem, archived, mtime }) {
  const text = String(body ?? '').trim();
  if (!text) return { skip: '正文是空的' };
  const rawId = String(meta.id ?? stem).trim();
  const kind = kindOf(meta);
  const m = { id: 'ob-' + rawId, t: ms(meta.created) ?? mtime, by: 'ai', kind, text };
  const kw = list(meta.tags).map((x) => String(x).trim()).filter(Boolean);
  if (kw.length) m.kw = kw;
  if (meta.why_remembered != null && String(meta.why_remembered).trim()) m.why = String(meta.why_remembered).trim();
  if (truthy(meta.pinned) || truthy(meta.anchor) || truthy(meta.protected)) m.pin = true;
  const src = list(meta.quotes).map((q) => {
    if (q && typeof q === 'object') { const t = String(q.text ?? '').trim(); return t && q.speaker ? `${q.speaker}：${t}` : t; }
    return String(q ?? '').trim();
  }).filter(Boolean);
  if (src.length) m.src = src.join('\n');
  const used = Number(meta.activation_count);
  if (Number.isFinite(used) && used > 0) m.used = Math.round(used);
  const usedAt = ms(meta.last_active);
  if (usedAt != null) m.usedAt = usedAt;
  if (kind === 'pact') {
    const status = String(meta.status || '').trim().toLowerCase();
    m.st = truthy(meta.resolved) ? PACT_ST.resolved : PACT_ST[status] || PACT_ST.active;
  }
  if (archived) m.gone = usedAt ?? mtime;
  const ob = {};
  for (const [k, v] of Object.entries(meta)) if (!MAPPED.has(k)) ob[k] = v;
  if (meta.id == null) ob.file = stem; // 没写编号的旧桶，原版拿文件名当编号
  if (Object.keys(ob).length) m.ob = ob;
  return { item: m, rawId };
}

// ---------------- 走一遍文件夹 ----------------
function* walk(dir, rel = '') {
  let ents;
  try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { yield { rel, err: '读不了' }; return; }
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of ents) {
    if (e.name.startsWith('.')) continue; // .DS_Store、._ 开头的 mac 垃圾、.obsidian 之类
    const r = path.join(rel, e.name);
    if (e.isSymbolicLink()) { if (e.name.endsWith('.md')) yield { rel: r, err: '是快捷方式（符号链接）' }; continue; }
    if (e.isDirectory()) yield* walk(dir, r);
    else if (e.isFile() && e.name.endsWith('.md')) yield { rel: r };
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function convert(src, { ai } = {}) {
  const root = path.resolve(src);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('找不到这个文件夹：' + src);
  const tops = BUCKET_DIRS.filter((d) => fs.existsSync(path.join(root, d)) && fs.statSync(path.join(root, d)).isDirectory());
  if (!tops.length) throw new Error(`这个文件夹里没有 ${BUCKET_DIRS.join(' / ')} 这些子文件夹，是不是选错了？要选的是装着它们的那一层（Ombre Brain 的数据目录，通常叫 buckets）。`);
  const r = { files: 0, kinds: { note: 0, pact: 0, view: 0, exp: 0 }, archived: 0, letters: 0, skipped: {}, longest: 0, over: 0, out: 0 };
  const skip = (why) => { r.skipped[why] = (r.skipped[why] || 0) + 1; };
  const items = [], seen = new Set();
  for (const top of tops) {
    for (const f of walk(path.join(root, top))) {
      r.files++;
      if (f.err) { skip(f.err); continue; }
      const full = path.join(root, top, f.rel);
      let text, mtime;
      try {
        const buf = fs.readFileSync(full);
        mtime = Math.round(fs.statSync(full).mtimeMs);
        try { text = utf8.decode(buf); } catch { skip('不是 UTF-8 文字'); continue; }
      } catch { skip('读不了'); continue; }
      let meta, body;
      try { ({ meta, body } = splitFront(text)); } catch (e) { // 什么错都只算这一个文件坏了，不中断
        skip(e instanceof YamlError && e.message === 'YAML 头没收尾' ? 'YAML 头没收尾' : 'YAML 头读不懂');
        continue;
      }
      if (isLetter(meta, top)) { r.letters++; continue; }
      const archived = top === 'archive' || String(meta.type || '').trim().toLowerCase() === 'archived';
      const { item, rawId, skip: why } = toItem(meta, body, { stem: path.basename(f.rel, '.md'), archived, mtime });
      if (why) { skip(why); continue; }
      if (seen.has(rawId)) { skip('编号重复（同一条存了两份）'); continue; }
      seen.add(rawId);
      items.push(item);
      r.kinds[item.kind]++;
      if (item.gone) r.archived++;
      const n = [...item.text].length;
      r.longest = Math.max(r.longest, n);
      if (n > LONG) r.over++;
    }
  }
  r.out = items.length;
  const data = { from: 'ombre-brain', ...(ai ? { ai } : {}), items };
  return { data, report: r };
}

// 超过后端一次能收的大小就分成几份；同一条只在一份里，重复导入同一份也不会多出来（后端按编号去重）
export function split(data, max = PART_BYTES) {
  const head = { ...data, items: [] };
  const base = Buffer.byteLength(JSON.stringify(head));
  const parts = [];
  let cur = [], size = base;
  for (const m of data.items) {
    const n = Buffer.byteLength(JSON.stringify(m)) + 1;
    if (cur.length && size + n > max) { parts.push(cur); cur = []; size = base; }
    cur.push(m); size += n;
  }
  if (cur.length || !parts.length) parts.push(cur);
  return parts.map((items) => ({ ...head, items }));
}

const KIND_ZH = { note: '记事', exp: '经验（原来的 feel）', pact: '约定（原来的 plan）', view: '看法（原来的 I）' };
export function formatReport(r, { written = [], dry = false, ai } = {}) {
  const L = [];
  L.push('Ombre Brain → 记忆库 转换报告（只有数，不含任何正文）');
  L.push(`一共读到 ${r.files} 个 .md 文件`);
  L.push(`转出 ${r.out} 条：`);
  for (const k of ['note', 'exp', 'pact', 'view']) L.push(`  ${KIND_ZH[k]}：${r.kinds[k]}`);
  L.push(`  其中归档的：${r.archived}（带着归档时间）`);
  L.push(`信没转：${r.letters}`);
  const sk = Object.entries(r.skipped);
  L.push(`跳过：${sk.reduce((a, [, n]) => a + n, 0)}`);
  for (const [why, n] of sk) L.push(`  ${why}：${n}`);
  L.push(`最长的一条：${r.longest} 字`);
  L.push(`超过 ${LONG} 字的：${r.over} 条${r.over ? '（太长的可能要拆开，召回时才好用）' : ''}`);
  if (dry) L.push('这次是 --dry：只看数，没写文件。');
  else {
    if (written.length > 1) L.push(`太大了一次传不完，分成了 ${written.length} 个文件，按顺序一个一个导入：`);
    else L.push('写到了：');
    for (const w of written) L.push(`  ${w.file}（${w.n} 条，${Math.ceil(w.bytes / 1024)} KB）`);
    L.push(`导入地址：POST /api/memory/${ai || '你的AI名字'}/import`);
  }
  return L.join('\n');
}

function usage() {
  return '用法：node tools/import-ob.mjs <Ombre Brain 的 buckets 文件夹> [--out 文件.json] [--ai 名字] [--dry]';
}

export function main(argv) {
  const opts = { out: 'ob-import.json', ai: null, dry: false };
  let src = null;
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--dry') opts.dry = true;
    else if (a === '--out' || a === '--ai') { const v = argv[++k]; if (!v) throw new Error(`${a} 后面要跟一个值\n` + usage()); opts[a.slice(2)] = v; }
    else if (a === '-h' || a === '--help') { console.log(usage()); return 0; }
    else if (a.startsWith('-')) throw new Error('不认识的参数：' + a + '\n' + usage());
    else if (src) throw new Error('只能给一个文件夹\n' + usage());
    else src = a;
  }
  if (!src) throw new Error(usage());
  if (opts.ai && !NAME_RE.test(opts.ai)) throw new Error('--ai 的名字只能是字母、数字、- 和 _');
  const root = fs.realpathSync(path.resolve(src));
  const out = path.resolve(opts.out);
  const outDir = fs.existsSync(path.dirname(out)) ? fs.realpathSync(path.dirname(out)) : path.dirname(out);
  if (!opts.dry && (outDir + path.sep).startsWith(root + path.sep)) throw new Error('--out 不能放在 Ombre Brain 的文件夹里面（这个脚本不往源文件夹写任何东西）');
  const { data, report } = convert(root, { ai: opts.ai });
  const written = [];
  if (!opts.dry) {
    const parts = split(data);
    const name = (k) => (parts.length === 1 ? out : out.replace(/(\.json)?$/i, `.${k + 1}.json`));
    parts.forEach((p, k) => {
      const s = JSON.stringify(p);
      fs.writeFileSync(name(k), s, { mode: 0o600 }); // 里面是全部记忆，只给自己看
      written.push({ file: name(k), n: p.items.length, bytes: Buffer.byteLength(s) });
    });
  }
  console.log(formatReport(report, { written, dry: opts.dry, ai: opts.ai }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 2; }
}
