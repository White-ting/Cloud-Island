// 她发的图和文件（11-17，接后端清单第 4 批）。存在 data/files/<编号>.<后缀>，旁边一份 <编号>.json（原名、大小、种类、时间）。
// 收：POST /api/upload?name=原名，请求体就是文件本身（不是 multipart，手机上好算进度）。看文件头认种类，后缀不算数。
// 发：GET /api/file/<编号>。只发这个文件夹里、编号对得上的；图、PDF、声音在网页里直接打开，别的下载。
// 聊天里图片写成 /api/file/<编号>，发给模型时由 dataUrl() 换成 base64。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './store.mjs';

const MB = 1024 * 1024;
// [种类, 后缀, 类型, 上限, 认头的办法]
const SNIFF = [
  ['img', 'jpg', 'image/jpeg', 8 * MB, (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['img', 'png', 'image/png', 8 * MB, (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['img', 'gif', 'image/gif', 8 * MB, (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  ['img', 'webp', 'image/webp', 8 * MB, (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  ['img', 'heic', 'image/heic', 8 * MB, (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|mif1|msf1)$/.test(b.subarray(8, 12).toString('latin1'))],
  ['file', 'pdf', 'application/pdf', 20 * MB, (b) => b.subarray(0, 5).toString('latin1') === '%PDF-'],
  ['file', 'zip', 'application/zip', 55 * MB, (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04],
  ['audio', 'm4a', 'audio/mp4', 55 * MB, (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(M4A |mp42|isom|M4B )$/.test(b.subarray(8, 12).toString('latin1'))],
  ['audio', 'mp3', 'audio/mpeg', 55 * MB, (b) => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)],
  ['audio', 'webm', 'audio/webm', 55 * MB, (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3],
  ['audio', 'wav', 'audio/wav', 55 * MB, (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE'],
  ['audio', 'ogg', 'audio/ogg', 55 * MB, (b) => b.subarray(0, 4).toString('latin1') === 'OggS'],
];
// 录音（/api/voice/stt 收的）认不出牌子但是 mp4 容器的：当 m4a（各家浏览器录出来的 mp4 牌子不一样）
const M4A = { kind: 'audio', ext: 'm4a', mime: 'audio/mp4', max: 55 * MB };
const TEXT_EXT = { txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv' };
const MAX = 55 * MB;
const ID_RE = /^f[a-z0-9]{12,20}$/;

function sniff(buf, name) {
  for (const [kind, ext, mime, max, ok] of SNIFF) if (buf.length >= 12 && ok(buf)) return { kind, ext, mime, max };
  const ext = (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();
  if (TEXT_EXT[ext]) {
    const s = buf.toString('utf8');
    if (!s.includes('�') && !/[\x00-\x08\x0e-\x1f]/.test(s.slice(0, 4096))) return { kind: 'file', ext, mime: TEXT_EXT[ext] + '; charset=utf-8', max: 20 * MB };
  }
  return null;
}
const cleanName = (s) => String(s || '').replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').trim().slice(0, 120) || '文件';

export function openFiles({ dir, now = Date.now }) {
  const base = () => path.join(dir, 'files');
  const metaOf = (id) => { try { return JSON.parse(fs.readFileSync(path.join(base(), id + '.json'), 'utf8')); } catch { return null; } };
  // 收一个已经在手里的（录音这种）：opts.audio 只收录音。回 { id, url, name, size, kind }
  function saveBuf(buf, name, opts = {}) {
    if (!buf?.length) throw fail(400, '是空的');
    let t = sniff(buf, name);
    if (opts.audio && t?.kind !== 'audio' && buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') t = M4A;
    if (!t || (opts.audio && t.kind !== 'audio')) throw fail(415, opts.audio ? '认不出这段录音（收 webm、m4a/mp4、mp3、wav、ogg）' : '认不出这是什么文件（收图片、PDF、zip、txt/md/json/csv、m4a/mp3/webm）');
    if (buf.length > t.max) throw fail(413, `这种文件最大 ${t.max / MB} MB`);
    const id = 'f' + now().toString(36) + crypto.randomBytes(4).toString('hex');
    fs.mkdirSync(base(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(base(), `${id}.${t.ext}`), buf, { mode: 0o600 });
    const meta = { id, name: cleanName(name), size: buf.length, kind: t.kind, ext: t.ext, mime: t.mime, t: now() };
    fs.writeFileSync(path.join(base(), id + '.json'), JSON.stringify(meta), { mode: 0o600 });
    return pub(meta);
  }
  // 收一个：边收边数，超过上限马上停
  function save(req, name) {
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0, done = false;
      const bad = (e) => { if (done) return; done = true; reject(e); req.destroy(); };
      req.on('data', (c) => { n += c.length; if (n > MAX) bad(fail(413, '文件太大了（最大 55 MB）')); else chunks.push(c); });
      req.on('error', (e) => bad(e));
      req.on('end', () => {
        if (done) return; done = true;
        try { resolve(saveBuf(Buffer.concat(chunks), name)); } catch (e) { reject(e); }
      });
    });
  }
  const pub = (m) => ({ id: m.id, url: '/api/file/' + m.id, name: m.name, size: m.size, kind: m.kind });
  function get(id) {
    if (!ID_RE.test(String(id))) throw fail(404, '没有这个文件');
    const m = metaOf(id); if (!m) throw fail(404, '没有这个文件');
    const f = path.join(base(), `${m.id}.${m.ext}`);
    if (!fs.existsSync(f)) throw fail(404, '没有这个文件');
    return { file: f, meta: m };
  }
  // 发给模型用：/api/file/<编号> 的图换成 data:；不是图、找不到的回 null
  function dataUrl(u) {
    const id = /^\/api\/file\/([a-z0-9]+)$/.exec(String(u))?.[1];
    if (!id) return null;
    try { const { file, meta } = get(id); if (meta.kind !== 'img') return null; return `data:${meta.mime};base64,` + fs.readFileSync(file).toString('base64'); } catch { return null; }
  }
  return { save, saveBuf, get, dataUrl };
}
