#!/usr/bin/env node
// 云岛的后端 —— 主程序。启动：node backend.mjs（或 npm start）
// 设置写在同目录的 .env 里（照 .env.example 抄一份改）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './lib/store.mjs';
import { createServer, checkDirs } from './lib/server.mjs';
import { makeHooks } from './lib/hooks.mjs';
import { openVec, makeEmbed } from './lib/vec.mjs';
import { openTalk } from './lib/talk.mjs';
import { openPersona } from './lib/persona.mjs';
import { openDreams } from './lib/dreams.mjs';
import { makeNight, makeRunner, makeApiRunner } from './lib/night.mjs';
import { makeMemModel } from './lib/memmodel.mjs';
import { openChat } from './lib/chat.mjs';
import { openEars } from './lib/ears.mjs';
import { openInbox } from './lib/inbox.mjs';
import { openKnock, makeHandlers } from './lib/knock.mjs';
import { makeMcp } from './lib/mcp.mjs';
import { openDigest } from './lib/digest.mjs';
import { openDiary } from './lib/diary.mjs';
import { openPat } from './lib/pat.mjs';
import { openSvc } from './lib/svc.mjs';
import { openTranslate } from './lib/translate.mjs';
import { openFiles } from './lib/files.mjs';
import { openLockwords } from './lib/lockwords.mjs';
import { openVoice } from './lib/voice.mjs';
import { openPush } from './lib/push.mjs';
import { makeHelper, makeSlotGuard } from './lib/helper.mjs';
import { makeNet } from './lib/net.mjs';

export const VERSION = '1.3.0';
const here = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig(baseDir = here, env = process.env) {
  const f = path.join(baseDir, '.env');
  const kv = {};
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) kv[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const get = (k, d) => env[k] ?? kv[k] ?? d;
  // 聊天的各家 key：data/ais.json 里只写环境变量的名字（keyEnv），用到时才从环境或 .env 里取。不放进设置的任何一项
  const keyOf = (name) => (/^[A-Z_][A-Z0-9_]*$/.test(String(name)) ? String(get(name, '')) : '');
  return {
    keyOf,
    host: get('HOST', '127.0.0.1'),
    port: Number(get('PORT', 18400)),
    dataDir: path.resolve(baseDir, get('DATA_DIR', 'data')),
    webDir: get('WEB_DIR', 'web') ? path.resolve(baseDir, get('WEB_DIR', 'web')) : '', // 网页放哪个文件夹：默认 web，后端顺带把网页发出去，/ 就是 WEB_INDEX；写成空的（WEB_DIR=）就只有接口
    webIndex: get('WEB_INDEX', 'index.html'),
    tz: get('TZ_NAME', ''),          // 哪个时区算「一天」，不写用这台机器的
    hookToken: get('HOOK_TOKEN', ''), // 钩子、守门人用的口令
    webPassword: get('WEB_PASSWORD', ''),   // 网页口令（可选）：写了，网页和接口都要先登录
    sessionSecret: get('SESSION_SECRET', ''), // 登录 cookie 的签名钥匙：不写就启动时随机一个（重启后要重新登录）
    cookieSecure: /^(1|true|yes)$/i.test(get('COOKIE_SECURE', '')), // 只走 https 时打开；不写的话看请求头 x-forwarded-proto
    allowedHosts: get('ALLOWED_HOSTS', ''), // 用隧道、局域网、Tailscale 的名字打开时，那个名字要写在这里（逗号隔开）
    trustProxy: get('TRUST_PROXY', ''),     // 前面隧道、反代的地址：只有它们连进来时才看 X-Forwarded-For（登录限速认人用）
    helperKeyOrigins: get('HELPER_KEY_ORIGINS', ''), // 旁听的小模型用环境变量作 Key 时，这个变量能发到哪（变量名=https://域名）
    allowUrls: get('ALLOW_URLS', ''),       // 网页设置里能填的本机、局域网、http 地址（比如本机语音、Ollama）和自建的 Bark 服务器
    gatewayKey: get('GATEWAY_KEY', ''), // 网关口令，写在 App 的接口地址里：/gw/{口令}/{ai}。没设网关就不开
    upstream: {                       // 网关（/gw/ 开头的地址）往哪转。只写到域名（和端口），不带 /v1；没配的那一家回 502
      openai: get('UPSTREAM_OPENAI', ''),
      anthropic: get('UPSTREAM_ANTHROPIC', ''),
      gemini: get('UPSTREAM_GEMINI', ''),
    },
    embed: {                          // 向量（可选）：没写 EMBED_URL 就只用字面匹配
      url: get('EMBED_URL', ''),
      model: get('EMBED_MODEL', ''),
      key: get('EMBED_KEY', ''),
    },
    translate: {                      // 思考翻译（可选）：设置里「翻译」那一项没填时用这三项；都没有就关
      base: get('TRANSLATE_BASE', ''),
      model: get('TRANSLATE_MODEL', ''),
      key: get('TRANSLATE_KEY', ''),
    },
    push: {                           // 推送（可选）：VAPID 联系方式；Bark 在设置里没填时用这两项
      subject: get('PUSH_SUBJECT', ''),
      barkUrl: get('BARK_URL', ''),
      barkAes: get('BARK_AES', ''),
    },
    night: {                          // 夜里的「临时的 TA」（可选）：NIGHT_CMD 和 NIGHT_API_URL 二选一，都不写夜里什么都不做
      cmd: get('NIGHT_CMD', ''),
      timeout: (Number(get('NIGHT_TIMEOUT', 300)) || 300) * 1000,
      apiUrl: get('NIGHT_API_URL', ''),
      apiKey: get('NIGHT_API_KEY', ''),
      model: get('NIGHT_MODEL', ''),
      style: get('NIGHT_API_STYLE', 'openai'),
    },
  };
}

async function main() {
  const cfg = loadConfig();
  try { checkDirs(cfg); } catch (e) { console.error('没启动：' + e.message); process.exit(1); } // 先查，别等数据写进网页文件夹
  if (!cfg.hookToken) console.error('提醒：.env 里没写 HOOK_TOKEN，钩子和守门人会连不上（网页不受影响）');
  if (!cfg.webPassword) console.error('提醒：没设网页口令（.env 的 WEB_PASSWORD），网页只能在这台电脑上用 localhost / 127.0.0.1 打开；要从手机、隧道打开先设口令');
  const net = makeNet({ allow: cfg.allowUrls }); // 网页设置里填的地址能不能用（出声、认字、翻译、旁听的小模型、Bark）
  const vec = cfg.embed.url ? openVec({ dir: cfg.dataDir, embed: makeEmbed(cfg.embed) }) : null;
  // 对话原文留 48 小时（交接、夜里整理用）；留不留看记忆库设置里的 talk
  const store = openStore({ dir: cfg.dataDir, tz: cfg.tz, vec, talk: openTalk({ dir: cfg.dataDir }) });
  const log = (...a) => console.error(new Date().toISOString(), ...a);
  const persona = openPersona({ store }), dreams = openDreams({ store });
  const runner = makeRunner(cfg.night);
  // 待整理、日记、拍一拍；旁听的小模型（默认关，key 跟聊天一样从环境变量取）
  const digest = openDigest({ store }), diary = openDiary({ store }), pat = openPat({ store });
  // 网页设的小模型（旁听的、记忆小模型）共用一套检查：地址过 net，Key 要在 HELPER_KEY_ORIGINS 登记过能发到哪
  const slotGuard = makeSlotGuard({ net, keyOrigins: cfg.helperKeyOrigins });
  const helper = makeHelper({ store, digest, keyOf: cfg.keyOf, log, guard: slotGuard });
  // 记忆小模型：夜里整理记忆前先出一段补充（打标、同一件事、到日子的、印象草稿）。每个 AI 各自设，默认关
  const svc = openSvc({ dir: cfg.dataDir, net }); // 设置里要填的服务（翻译、认字、出声、推送…），Key 只进不出
  const memModel = makeMemModel({ store, tz: cfg.tz, keyOf: cfg.keyOf, runnerOf: makeApiRunner, log, guard: slotGuard, svc });
  // 主动找人：设置、守门、TA 自己定的回头看。总开关默认关
  const knock = openKnock({ store, dir: cfg.dataDir, tz: cfg.tz, info: (ai) => chat.info(ai) });
  const hooks = makeHooks({ store, tz: cfg.tz, persona, dreams, later: knock.later, digest, diary, pat, helper });
  // 聊天（走 API 的 TA）：有哪几个 AI 写在 data/ais.json；key 从环境变量取（ais.json 里只写变量名）
  // onWake：TA 主动说了一句之后推送；onReply：她发一句、TA 回完以后，网页不在前台就推送
  const files = openFiles({ dir: cfg.dataDir }); // 她传的图和文件；聊天发给模型时要读
  let chat = null;
  const nameOf = (ai) => { try { return chat.ais().find((a) => a.id === ai)?.name || ai; } catch { return ai; } };
  const push = openPush({ dir: cfg.dataDir, svc, env: cfg.push, nameOf, log, net });
  const pushOf = (kind) => (ai, m, o = {}) => (kind === 'wake' && o.push === false ? null : push.notify(ai, { kind, text: m.text }));
  chat = openChat({ dir: cfg.dataDir, store, hooks, persona, pat, files, ears: openEars({ dir: cfg.dataDir }), upstream: cfg.upstream, keyOf: cfg.keyOf, log, tz: cfg.tz, onWake: pushOf('wake'), onReply: pushOf('reply') });
  // 重启前还没问的散场记：按剩下的时间重新挂上（定时器只在内存里，重启就丢了）
  try { const n = chat.boot(); if (n) log('散场记', `重启后重新挂上 ${n} 个`); } catch (e) { log('散场记重新挂定时器出错', e.message); }
  // 收件箱：会叫醒 TA 的事（敲门、空下来、夜里、回头看）先进这张表，一个 AI 一次做一件；TA 正在回她的话时不取
  let inbox = null;
  const night = makeNight({ store, persona, dreams, digest, diary, runner, tz: cfg.tz, dir: cfg.dataDir, log, enqueue: (ai, x) => inbox.put(ai, x), memModel });
  inbox = openInbox({ dir: cfg.dataDir, store, handlers: makeHandlers({ knock, chat, night }), busy: (ai) => chat.busy(ai) || night.busy(ai), log, auto: true });
  inbox.boot(); // 上次没做完的（进程断了）按挂了处理
  const mcp = makeMcp({ hooks, version: VERSION, log });
  const translate = openTranslate({ dir: cfg.dataDir, svc, env: cfg.translate, log, net }); // 思考翻译
  const lockwords = openLockwords({ dir: cfg.dataDir, folder: (ai) => store.folder(ai), ask: (ai, p) => chat.ask(ai, p, { what: 'lockwords' }), log }); // 开屏字幕
  const voice = openVoice({ dir: cfg.dataDir, svc, folder: (ai) => store.folder(ai), files, log, net }); // 出声、认字
  let srv;
  try { srv = createServer({ cfg, store, hooks, persona, night, dreams, chat, inbox, knock, mcp, digest, diary, pat, helper, memModel, svc, files, translate, lockwords, voice, push, log }); } catch (e) {
    console.error('没启动：' + e.message); process.exit(1);
  }
  const addr = await srv.listen();
  console.log(`后端 ${VERSION} 已启动：http://${addr.address}:${addr.port}（数据在 ${cfg.dataDir}；${vec ? '向量开着' : '没配向量，只用字面匹配'}；夜里${runner ? '的临时 TA 配好了' : '没配临时的 TA，不整理也不写梦'}）`);
  // 每分钟一次：夜里到点了往收件箱放一件、回头看到点了往收件箱放一件，然后把收件箱里排着的做掉
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    (async () => {
      await night.tick().catch((e) => log('夜里调度出错', e.message));
      try { knock.timers.fire((ai, x) => inbox.put(ai, x)); } catch (e) { log('回头看调度出错', e.message); }
      await inbox.pumpAll();
    })().catch((e) => log('每分钟那次检查出错', e.message)).finally(() => { busy = false; });
  }, 60e3);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    try { store.flush(); vec?.close(); } catch (e) { console.error('关机前写盘出错', e.message); }
    Promise.all([srv.close(), chat.dsh.closeAll().catch(() => {})]).then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
