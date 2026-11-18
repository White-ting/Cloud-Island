// 她传的图和文件：认文件头不认后缀、有上限、只发编号对得上的、聊天里的图发给模型时换成 base64
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../lib/store.mjs';
import { createServer } from '../lib/server.mjs';
import { openFiles } from '../lib/files.mjs';
import { openChat } from '../lib/chat.mjs';

const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-files-')); dirs.push(dir);
  const seen = [];
  const up = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seen.push(JSON.parse(b)); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '看到了。' } }] }) + '\n\ndata: [DONE]\n\n'); }); });
  await new Promise((ok) => up.listen(0, '127.0.0.1', ok));
  fs.writeFileSync(path.join(dir, 'ais.json'), JSON.stringify([{ id: 'a', model: 'm', style: 'openai', url: `http://127.0.0.1:${up.address().port}` }]));
  const store = openStore({ dir }), files = openFiles({ dir });
  const chat = openChat({ dir, store, files });
  const srv = createServer({ cfg: { port: 0, hookToken: 'x' }, store, files, chat, hooks: null });
  const addr = await srv.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  return { dir, base, seen, close: async () => { await srv.close(); up.close(); } };
}

test('传图传文件：认文件头、上限、发回来、乱编号 404；聊天里的图发给模型时换成 base64', async () => {
  const g = await setup();
  try {
    let r = await fetch(g.base + '/api/upload?name=' + encodeURIComponent('猫.jpg'), { method: 'POST', body: PNG });
    const img = await r.json();
    assert.equal(r.status, 200);
    assert.deepEqual([img.kind, img.name, img.size], ['img', '猫.jpg', PNG.length]); // 后缀写 jpg，实际是 png：按文件头认
    r = await fetch(g.base + img.url);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(PNG));
    assert.equal(fs.statSync(path.join(g.dir, 'files', img.id + '.png')).mode & 0o777, 0o600);

    r = await fetch(g.base + '/api/upload?name=a.md', { method: 'POST', body: '# 标题\n正文' });
    const md = await r.json();
    assert.deepEqual([r.status, md.kind], [200, 'file']);
    r = await fetch(g.base + md.url);
    assert.match(r.headers.get('content-disposition'), /^attachment/);

    assert.equal((await fetch(g.base + '/api/upload?name=x.exe', { method: 'POST', body: Buffer.from('MZ\x90\x00 not a thing we take') })).status, 415);
    assert.equal((await fetch(g.base + '/api/upload?name=a.txt', { method: 'POST', body: '' })).status, 400);
    assert.equal((await fetch(g.base + '/api/upload?name=big.png', { method: 'POST', body: Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]) })).status, 413);
    assert.equal((await fetch(g.base + '/api/file/..%2Fais.json')).status, 404);
    assert.equal((await fetch(g.base + '/api/file/fnotthere0000')).status, 404);

    r = await fetch(g.base + '/api/chat/a/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '看这张', img: [img.url] }) });
    await r.text();
    const sent = JSON.stringify(g.seen.at(-1));
    assert.ok(sent.includes('data:image/png;base64,' + PNG.toString('base64')));
    const items = (await (await fetch(g.base + '/api/chat/a')).json()).items;
    assert.deepEqual(items[0].img, [img.url]); // 存的还是地址，不是 base64
    r = await fetch(g.base + '/api/chat/a/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '', files: [{ url: md.url, name: '乱写的名字' }] }) });
    await r.text();
    assert.ok(JSON.stringify(g.seen.at(-1)).includes('她发了一个文件：a.md'));
    const last = (await (await fetch(g.base + '/api/chat/a')).json()).items.filter((m) => m.role === 'me').at(-1);
    assert.deepEqual(last.files, [{ url: md.url, name: 'a.md', size: md.size, kind: 'file' }]); // 名字以后端存的为准
    assert.equal((await fetch(g.base + '/api/chat/a/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: ['https://x.com/a.pdf'] }) })).status, 400);
  } finally { await g.close(); }
});
