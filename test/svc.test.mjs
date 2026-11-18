// 设置里要填的服务：存得进、读出来不带 Key、文件 600、留空不换、null 清掉、乱填报人话
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { createServer } from '../lib/server.mjs';
import { openSvc } from '../lib/svc.mjs';

const KEY = 'sk-SEKRIT-abcdef123456-WXYZ';
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-svc-')); dirs.push(dir);
  const store = openStore({ dir }), svc = openSvc({ dir });
  const srv = createServer({ cfg: { port: 0, hookToken: 'x' }, store, svc, hooks: null });
  const addr = await srv.listen();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${addr.port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { dir, call, close: () => srv.close() };
}

test('设置里的服务：Key 只进不出，留空不换，null 清掉，文件 600', async () => {
  const g = await setup();
  try {
    let r = await g.call('PUT', '/api/svc/fm/tts', { prov: 0, url: 'https://api.elevenlabs.io/v1/', model: 'eleven_v4', key: KEY, voices: { 0: { id: 'v1', speed: 3 } } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.hasKey, r.body.keyTail, r.body.url, r.body.voices['0'].speed], [true, 'WXYZ', 'https://api.elevenlabs.io/v1', 2]);
    r = await g.call('PUT', '/api/svc/fm/tts', { model: 'eleven_v3', key: '' });
    assert.deepEqual([r.body.hasKey, r.body.model], [true, 'eleven_v3']);
    r = await g.call('PUT', '/api/svc/push', { route: 'bark', bark: { dev: 'DEVKEY123456789', aes: 'a'.repeat(32) } });
    assert.deepEqual(r.body, { route: 'bark', bark: { url: 'https://api.day.app', hasDev: true, hasAes: true } });
    assert.equal((await g.call('PUT', '/api/svc/push', { bark: { aes: 'short' } })).status, 400);
    assert.deepEqual((await g.call('PUT', '/api/svc/opts', { callSvc: 'own', asrWords: '阿岛, 小满' })).body, { callSvc: 'own', asrWords: '阿岛, 小满' });
    const all = await g.call('GET', '/api/svc');
    assert.ok(!JSON.stringify(all.body).includes(KEY) && !JSON.stringify(all.body).includes('DEVKEY'));
    assert.equal(all.body.callSvc, 'own');
    const st = fs.statSync(path.join(g.dir, 'svc.json'));
    assert.equal(st.mode & 0o777, 0o600);
    assert.ok(fs.readFileSync(path.join(g.dir, 'svc.json'), 'utf8').includes(KEY)); // 后端自己要用，文件里是有的
    r = await g.call('PUT', '/api/svc/fm/tts', { key: null });
    assert.equal(r.body.hasKey, false);
    assert.equal((await g.call('PUT', '/api/svc/fm/nope', {})).status, 404);
    assert.equal((await g.call('PUT', '/api/svc/fm/trans', { url: 'ftp://x' })).status, 400);
    assert.equal((await g.call('PUT', '/api/svc/fm/trans', { url: 'https://u:p@x.com' })).status, 400);
    assert.equal((await g.call('PUT', '/api/svc/fm/trans', { key: 'a b' })).status, 400);
    r = await g.call('PUT', '/api/svc/vec', { url: 'http://127.0.0.1:11434/v1', model: 'bge-m3' });
    assert.deepEqual([r.body.hasKey, r.body.model], [false, 'bge-m3']);
  } finally { await g.close(); }
});
