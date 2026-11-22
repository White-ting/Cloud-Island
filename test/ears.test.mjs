// 量录音（11-22）：网页 web/ears.js 量数，后端 lib/ears.mjs 核数、跟她平时比、写成〔测量〕那一行；聊天把它带给 TA。
// 上游是测试进程里起的假 HTTP 服务。
import { test, after as afterAll } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/store.mjs';
import { createServer } from '../lib/server.mjs';
import { openPersona } from '../lib/persona.mjs';
import { openChat } from '../lib/chat.mjs';
import { openFiles } from '../lib/files.mjs';
import { openEars, cleanMeas, measText, countWords } from '../lib/ears.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dirs = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-ears-')); dirs.push(d); return d; };

// 网页那份：在测试里当普通脚本跑一遍，拿到 YDEars
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(here, '../web/ears.js'), 'utf8'), ctx);
const { YDEars } = ctx;
const SR = 48000;
let seed = 7;
const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
const tone = (f, sec, amp, f2 = f) => Array.from({ length: Math.round(SR * sec) }, (_, i) => amp * Math.sin(2 * Math.PI * (f + (f2 - f) * i / (2 * SR * sec)) * i / SR));
const hush = (sec) => Array.from({ length: Math.round(SR * sec) }, () => 0.0005 * (rnd() - 0.5));

test('网页量录音：音高、停顿、句尾、音量变化量得出来；全是静音说没声；太短回 null', () => {
  const m = YDEars.pcm(Float32Array.from([...hush(0.3), ...tone(220, 1, 0.3), ...hush(0.5), ...tone(220, 1, 0.3), ...tone(300, 0.6, 0.15), ...hush(0.3)]), SR);
  assert.equal(m.voiced, true);
  assert.equal(m.pitch_hz, 220);
  assert.equal(m.pause_count, 1);
  assert.ok(m.pause_longest > 0.4 && m.pause_longest < 0.55, String(m.pause_longest));
  assert.ok(m.tail_st > 5 && m.tail_st < 5.8, String(m.tail_st)); // 220 → 300 Hz 是 5.4 个半音
  assert.ok(m.loud_trend_db < -1);
  assert.equal(m.duration, 3.7);
  assert.equal(YDEars.pcm(Float32Array.from(hush(2)), SR).voiced, false);
  assert.equal(YDEars.pcm(Float32Array.from(tone(220, 0.2, 0.3)), SR), null);
  // 句尾往下沉
  const d = YDEars.pcm(Float32Array.from([...hush(0.2), ...tone(260, 1.2, 0.3), ...tone(180, 0.6, 0.3), ...hush(0.2)]), SR);
  assert.ok(d.tail_st < -1.5, String(d.tail_st));
});

test('后端核数：缺必要的、不是数、超出范围整条不要；不认识的名字扔掉', () => {
  const ok = { duration: 3, speech: 2.5, pause_count: 1, pause_longest: 0.4, loud_trend_db: -1, pitch_hz: 220, pitch_sd_st: 2, tail_st: 0.3 };
  assert.deepEqual(cleanMeas({ ...ok, evil: '<script>', pauses: [[1, 2]] }), ok);
  assert.equal(cleanMeas({ ...ok, pitch_hz: 'x' }), null);
  assert.equal(cleanMeas({ ...ok, duration: 99999 }), null);
  assert.equal(cleanMeas({ ...ok, tail_st: undefined }), null);
  assert.equal(cleanMeas('x'), null);
  assert.equal(cleanMeas(null), null);
});

test('写成一行人话：语速（3 个字以上才算）、停顿、音高和起伏、句尾、后半段轻响；字数汉字一个算一个、英文按词', () => {
  assert.equal(countWords('我今天 ok 了 123'), 6);
  const m = { duration: 4, speech: 2, pause_count: 2, pause_longest: 0.66, loud_trend_db: -5, pitch_hz: 230.4, pitch_sd_st: 3.2, tail_st: -2 };
  assert.equal(measText(m, '我今天面试过了真的'), '4.0 秒 · 语速 4.5 字/秒（正常） · 停顿 2 处，最长 0.7 秒 · 音高约 230 Hz，起伏很大，句尾往下沉 · 后半段声音变轻');
  assert.equal(measText({ ...m, pause_count: 0, pitch_hz: 0, loud_trend_db: 0 }, '嗯'), '4.0 秒 · 一口气没停');
});

test('跟她平时比：攒够 5 条才比；差不多说差不多；高了、快了照说；电话只比不攒；存的文件权限 600', () => {
  const dir = tmp(), e = openEars({ dir });
  const m = { duration: 3, speech: 2, pause_count: 0, pause_longest: 0, loud_trend_db: 0, pitch_hz: 220, pitch_sd_st: 2, tail_st: 0 };
  const text = '我今天去买菜了啊'; // 8 字 / 2 秒 = 4 字/秒
  for (let i = 0; i < 5; i++) assert.equal(e.compare(m, text), '');
  assert.equal(e.compare(m, text), '比她平时：和平时差不多');
  assert.equal(e.compare({ ...m, pitch_hz: 260, speech: 1.4 }, text, false), '比她平时：声音比平时高、说得比平时快');
  assert.equal(JSON.parse(fs.readFileSync(e.file, 'utf8')).length, 6); // 电话那条没攒
  assert.equal(fs.statSync(e.file).mode & 0o777, 0o600);
  assert.equal(e.compare({ ...m, pitch_sd_st: 0.8 }, text, false), '比她平时：比平时平');
  assert.match(e.line(m, text, { keep: false }), /^3\.0 秒 · 语速 4\.0 字\/秒（正常） · 一口气没停 · 音高约 220 Hz，有起伏 · 比她平时：和平时差不多$/);
});

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60, 7)]);
async function setup() {
  const dir = tmp();
  const now = () => Date.UTC(2026, 10, 22, 4);
  const store = openStore({ dir, now });
  const persona = openPersona({ store });
  const up = { seen: [] };
  up.server = http.createServer((req, res) => {
    const c = []; req.on('data', (x) => c.push(x));
    req.on('end', () => {
      up.seen.push(JSON.parse(Buffer.concat(c).toString('utf8')));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '嗯' } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((ok) => up.server.listen(0, '127.0.0.1', ok));
  const files = openFiles({ dir, now });
  const ears = openEars({ dir, now });
  const chat = openChat({ dir, store, persona, files, ears, upstream: { openai: `http://127.0.0.1:${up.server.address().port}` }, keyOf: () => 'k', now });
  chat.setAis([{ id: 'o', model: 'gpt-x', style: 'openai', keyEnv: 'AI_KEY' }]);
  const srv = createServer({ cfg: { port: 0 }, store, persona, chat, files });
  const { port } = await srv.listen();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* SSE */ }
    return { status: r.status, json };
  };
  const close = async () => { await srv.close(); up.server.closeAllConnections(); await new Promise((ok) => up.server.close(ok)); };
  return { dir, files, ears, up, call, close };
}
const lastUser = (up) => up.seen.at(-1).messages.filter((m) => m.role === 'user').at(-1).content;

test('聊天带测量：语音条的〔测量〕跟在转出来的字后面、攒进她的平时；电话的一句也带、不攒；量得不对的照发不带；没量的跟以前一样', async () => {
  const g = await setup();
  try {
    const f = g.files.saveBuf(WEBM, 'voice', { audio: true });
    const meas = { duration: 3.3, speech: 2.4, pause_count: 1, pause_longest: 0.5, loud_trend_db: -1, pitch_hz: 220, pitch_sd_st: 2.1, tail_st: 2, pauses: [[1, 0.5]] };
    let r = await g.call('POST', '/api/chat/o/send', { text: '我今天面试过了', voice: { file: f.id, dur: 3.3, meas } });
    assert.equal(r.status, 200);
    assert.equal(lastUser(g.up), '〔她发了一条语音（3 秒），下面是转出来的字〕\n我今天面试过了\n〔测量〕3.3 秒 · 语速 2.9 字/秒（偏慢） · 停顿 1 处，最长 0.5 秒 · 音高约 220 Hz，有起伏，句尾上扬');
    assert.equal(JSON.parse(fs.readFileSync(g.ears.file, 'utf8')).length, 1);
    const items = (await g.call('GET', '/api/chat/o')).json.items;
    assert.equal(items[0].voice.meas.pauses, undefined); // 停顿明细不存
    assert.match(items[0].ears, /^3\.3 秒/);
    // 电话
    await g.call('POST', '/api/chat/o/send', { text: '喂你听得见吗', call: 'start', meas });
    assert.match(lastUser(g.up), /^喂你听得见吗\n〔测量〕3\.3 秒[^\n]*\n〔通话：/);
    assert.equal(JSON.parse(fs.readFileSync(g.ears.file, 'utf8')).length, 1);
    // 量得不对：照发，不带测量
    r = await g.call('POST', '/api/chat/o/send', { text: '再说一句', voice: { file: f.id, dur: 2, meas: { ...meas, pitch_hz: -5 } } });
    assert.equal(r.status, 200);
    assert.doesNotMatch(lastUser(g.up), /测量/);
    // 打字的电话里没带 meas：跟以前一样
    await g.call('POST', '/api/chat/o/send', { text: '好的', call: true });
    assert.doesNotMatch(lastUser(g.up), /测量/);
  } finally { await g.close(); }
});

test('网页打包 wav：16k 单声道 16 位，头对、长度对', () => {
  const b = Buffer.from(YDEars.wav(Float32Array.from(tone(220, 1, 0.3)), SR));
  assert.equal(b.toString('latin1', 0, 4), 'RIFF');
  assert.equal(b.toString('latin1', 8, 16), 'WAVEfmt ');
  assert.deepEqual([b.readUInt16LE(22), b.readUInt32LE(24), b.readUInt16LE(34)], [1, 16000, 16]);
  assert.equal(b.readUInt32LE(40), 16000 * 2);
  assert.equal(b.length, 44 + 16000 * 2);
});

test('聊天带语气：语音条的〔语气〕在〔测量〕前面；电话里带的是上一句的；乱填的不要', async () => {
  const g = await setup();
  try {
    const f = g.files.saveBuf(WEBM, 'voice', { audio: true });
    const meas = { duration: 3, speech: 2, pause_count: 0, pause_longest: 0, loud_trend_db: 0, pitch_hz: 220, pitch_sd_st: 2, tail_st: 0 };
    await g.call('POST', '/api/chat/o/send', { text: '我面试过了', voice: { file: f.id, dur: 3, meas, tone: '  声音发抖，\n像是激动  ' } });
    assert.match(lastUser(g.up), /^〔她发了一条语音（3 秒），下面是转出来的字〕\n我面试过了\n〔语气〕声音发抖， 像是激动\n〔测量〕3\.0 秒/);
    assert.equal((await g.call('GET', '/api/chat/o')).json.items[0].tone, '声音发抖， 像是激动');
    await g.call('POST', '/api/chat/o/send', { text: '喂', call: 'start', tone: '有点喘' });
    assert.match(lastUser(g.up), /^喂\n〔语气〕上一句：有点喘\n〔通话：/);
    await g.call('POST', '/api/chat/o/send', { text: '再说', voice: { file: f.id, dur: 2, tone: { x: 1 } } });
    assert.doesNotMatch(lastUser(g.up), /语气/);
    await g.call('POST', '/api/chat/o/send', { text: '打字', tone: '不是电话不收' });
    assert.doesNotMatch(lastUser(g.up), /语气/);
  } finally { await g.close(); }
});
