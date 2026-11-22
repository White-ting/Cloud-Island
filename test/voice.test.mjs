// 声音：每个 AI 的声音设置、出声（四家）、认字（OpenAI 兼容 multipart、百炼 chat 形状）。
// 上游一律是这个测试进程里起的假 HTTP 服务，不发外网请求。Key 不许出现在任何返回和日志里。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../lib/store.mjs';
import { createServer } from '../lib/server.mjs';
import { openSvc } from '../lib/svc.mjs';
import { openFiles } from '../lib/files.mjs';
import { openVoice, guessProv } from '../lib/voice.mjs';
import { makeNet } from '../lib/net.mjs';

const KEY = 'sk-VOICE-SEKRIT-0123456789';
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(40, 1)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 9)]);
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-voice-')); dirs.push(dir);
  const up = { seen: [], reply: null };
  up.server = http.createServer((req, res) => {
    const c = []; req.on('data', (x) => c.push(x));
    req.on('end', () => {
      const raw = Buffer.concat(c), r = { method: req.method, url: req.url, headers: req.headers, raw };
      try { r.json = JSON.parse(raw.toString('utf8')); } catch { /* multipart */ }
      up.seen.push(r);
      if (up.reply) return up.reply(r, res);
      const j = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (/\/t2a_v2$/.test(req.url)) return j({ data: { audio: MP3.toString('hex') }, base_resp: { status_code: 0 } });
      if (/\/audio\/transcriptions$/.test(req.url)) return j({ text: ' 转出来的字 ' });
      if (/\/chat\/completions$/.test(req.url)) return j({ choices: [{ message: { content: '百炼认的字' } }] });
      res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(MP3);
    });
  });
  await new Promise((ok) => up.server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${up.server.address().port}`;
  const net = makeNet({ allow: 'http://127.0.0.1, http://localhost' }); // 假上游在本机：像管理员在 ALLOW_URLS 里放行了一样
  const store = openStore({ dir }), svc = openSvc({ dir, net }), files = openFiles({ dir });
  const logs = [];
  const voice = openVoice({ dir, svc, folder: (ai) => store.folder(ai), files, log: (...a) => logs.push(a.join(' ')), net });
  const srv = createServer({ cfg: { port: 0 }, store, svc, files, voice });
  const { port } = await srv.listen();
  const outs = [];
  const call = async (method, p, body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ? body : body ? JSON.stringify(body) : undefined });
    const buf = Buffer.from(await r.arrayBuffer());
    outs.push(buf.toString('latin1'));
    let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* 音频 */ }
    return { status: r.status, buf, json, type: r.headers.get('content-type') };
  };
  const tts = (body) => call('POST', '/api/voice/tts', body);
  const stt = (buf, type = 'audio/webm', q = '') => call('POST', '/api/voice/stt' + q, buf, { 'content-type': type });
  const noLeak = () => {
    for (const o of outs) assert.ok(!o.includes(KEY), '返回里有 Key');
    for (const l of logs) assert.ok(!l.includes(KEY), '日志里有 Key');
    const vd = path.join(dir, 'voice');
    if (fs.existsSync(vd)) for (const f of fs.readdirSync(vd, { withFileTypes: true })) if (f.isFile()) assert.ok(!fs.readFileSync(path.join(dir, 'voice', f.name), 'utf8').includes(KEY));
  };
  const close = async () => { await srv.close(); up.server.closeAllConnections(); await new Promise((ok) => up.server.close(ok)); };
  return { dir, base, up, svc, call, tts, stt, noLeak, close, logs };
}

test('认服务商：看地址', () => {
  assert.equal(guessProv('https://api.elevenlabs.io/v1'), 'elevenlabs');
  assert.equal(guessProv('https://api.cartesia.ai'), 'cartesia');
  assert.equal(guessProv('https://api.minimaxi.com/v1'), 'minimax');
  assert.equal(guessProv('https://api.siliconflow.cn/v1'), 'openai');
});

test('每个 AI 的声音设置：没改的照「TA 的声音」那一项；改了的存 data/voice/<ai>.json（600，不带 Key）；乱填报 400', async () => {
  const g = await setup();
  try {
    g.svc.putFm('tts', { url: g.base + '/sf/v1', model: 'cosy', key: KEY, voices: { o: { id: 'v-o', speed: 1.1 } } });
    let r = await g.call('GET', '/api/voice/o');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.own, {});
    assert.deepEqual(r.json.use, { prov: 'openai', url: g.base + '/sf/v1', model: 'cosy', voice: 'v-o', speed: 1.1, from: 'tts' });
    assert.deepEqual([r.json.hasKey, r.json.ready], [true, true]);
    // 换了服务商：地址、模型回到那一家的默认；「TA 的声音」那把 Key 是给另一个地址的，不带过去
    r = await g.call('PUT', '/api/voice/o', { prov: 'elevenlabs', voice: 'v2', speed: 0.9 });
    assert.deepEqual(r.json.own, { prov: 'elevenlabs', voice: 'v2', speed: 0.9 });
    assert.deepEqual([r.json.use.url, r.json.use.model, r.json.use.voice], ['https://api.elevenlabs.io/v1', 'eleven_v4', 'v2']);
    assert.equal(r.json.hasKey, false);
    assert.equal(fs.statSync(path.join(g.dir, 'voice', 'o.json')).mode & 0o777, 0o600);
    r = await g.call('PUT', '/api/voice/o', { prov: null, voice: '' });
    assert.deepEqual(r.json.own, { speed: 0.9 });
    for (const bad of [{ prov: 'x' }, { url: 'ftp://a' }, { url: 'https://a.b/v1?key=1' }, { speed: 9 }, { voice: 3 }, []]) {
      assert.equal((await g.call('PUT', '/api/voice/o', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await g.call('GET', '/api/voice/a.b')).status, 400);
    g.noLeak();
  } finally { await g.close(); }
});

test('出声 ElevenLabs：音色进路径、xi-api-key、model_id、语速超了按上限；回音频字节', async () => {
  const g = await setup();
  try {
    g.svc.putFm('tts', { url: g.base + '/el/v1', model: 'eleven_v4', key: KEY }); // Key 跟着这个地址（同一个 origin 才带）
    await g.call('PUT', '/api/voice/o', { prov: 'elevenlabs', url: g.base + '/el/v1', voice: 'v 1', model: 'eleven_v3', speed: 1.5 });
    const r = await g.tts({ ai: 'o', text: 'hello there' });
    assert.equal(r.status, 200);
    assert.equal(r.type, 'audio/mpeg');
    assert.ok(r.buf.equals(MP3));
    const s = g.up.seen.at(-1);
    assert.equal(s.url, '/el/v1/text-to-speech/v%201?output_format=mp3_44100_128');
    assert.equal(s.headers['xi-api-key'], KEY);
    assert.deepEqual(s.json, { text: 'hello there', model_id: 'eleven_v3', voice_settings: { speed: 1.2 } });
    g.noLeak();
  } finally { await g.close(); }
});

test('出声 Cartesia：/tts/bytes、版本头、语气标签换掉、中文标 zh；MiniMax：t2a_v2 回十六进制；OpenAI 兼容：/audio/speech', async () => {
  const g = await setup();
  try {
    g.svc.putFm('tts', { url: g.base + '/sf/v1', model: 'cosy', key: KEY, voices: { o: { id: 'v-o', speed: 1.1 } } });
    // OpenAI 兼容（照「TA 的声音」那一项）
    let r = await g.tts({ ai: 'o', text: '在呢' });
    assert.ok(r.buf.equals(MP3));
    let s = g.up.seen.at(-1);
    assert.equal(s.url, '/sf/v1/audio/speech');
    assert.equal(s.headers.authorization, 'Bearer ' + KEY);
    assert.deepEqual(s.json, { model: 'cosy', input: '在呢', voice: 'v-o', response_format: 'mp3', speed: 1.1 });
    // Cartesia
    await g.call('PUT', '/api/voice/o', { prov: 'cartesia', url: g.base + '/ca', voice: 'cv', speed: 1 });
    r = await g.tts({ ai: 'o', text: '你好 [laughs softly] 呀 [whispers]' });
    assert.equal(r.status, 200);
    s = g.up.seen.at(-1);
    assert.equal(s.url, '/ca/tts/bytes');
    assert.deepEqual([s.headers.authorization, s.headers['x-api-key'], s.headers['cartesia-version']], ['Bearer ' + KEY, KEY, '2026-08-14']);
    assert.deepEqual(s.json, { model_id: 'sonic-3.6', transcript: '你好 [laughter] 呀', voice: { mode: 'id', id: 'cv' }, output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 }, language: 'zh' });
    // MiniMax
    await g.call('PUT', '/api/voice/o', { prov: 'minimax', url: g.base + '/mm/v1', voice: 'mv' });
    r = await g.tts({ ai: 'o', text: 'hi' });
    assert.ok(r.buf.equals(MP3));
    s = g.up.seen.at(-1);
    assert.equal(s.url, '/mm/v1/t2a_v2');
    assert.equal(s.json.voice_setting.voice_id, 'mv');
    assert.equal(s.json.model, 'speech-2.6-hd');
    g.up.reply = (q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'auth failed' } })); };
    r = await g.tts({ ai: 'o', text: 'hi' });
    assert.deepEqual([r.status, r.json.error], [502, 'MiniMax 没给声音：auth failed']);
    g.noLeak();
  } finally { await g.close(); }
});

test('打电话单独指定（callSvc = own）：call: true 用「打电话的声音」那一项', async () => {
  const g = await setup();
  try {
    g.svc.putFm('tts', { url: g.base + '/sf/v1', model: 'slow', key: KEY, voices: { o: { id: 'v-o' } } });
    g.svc.putFm('ctts', { url: g.base + '/call/v1', model: 'fast', key: KEY, voices: { o: { id: 'v-call' } } });
    await g.tts({ ai: 'o', text: 'a', call: true });
    assert.equal(g.up.seen.at(-1).url, '/sf/v1/audio/speech'); // 还没选「单独指定」
    g.svc.putOpts({ callSvc: 'own' });
    await g.tts({ ai: 'o', text: 'a', call: true });
    assert.deepEqual([g.up.seen.at(-1).url, g.up.seen.at(-1).json.voice, g.up.seen.at(-1).json.model], ['/call/v1/audio/speech', 'v-call', 'fast']);
    await g.tts({ ai: 'o', text: 'a' });
    assert.equal(g.up.seen.at(-1).url, '/sf/v1/audio/speech');
  } finally { await g.close(); }
});

test('出声报错：没 Key、没音色 503；没字、太长 400；上游 401 回 502 和一句说明，Key 被抹掉', async () => {
  const g = await setup();
  try {
    await g.call('PUT', '/api/voice/o', { prov: 'elevenlabs', url: g.base + '/el/v1', voice: 'v' });
    let r = await g.tts({ ai: 'o', text: 'x' });
    assert.deepEqual([r.status, /Key/.test(r.json.error)], [503, true]);
    g.svc.putFm('tts', { url: g.base + '/sf/v1', key: KEY });
    await g.call('PUT', '/api/voice/o', { voice: null });
    assert.equal((await g.tts({ ai: 'o', text: 'x' })).status, 503);
    await g.call('PUT', '/api/voice/o', { voice: 'v' });
    assert.equal((await g.tts({ ai: 'o', text: '  ' })).status, 400);
    assert.equal((await g.tts({ ai: 'o', text: 'x'.repeat(1001) })).status, 400);
    assert.equal((await g.tts({ ai: '../o', text: 'x' })).status, 400);
    g.up.reply = (q, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ detail: { message: 'invalid key ' + KEY } })); };
    r = await g.tts({ ai: 'o', text: 'x' });
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'ElevenLabs 回了 401：invalid key ***');
    g.noLeak();
  } finally { await g.close(); }
});

test('认字：没配 503、不是 audio/* 415；OpenAI 兼容 multipart；录音存进 files 能回放；打电话单独指定走 cstt', async () => {
  const g = await setup();
  try {
    assert.equal((await g.stt(WEBM)).status, 503);
    g.svc.putFm('stt', { url: g.base + '/sf/v1', model: 'SenseVoice', key: KEY });
    assert.equal((await g.stt(WEBM, 'application/json')).status, 415);
    let r = await g.stt(WEBM);
    assert.equal(r.status, 200);
    assert.equal(r.json.text, '转出来的字');
    assert.match(r.json.file, /^f[a-z0-9]{12,20}$/);
    assert.equal(r.json.url, '/api/file/' + r.json.file);
    const s = g.up.seen.at(-1);
    assert.equal(s.url, '/sf/v1/audio/transcriptions');
    assert.equal(s.headers.authorization, 'Bearer ' + KEY);
    const b = /boundary=(\S+)/.exec(s.headers['content-type'])[1];
    const body = s.raw.toString('latin1');
    assert.ok(body.includes(`--${b}\r\nContent-Disposition: form-data; name="model"\r\n\r\nSenseVoice\r\n`));
    assert.ok(body.includes('name="file"; filename="voice.webm"\r\nContent-Type: audio/webm\r\n\r\n' + WEBM.toString('latin1') + `\r\n--${b}--\r\n`));
    assert.ok(!body.includes('name="prompt"'));
    // 存下的录音能回放
    const f = await g.call('GET', r.json.url);
    assert.deepEqual([f.status, f.type, f.buf.equals(WEBM)], [200, 'audio/webm', true]);
    // 浏览器录的 mp4（牌子不在名单里）也收，当 m4a
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypiso5'), Buffer.alloc(100, 3)]);
    r = await g.stt(mp4, 'audio/mp4');
    assert.equal(r.status, 200);
    assert.equal((await g.call('GET', r.json.url)).type, 'audio/mp4');
    // 打电话单独指定
    g.svc.putFm('cstt', { url: g.base + '/c2/v1', model: 'm2' });
    g.svc.putOpts({ callSvc: 'own' });
    await g.stt(WEBM, 'audio/webm', '?call=1');
    assert.equal(g.up.seen.at(-1).url, '/c2/v1/audio/transcriptions');
    assert.equal(g.up.seen.at(-1).headers.authorization, undefined);
    await g.stt(WEBM);
    assert.equal(g.up.seen.at(-1).url, '/sf/v1/audio/transcriptions');
    g.noLeak();
  } finally { await g.close(); }
});

test('认字：百炼的 asr 走 chat 形状（录音放 input_audio、常被认错的词放 system）', async () => {
  const g = await setup();
  try {
    g.svc.putFm('stt', { url: g.base + '/dashscope/compatible-mode/v1', model: 'qwen3-asr-flash', key: KEY });
    g.svc.putOpts({ asrWords: '云岛、Cartesia' });
    const r = await g.stt(WEBM);
    assert.equal(r.json.text, '百炼认的字');
    const s = g.up.seen.at(-1);
    assert.equal(s.url, '/dashscope/compatible-mode/v1/chat/completions');
    assert.deepEqual(s.json.messages[0], { role: 'system', content: [{ type: 'text', text: '说话人常说的词：云岛、Cartesia' }] });
    assert.equal(s.json.messages[1].content[0].input_audio.data, 'data:audio/webm;base64,' + WEBM.toString('base64'));
  } finally { await g.close(); }
});

test('认字报错：上游出错回 502，录音照样存着、报错里带 file；太大 413；不是录音 415', async () => {
  const g = await setup();
  try {
    g.svc.putFm('stt', { url: g.base + '/sf/v1', model: 'm', key: KEY });
    g.up.reply = (q, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'boom ' + KEY } })); };
    let r = await g.stt(WEBM);
    assert.equal(r.status, 502);
    assert.match(r.json.error, /^认字没成：认字服务 回了 500：boom \*\*\*$/);
    assert.equal((await g.call('GET', '/api/file/' + r.json.file)).status, 200);
    r = await g.stt(Buffer.alloc(10 * 1024 * 1024 + 10, 1));
    assert.equal(r.status, 413);
    r = await g.stt(Buffer.from('this is not audio at all, just text'));
    assert.equal(r.status, 415);
    g.noLeak();
  } finally { await g.close(); }
});

test('Key 跟着地址走：AI 单独改到别的地址不带 Key；设置里换了地址又没填新 Key，旧 Key 清掉；旧文件没记 keyAt 的按它自己的地址算', async () => {
  const g = await setup();
  const other = g.base.replace('127.0.0.1', 'localhost'); // 同一个假上游，换个 origin
  try {
    g.svc.putFm('tts', { url: g.base + '/sf/v1', model: 'cosy', key: KEY, voices: { o: { id: 'v-o' } } });
    await g.call('PUT', '/api/voice/o', { url: other + '/sf/v1' });
    let r = await g.tts({ ai: 'o', text: 'a' });
    assert.equal(r.status, 200); // OpenAI 兼容的没 Key 也发（本机服务），但不带 Key
    assert.equal(g.up.seen.at(-1).headers.authorization, undefined);
    await g.call('PUT', '/api/voice/o', { prov: 'elevenlabs', voice: 'v' });
    r = await g.tts({ ai: 'o', text: 'a' });
    assert.equal(r.status, 503); // ElevenLabs 要 Key：设置里那把是给别的地址的
    await g.call('PUT', '/api/voice/o', { prov: null, url: null });
    await g.tts({ ai: 'o', text: 'a' });
    assert.equal(g.up.seen.at(-1).headers.authorization, 'Bearer ' + KEY); // 回到同一个地址：带
    // 只换地址、不给 Key：旧 Key 清掉
    let v = g.svc.putFm('tts', { url: other + '/sf/v1' });
    assert.equal(v.hasKey, false);
    // 换地址时 Key 只填了空格：当没给，旧 Key 不能借这个带过去（11-19 sol 复审）
    g.svc.putFm('tts', { url: g.base + '/sf/v1', key: KEY });
    v = g.svc.putFm('tts', { url: other + '/sf/v1', key: '   ' });
    assert.equal(v.hasKey, false);
    // 换地址时同时给新 Key：留着
    v = g.svc.putFm('tts', { url: g.base + '/sf/v1', key: KEY });
    assert.equal(v.hasKey, true);
    // 同一个 origin 换路径：Key 留着
    assert.equal(g.svc.putFm('tts', { url: g.base + '/v2' }).hasKey, true);
    // 旧版本存的（没有 keyAt）：按它自己的地址算
    const f = path.join(g.dir, 'svc.json'), d = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete d.fm.tts.keyAt; d.fm.tts.url = g.base + '/sf/v1';
    fs.writeFileSync(f, JSON.stringify(d));
    await g.tts({ ai: 'o', text: 'a' });
    assert.equal(g.up.seen.at(-1).headers.authorization, 'Bearer ' + KEY);
    g.noLeak();
  } finally { await g.close(); }
});

test('出站地址：默认只许 https 公网；本机、私网、http 要 ALLOW_URLS 放行；域名解析到私网也不发；上游回跳转不跟', async () => {
  const g = await setup();
  try {
    // 默认（没放行）：填设置时就拦下
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-voice-')); dirs.push(dir);
    const strict = openSvc({ dir });
    for (const u of ['http://example.com/v1', 'https://127.0.0.1/v1', 'https://localhost:8080/v1', 'https://10.1.2.3/v1', 'https://[::1]/v1', 'https://192.168.1.5/v1', 'https://100.100.1.1/v1']) {
      assert.throws(() => strict.putFm('tts', { url: u }), (e) => e.code === 400 && /ALLOW_URLS|https/.test(e.message), u);
    }
    assert.equal(strict.putFm('tts', { url: 'https://api.example.com/v1' }).url, 'https://api.example.com/v1');
    // 域名解析到私网：发之前拦下（假的 DNS）
    const net = makeNet({ lookup: async (h) => (h === 'evil.test' ? [{ address: '192.168.0.9', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]) });
    await assert.rejects(net.check('https://evil.test/v1'), (e) => e.code === 400 && /ALLOW_URLS/.test(e.message));
    await assert.rejects(makeNet({ lookup: async () => [{ address: '::ffff:127.0.0.1', family: 6 }] }).check('https://x.test/'), /ALLOW_URLS/);
    assert.equal((await net.check('https://ok.test/v1')).hostname, 'ok.test');
    // 开着 Clash 之类 fake-ip 的：域名都解析成 198.18.x.x，要放行（不然开代理的人什么都填不了）
    assert.equal((await makeNet({ lookup: async () => [{ address: '198.18.0.42', family: 4 }] }).check('https://api.elevenlabs.io/')).hostname, 'api.elevenlabs.io');
    assert.throws(() => makeNet().okSync('https://198.18.0.42/'), /ALLOW_URLS/);   // 网址里直接写这一段的 IP 照样拦
    // 放行：写了端口只放那个端口
    const one = makeNet({ allow: 'http://127.0.0.1:11434' });
    assert.ok(one.okSync('http://127.0.0.1:11434/v1'));
    assert.throws(() => one.okSync('http://127.0.0.1:11435/v1'), /ALLOW_URLS/);
    // 上游回跳转：不跟（假上游只看到一次请求），回 502
    g.svc.putFm('tts', { url: g.base + '/sf/v1', key: KEY, voices: { o: { id: 'v' } } });
    g.up.reply = (q, res) => { res.writeHead(302, { location: g.base + '/elsewhere' }); res.end(); };
    const n = g.up.seen.length;
    const r = await g.tts({ ai: 'o', text: 'a' });
    assert.equal(r.status, 502);
    assert.equal(g.up.seen.length - n, 1);
    assert.ok(!g.up.seen.some((x) => x.url === '/elsewhere'));
  } finally { await g.close(); }
});

test('听语气：没配 503、不是 wav 415、太大 413；流式拼起来取 tone；也认非流式 JSON；百炼写 data: 地址、别家纯 base64；Key 只在头里', async () => {
  const g = await setup();
  const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(200, 3)]);
  const mood = (buf, type = 'audio/wav', q = '?text=' + encodeURIComponent('我今天面试过了')) => g.call('POST', '/api/voice/mood' + q, buf, { 'content-type': type });
  try {
    assert.equal((await mood(WAV)).status, 503);
    g.svc.putFm('mood', { url: g.base + '/gm/v1', model: 'gemini-x', key: KEY });
    assert.equal((await mood(WAV, 'audio/webm')).status, 415);
    // 流式：几段拼起来是一个 JSON
    g.up.reply = (r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const t of ['{"tone": "声音', '有点抖，', '像是激动，说完笑了一下"}']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    let r = await mood(WAV);
    assert.equal(r.status, 200);
    assert.equal(r.json.tone, '声音有点抖，像是激动，说完笑了一下');
    let s = g.up.seen.at(-1);
    assert.equal(s.url, '/gm/v1/chat/completions');
    assert.equal(s.headers.authorization, 'Bearer ' + KEY);
    assert.equal(s.json.stream, true);
    const parts = s.json.messages[0].content;
    assert.deepEqual(parts[0], { type: 'input_audio', input_audio: { data: WAV.toString('base64'), format: 'wav' } });
    assert.match(parts[1].text, /我今天面试过了/);
    assert.doesNotMatch(parts[1].text, /打电话/);
    // 百炼：data: 地址；电话那句的问法；非流式 JSON、带代码块也认；超长截到 300
    g.svc.putFm('mood', { url: g.base + '/dashscope/v1', model: 'qwen3.8-omni-flash', key: KEY });
    g.up.reply = (rq, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"tone":"' + '很'.repeat(400) + '"}\n```' } }] })); };
    r = await mood(WAV, 'audio/wav', '?text=x&call=1');
    assert.equal([...r.json.tone].length, 300);
    s = g.up.seen.at(-1);
    assert.equal(s.json.messages[0].content[0].input_audio.data, 'data:audio/wav;base64,' + WAV.toString('base64'));
    assert.match(s.json.messages[0].content[1].text, /打电话/);
    // 不是 JSON：用原话；什么都没回：502
    g.up.reply = (rq, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '她听起来很累' } }] })); };
    assert.equal((await mood(WAV)).json.tone, '她听起来很累');
    g.up.reply = (rq, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: [DONE]\n\n'); };
    assert.equal((await mood(WAV)).status, 502);
    // 上游报错带着 Key 也抹掉
    g.up.reply = (rq, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad key ' + KEY } })); };
    r = await mood(WAV);
    assert.equal(r.status, 502);
    assert.doesNotMatch(r.json.error, new RegExp(KEY));
    assert.equal((await mood(Buffer.alloc(5 * 1024 * 1024 + 10, 1))).status, 413);
    g.noLeak();
  } finally { await g.close(); }
});

test('打电话边说边传：一块块传上来（可以乱序、最后一块晚到），说完那句拼起来认；缺块 409；编号不对 400', async () => {
  const g = await setup();
  try {
    g.svc.putFm('stt', { url: g.base + '/sf/v1', model: 'm', key: KEY });
    const part = (id, seq, buf) => g.call('POST', `/api/voice/part?id=${id}&seq=${seq}`, buf, { 'content-type': 'audio/webm' });
    const a = WEBM.subarray(0, 10), b = WEBM.subarray(10, 20), c = WEBM.subarray(20);
    assert.equal((await part('abcd1234', 1, b)).status, 200);
    assert.equal((await part('abcd1234', 0, a)).status, 200);
    setTimeout(() => part('abcd1234', 2, c), 300);                       // 最后一块比「说完了」晚到
    const t0 = Date.now();
    let r = await g.stt(Buffer.alloc(0), 'audio/webm', '?call=1&part=abcd1234&n=3');
    assert.equal(r.status, 200);
    assert.equal(r.json.text, '转出来的字');
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(g.up.seen.at(-1).raw.includes(WEBM));                      // 交给认字服务的是三块按顺序拼起来的
    assert.equal((await g.call('GET', '/api/file/' + r.json.file)).buf.equals(WEBM), true);
    // 缺一块：等 2.5 秒判缺，409（网页改传整段）
    await part('lost12345', 0, a);
    r = await g.stt(b, 'audio/webm', '?call=1&part=lost12345&n=2');
    assert.equal(r.status, 409);
    // 编号不对
    assert.equal((await part('BAD!', 0, a)).status, 400);
    assert.equal((await part('abcd1234', 'x', a)).status, 400);
    assert.equal((await g.call('POST', '/api/voice/part?id=abcd1234&seq=0', a, { 'content-type': 'text/plain' })).status, 415);
    g.noLeak();
  } finally { await g.close(); }
});

test('仓库：录音记下是你的、哪个 AI、是不是电话里的、说的字；TA 念的（keep）存一份、同一句不重复、试听不存、关了不存；按种类和 AI 列', async () => {
  const g = await setup();
  try {
    g.svc.putFm('stt', { url: g.base + '/sf/v1', model: 'm', key: KEY });
    g.svc.putFm('tts', { url: g.base + '/sf/v1', model: 'cosy', key: KEY, voices: { o: { id: 'v-o' }, p: { id: 'v-p' } } });
    let r = await g.stt(WEBM, 'audio/webm', '?call=1&ai=o');
    assert.equal(r.status, 200);
    await g.stt(WEBM, 'audio/webm', '?ai=p');
    await g.tts({ ai: 'o', text: '你好呀', keep: true });
    await g.tts({ ai: 'o', text: '你好呀', keep: true });                 // 同一句再念一次：不多存
    await g.tts({ ai: 'o', text: '试听的一句' });                          // 没带 keep（试听）：不存
    await g.tts({ ai: 'o', text: '电话里说的', keep: true, call: true });
    let L = (await g.call('GET', '/api/files?kind=audio&ai=o')).json.items;
    assert.deepEqual(L.map((x) => [x.by, !!x.call, x.text]).sort(), [['ai', false, '你好呀'], ['ai', true, '电话里说的'], ['me', true, '转出来的字']].sort());
    assert.ok(L.every((x) => x.ai === 'o' && !('key' in x) && x.url.startsWith('/api/file/')));
    assert.equal((await g.call('GET', '/api/files?kind=audio&ai=p')).json.items.length, 1);
    assert.equal((await g.call('GET', '/api/files?kind=img')).json.items.length, 0);
    // 设置里关掉「存下 TA 的声音」：不存
    g.svc.putOpts({ keepVoice: false });
    await g.tts({ ai: 'o', text: '关了以后说的', keep: true });
    L = (await g.call('GET', '/api/files?kind=audio&ai=o')).json.items;
    assert.ok(!L.some((x) => x.text === '关了以后说的'));
    assert.equal(g.svc.view(g.svc.read()).keepVoice, false);
    g.noLeak();
  } finally { await g.close(); }
});
