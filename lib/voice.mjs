// 声音：TA 说话（出声，TTS）和她发语音（认字，STT）。写法参考作者另一个私用项目。
//
// 出声：用设置里「TA 的声音」那一项（svc 的 fm.tts：地址、模型、Key、每个 AI 的音色和语速）。
//   每个 AI 还能单独改几样（data/voice/<ai>.json，不放 Key）：服务商、地址、模型、音色、语速。没改的照「TA 的声音」那一项。
//   打电话（call: true）且设置里选了「打电话单独指定」（opts.callSvc = own），用「打电话的声音」（fm.ctts）。
//   服务商：elevenlabs、cartesia、minimax，以及 openai（OpenAI 兼容的 /audio/speech，硅基流动、百炼这类都能接）。
//   没指定服务商时看地址认：elevenlabs.io → elevenlabs，cartesia.ai → cartesia，minimax → minimax，别的当 openai。
// 认字：用「语音转文字」那一项（fm.stt），打电话单独指定时用 fm.cstt。OpenAI 兼容的 /audio/transcriptions（multipart 自己拼）；
//   地址是阿里百炼（dashscope）、模型名带 asr 的，走它的 chat 接口（录音放 input_audio）。
//
// Key 只从设置里取（svc.json，600），不进返回、不进日志、不进报错。上游的报错原话里要是带了 Key 也抹掉。
// Key 跟着地址走（svc.keyFor）：这个 AI 单独改了地址或服务商、跟设置里那一项不是同一个 origin，就不带 Key（要的话在设置里换成那一家再填 Key）。
// 地址要过 lib/net.mjs 的检查（默认只许 https 公网；本机的语音服务要在 .env 的 ALLOW_URLS 里放行）；上游回跳转当失败，不跟。
//
// 没拿真接口核实过的（只拿测试里的假上游跑过）：ElevenLabs 的 voice_settings.speed、Cartesia 的 generation_config.speed 和版本头、
// MiniMax 的 t2a_v2 整个形状（返回 data.audio 是十六进制）、百炼 asr 的 chat 形状、各家的语速上下限。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './store.mjs';
import { keyFor } from './svc.mjs';
import { makeNet } from './net.mjs';

export const PROVS = ['elevenlabs', 'cartesia', 'minimax', 'openai'];
const NAME = { elevenlabs: 'ElevenLabs', cartesia: 'Cartesia', minimax: 'MiniMax', openai: '出声服务' };
const DEF_URL = { elevenlabs: 'https://api.elevenlabs.io/v1', cartesia: 'https://api.cartesia.ai', minimax: 'https://api.minimaxi.com/v1', openai: 'https://api.openai.com/v1' };
const DEF_MODEL = { elevenlabs: 'eleven_v4', cartesia: 'sonic-3.6', minimax: 'speech-2.6-hd', openai: 'tts-1' };
const SPEED = { elevenlabs: [0.7, 1.2], cartesia: [0.6, 1.5], minimax: [0.5, 2], openai: [0.25, 4] }; // 各家能调的范围，超了按上下限算
const CARTESIA_VER = '2026-08-14';
export const TEXT_MAX = 1000;          // 一次最多念这么多字
export const STT_MAX = 10 * 1024 * 1024;
const WAIT = 60e3;
const CJK = /[一-鿿]/;

export function guessProv(u) {
  const h = (() => { try { return new URL(u).hostname; } catch { return ''; } })();
  if (/(^|\.)elevenlabs\.io$/.test(h)) return 'elevenlabs';
  if (/(^|\.)cartesia\.ai$/.test(h)) return 'cartesia';
  if (/minimax/.test(h)) return 'minimax';
  return 'openai';
}
const trim = (u) => String(u || '').replace(/\/+$/, '');
const scrub = (s, key) => { let t = String(s || ''); if (key && key.length >= 4) t = t.split(key).join('***'); return [...t.replace(/\s+/g, ' ').trim()].slice(0, 160).join(''); };
// 上游错误里那句说明：只取 message/detail 这类，抹掉 Key
function detailOf(buf, key) {
  let s = '';
  try {
    const o = JSON.parse(Buffer.from(buf).toString('utf8'));
    const e = o?.error ?? o?.detail ?? o?.message ?? o?.base_resp?.status_msg;
    s = typeof e === 'string' ? e : e?.message || o?.message || '';
  } catch { /* 不是 JSON 就不给 */ }
  return scrub(s, key);
}
// Cartesia 不认 ElevenLabs 那种语气标签：笑换成 [laughter]，别的删掉（不然会念出来）
function caText(t) {
  return String(t).replace(/\[(?:laughs?|laughing|laughter|chuckles?|giggles?|snickers?)[^\]]{0,20}\]/gi, '[laughter]')
    .replace(/\[[A-Za-z][A-Za-z ,'-]{1,30}\]/g, (m) => (m === '[laughter]' ? m : '')).replace(/[ \t]{2,}/g, ' ').trim();
}

// svc：lib/svc.mjs；folder(ai)：校验 AI 名字（store.folder）；files：lib/files.mjs（存她的录音）
// net：lib/net.mjs 的 makeNet(…)；不传就只许 https 公网地址
export function openVoice({ dir, svc, folder = () => {}, files = null, fetchFn = fetch, log = () => {}, net = makeNet() }) {
  const base = () => path.join(dir, 'voice');
  const fileOf = (ai) => { folder(ai); return path.join(base(), ai + '.json'); };
  const svcRead = () => { try { return svc?.read() || { fm: {}, opts: {} }; } catch { return { fm: {}, opts: {} }; } };
  function own(ai) { try { const o = JSON.parse(fs.readFileSync(fileOf(ai), 'utf8')); return o && typeof o === 'object' ? o : {}; } catch { folder(ai); return {}; } }

  // ---- 每个 AI 的声音设置 ----
  // 这一次真正用哪套：{ prov, url, model, voice, speed, key, from: 'tts'|'ctts' }
  function use(ai, { call = false } = {}) {
    const d = svcRead(), fm = d.fm || {};
    const which = call && d.opts?.callSvc === 'own' && fm.ctts?.url ? 'ctts' : 'tts';
    const s = fm[which] || {}, o = which === 'tts' ? own(ai) : {}; // 打电话单独指定的那家：整套照设置，不看这个 AI 自己改的
    const sv = s.voices?.[ai] || {};
    const sProv = s.url ? guessProv(s.url) : null;
    const prov = o.prov || sProv || 'openai';
    const url = trim(o.url || (s.url && sProv === prov ? s.url : '') || DEF_URL[prov]);
    const model = o.model || (sProv === prov ? s.model : '') || DEF_MODEL[prov];
    const voice = o.voice || sv.id || '';
    const sp = Number(o.speed ?? sv.speed ?? 1);
    return { prov, url, model, voice, speed: Number.isFinite(sp) ? sp : 1, key: keyFor(s, url), from: which };
  }
  // 给网页看的：自己改过的（own）+ 这次会用的（use，不带 Key）
  function get(ai) {
    const o = own(ai), { key, ...u } = use(ai);
    return { ai, own: o, use: u, hasKey: !!key, ready: !!(key && u.voice) || !!(u.prov === 'openai' && u.voice && u.url) };
  }
  // 改：给 null 清掉这一项；不给不动
  function put(ai, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, '要传 { prov, url, model, voice, speed }');
    const o = { ...own(ai) };
    const str = (k, n) => {
      if (input[k] === undefined) return;
      if (input[k] === null || input[k] === '') { delete o[k]; return; }
      if (typeof input[k] !== 'string') throw fail(400, `${k} 要是一段文字`);
      const s = input[k].trim();
      if ([...s].length > n) throw fail(400, `${k} 最长 ${n} 个字`);
      o[k] = s;
    };
    if (input.prov !== undefined) {
      if (input.prov === null || input.prov === '') delete o.prov;
      else if (!PROVS.includes(input.prov)) throw fail(400, 'prov 只能是 ' + PROVS.join('、'));
      else o.prov = input.prov;
    }
    if (input.url !== undefined && input.url !== null && input.url !== '') {
      let u; try { u = new URL(String(input.url)); } catch { throw fail(400, 'url 写得不对'); }
      if (!/^https?:$/.test(u.protocol)) throw fail(400, 'url 要是 http 或 https');
      if (u.username || u.password || u.search) throw fail(400, 'url 里别带口令和 ?…，Key 在设置「TA 的声音」里填');
      net.okSync(u.href, 'url');
    }
    str('url', 500); if (o.url) o.url = trim(o.url);
    str('model', 200); str('voice', 200);
    if (input.speed !== undefined) {
      if (input.speed === null) delete o.speed;
      else { const n = Number(input.speed); if (!Number.isFinite(n) || n < 0.25 || n > 4) throw fail(400, 'speed 要在 0.25 到 4 之间'); o.speed = Math.round(n * 100) / 100; }
    }
    const f = fileOf(ai);
    fs.mkdirSync(base(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 1), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f);
    return get(ai);
  }

  // ---- 发请求：回 { buf, type }；上游不是 2xx 抛 502（带一句说明，不带 Key） ----
  async function post(url, headers, body, key, who) {
    await net.check(url, who + '的地址');
    let r;
    try { r = await fetchFn(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(WAIT) }); } catch (e) {
      log('声音', who, '连不上：', e.name);
      throw fail(502, e.name === 'TimeoutError' ? `${who} 60 秒没回` : `连不上 ${who}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok) {
      const why = detailOf(buf, key);
      log('声音', who, '回了', r.status, why);
      throw fail(502, `${who} 回了 ${r.status}${why ? '：' + why : ''}`);
    }
    return { buf, type: String(r.headers.get('content-type') || '') };
  }

  // ---- 出声 ----
  async function tts(body = {}) {
    const ai = String(body.ai ?? '');
    folder(ai);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw fail(400, '没有要念的字');
    if ([...text].length > TEXT_MAX) throw fail(400, `太长了：一次最多 ${TEXT_MAX} 字`);
    const u = use(ai, { call: !!body.call }), who = NAME[u.prov];
    if (!u.key && u.prov !== 'openai') throw fail(503, '没配出声的 Key：在设置「TA 的声音」里填（这个 AI 单独改了地址或服务商的话，设置里的 Key 不会带过去）');
    if (!u.voice) throw fail(503, '这个 AI 还没设音色');
    const [lo, hi] = SPEED[u.prov], speed = Math.min(hi, Math.max(lo, u.speed));
    const json = { 'content-type': 'application/json' };
    let out;
    if (u.prov === 'elevenlabs') {
      out = await post(`${u.url}/text-to-speech/${encodeURIComponent(u.voice)}?output_format=mp3_44100_128`, { ...json, accept: 'audio/mpeg', 'xi-api-key': u.key },
        JSON.stringify({ text, model_id: u.model, ...(speed !== 1 ? { voice_settings: { speed } } : {}) }), u.key, who);
      out.type = 'audio/mpeg';
    } else if (u.prov === 'cartesia') {
      out = await post(`${u.url}/tts/bytes`, { ...json, authorization: 'Bearer ' + u.key, 'x-api-key': u.key, 'cartesia-version': CARTESIA_VER },
        JSON.stringify({ model_id: u.model, transcript: caText(text), voice: { mode: 'id', id: u.voice }, output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
          language: CJK.test(text) ? 'zh' : 'en', ...(speed !== 1 ? { generation_config: { speed } } : {}) }), u.key, who);
      out.type = 'audio/mpeg';
    } else if (u.prov === 'minimax') {
      const r = await post(`${u.url}/t2a_v2`, { ...json, authorization: 'Bearer ' + u.key },
        JSON.stringify({ model: u.model, text, stream: false, voice_setting: { voice_id: u.voice, speed, vol: 1, pitch: 0 }, audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 } }), u.key, who);
      let j = null; try { j = JSON.parse(r.buf.toString('utf8')); } catch { /* 下面报 */ }
      const hex = j?.data?.audio;
      if (!hex || (j.base_resp && j.base_resp.status_code)) throw fail(502, `${who} 没给声音${j?.base_resp?.status_msg ? '：' + scrub(j.base_resp.status_msg, u.key) : ''}`);
      out = { buf: Buffer.from(hex, 'hex'), type: 'audio/mpeg' };
    } else {
      const url = /\/audio\/speech$/.test(u.url) ? u.url : u.url + '/audio/speech';
      out = await post(url, { ...json, ...(u.key ? { authorization: 'Bearer ' + u.key } : {}) },
        JSON.stringify({ model: u.model, input: text, voice: u.voice, response_format: 'mp3', ...(speed !== 1 ? { speed } : {}) }), u.key, who);
      if (!/^audio\//.test(out.type)) out.type = 'audio/mpeg';
    }
    if (!out.buf.length) throw fail(502, `${who} 回的是空的`);
    log('声音', ai, `念了 ${[...text].length} 字（${u.prov}${body.call ? '，打电话' : ''}）`);
    return out;
  }

  // ---- 认字 ----
  function sttConf({ call = false } = {}) {
    const d = svcRead(), fm = d.fm || {};
    const s = call && d.opts?.callSvc === 'own' && fm.cstt?.url ? fm.cstt : fm.stt;
    if (!s?.url || !s?.model) return null;
    return { url: trim(s.url), model: s.model, key: keyFor(s, s.url), words: String(d.opts?.asrWords || '') };
  }
  async function transcribe(c, buf, type) {
    const ext = /webm/.test(type) ? 'webm' : /ogg/.test(type) ? 'ogg' : /wav/.test(type) ? 'wav' : /mpeg|mp3/.test(type) ? 'mp3' : 'm4a';
    const auth = c.key ? { authorization: 'Bearer ' + c.key } : {};
    if (/dashscope/.test(c.url) && /asr/i.test(c.model)) {
      const url = /\/chat\/completions$/.test(c.url) ? c.url : c.url + '/chat/completions';
      const msgs = [...(c.words ? [{ role: 'system', content: [{ type: 'text', text: '说话人常说的词：' + c.words }] }] : []),
        { role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${type};base64,${buf.toString('base64')}` } }] }];
      const r = await post(url, { 'content-type': 'application/json', ...auth }, JSON.stringify({ model: c.model, stream: false, messages: msgs }), c.key, '认字服务');
      let j = null; try { j = JSON.parse(r.buf.toString('utf8')); } catch { throw fail(502, '认字服务回的不是 JSON'); }
      return String(j?.choices?.[0]?.message?.content || '').trim();
    }
    const url = /\/audio\/transcriptions$/.test(c.url) ? c.url : c.url + '/audio/transcriptions';
    const b = 'yd' + crypto.randomBytes(12).toString('hex');
    const field = (n, v) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`);
    const body = Buffer.concat([field('model', c.model),
      // 常被认错的词当提示：只有 OpenAI 官方明说收 prompt，别家不确定收不收，先不带
      ...(c.words && /(^|\.)openai\.com$/.test((() => { try { return new URL(url).hostname; } catch { return ''; } })()) ? [field('prompt', c.words.slice(0, 500))] : []),
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="voice.${ext}"\r\nContent-Type: ${type}\r\n\r\n`), buf, Buffer.from(`\r\n--${b}--\r\n`)]);
    const r = await post(url, { 'content-type': 'multipart/form-data; boundary=' + b, ...auth }, body, c.key, '认字服务');
    let j = null; try { j = JSON.parse(r.buf.toString('utf8')); } catch { throw fail(502, '认字服务回的不是 JSON'); }
    return String(j?.text || '').trim();
  }
  // req：请求本身（请求体是录音字节）。先把录音存进 files，再认字。回 { text, file, url, size }
  // 认字没成：录音照样存着，报错里带上 file（前端还能画语音条、让她重试或自己打字）
  async function stt(req, { call = false } = {}) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!/^audio\/[a-z0-9.+-]+$/.test(type)) { req.resume(); throw fail(415, 'Content-Type 要是 audio/…（webm、mp4、mpeg、wav、ogg）'); }
    if (!files) { req.resume(); throw fail(404, '没有这个地址'); }
    const c = sttConf({ call });
    if (!c) { req.resume(); throw fail(503, '没配认字：在设置「语音转文字」里填地址和模型'); }
    const buf = await new Promise((ok, no) => {
      const chunks = []; let n = 0, over = false;
      req.on('data', (x) => { if (over) return; n += x.length; if (n > STT_MAX) { over = true; no(fail(413, '录音太大了（最大 10 MB）')); req.resume(); } else chunks.push(x); });
      req.on('end', () => { if (!over) ok(Buffer.concat(chunks)); });
      req.on('error', no);
    });
    const saved = files.saveBuf(buf, 'voice', { audio: true });
    const t0 = Date.now();
    let text;
    try { text = await transcribe(c, buf, type); } catch (e) {
      throw Object.assign(fail(e.code === 502 ? 502 : 500, '认字没成：' + e.message), { extra: { file: saved.id, url: saved.url } });
    }
    log('认字', `${Math.round(buf.length / 1024)} KB → ${[...text].length} 字，用了 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
    return { text, file: saved.id, url: saved.url, size: saved.size };
  }

  return { get, put, use, tts, stt, sttConf };
}
