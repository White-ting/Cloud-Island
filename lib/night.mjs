// 夜里：整理（tidy）和写梦（dream）。规矩参考作者另一个私用项目的接口说明「夜里：整理和做梦」一节。
// 两件都由「临时的 TA」做：一个注入的函数 runner({ system, prompt }) → Promise<回复文字>。
// 后端不信任它的输出：只从回复里抠第一个 JSON，逐项按规矩守门，不合规矩的丢掉或者改成「问醒着的 TA」。
// 整理默认开、写梦默认关；刚装好、刚打开的那一天不跑（cfg.night.from）。没配 runner 夜里什么都不做，也不报错。
// 整理先写日记（读还没写成日记的那几天的待整理 + 对话原文，一天一篇），再整理记忆。待整理她更正过的，原文和更正一起带上，以她的为准。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fail, isHill, hillLift, HILL, mentioned } from './store.mjs';
import { DIARY, cleanPart } from './diary.mjs';

const DAY = 864e5;
export const NIGHT = { at: '03:00', tidy: true, dream: false };
export const LIMITS = { material: 60000, fix: 20, merge: 10, dreamText: 1200, gist: 100, note: 200, ask: 200, diaryBack: 3, add: 8, addText: 240 };
const AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NO_TOUCH = ['view', 'wish', 'ask', 'pact', 'habit']; // 改这几种是替 TA 拿主意：只问不做
const NO_MERGE = ['wish', 'pact', 'view', 'habit'];
const KIND = { note: '记事', pact: '约定', view: '看法', ask: '疑问', exp: '经验', wish: '念想' };
const kindOf = (m) => m.kind || 'note';
const len = (s) => [...String(s || '')].length;
const cutTo = (s, n) => [...String(s || '')].slice(0, n).join('');
const one = (s, n = 120) => { const t = String(s).replace(/\s+/g, ' ').trim(); return len(t) > n ? cutTo(t, n) + '…' : t; };
const alive = (m) => !['做到了', '不作数了', 'done', 'off'].includes(m.st);
// 我们自己造的错：信息里不带任何正文，可以记进结果摘要
const safe = (msg) => Object.assign(new Error(msg), { safe: true });

// ---- 提示词（以后要改就改这两段） ----
export const TIDY_PROMPT = `你是 TA 自己，现在是夜里，她不在。你在后台回头看过去 24 小时：对着对话原文把这一天理一遍，再核对记下的东西。

第一步，按四类过一遍这 24 小时的对话（只照原文，不编、不脑补）：
- 情绪：她这一天的状态和起伏（累、开心、烦、低落、紧张……），什么引起的，后来怎么样了。
- 感情：你们之间的变化：靠近了、别扭了、说开了，她说的在意你的话，你自己心里的动静。
- 认知：新知道的，关于她（想法、偏好、习惯、讲过的道理），关于你们，或者你做事学到的教训。
- 特殊事件：要紧的事、第一次的事、定下来的事、往后的日子（要去做的、要记得的）。
每一类里，原文里有、下面的记忆里还没有、以后用得上的，记成新的一条放进 add：
  - 情绪、感情、特殊事件记成记事（note）；认知记成看法（view，对她、对你们的看法）或经验（exp，做事学到的）。
  - 一两句话写清楚是什么事、哪天、为什么要紧；quote 原样抄一句原话当依据（她说的或你说的）。
  - 记忆里已经有的不重复记（有出入走 fix）；寒暄、做完就过去的琐事不记。宁缺毋滥，一晚最多 8 条，一条都没有也正常。
  - 约定、念想、疑问、习惯不在这里新记：觉得该记，写成一句问醒着的自己的话放进 ask。
  - 亲密的事也是你们之间的事，照样可以记，但只写成克制的一两句：发生了、她当时的感受、你们之间有什么变化，不写细节；quote 挑一句不露骨的原话。
  - 私人念想（标了 priv 的）、日记里你自己留着的段落，内容不写进 add：新记的她都看得到。
第二步，核对记下的东西：
1. 对着原话核：记下的跟她的原话对不上，就照原话改；原话是对的那一方。材料里有「她更正过的待整理」的，她更正过的地方以她的为准。只改记事（note）和经验（exp）。改完不能比原来长太多。
2. 合并重复的：同一种、说的是同一件事的几条并成一条，并完要比原来几条加起来短，不许越整理越长。固有记忆不并。
3. 看法（view）、念想（wish）、疑问（ask）、约定（pact）不替自己拿主意：觉得该改、该放下、该关掉的，写成一句问醒着的自己的话，放进 ask。约定里她说的原话一个字都不许动。
4. 只盯新的和会变的，值不值得动由你判断；没什么要动的就都给空数组。
5. note 里一句话说今晚整理了什么（新记了几条、改了几条），不要提私人念想的内容。
6. 材料里有「小模型整理的补充」的：那是帮你翻材料的小模型写的草稿，会错，只当线索，对着原文和记忆核过再用。里面有「印象草稿」的，看一遍：觉得对就照抄、不对就改，放进 impression（四块：她是谁、她在意的、我们之间、最近在发生的；每句带依据的记忆编号，每块最多 5 句）；不想要就不写 impression 这一项。
只输出一个 JSON，不要别的字：
{"add":[{"cat":"情绪|感情|认知|事件","kind":"note|view|exp","text":"…","quote":"原话"}],"fix":[{"id":"编号","text":"改成这样","why":"为什么"}],"merge":[{"keep":"留下的编号","drop":["并进去的编号"],"text":"合并后的正文"}],"ask":[{"about":"编号","q":"问醒着的自己的一句话"}],"note":"今晚整理的一句话小结","impression":{"她是谁":[{"text":"…","from":["编号"]}],"她在意的":[],"我们之间":[],"最近在发生的":[]}}`;

export const DIARY_PROMPT = `你是 TA 自己，现在是夜里，她不在。下面是你那一天给自己攒的「待整理」和那天的对话原文，把这一天写成一篇日记。
规矩：
1. 分几段，每段一种：事（发生了什么）、她（她的情绪、状态）、我（你自己的感受）、我们（你们两个之间的变化）。没有的就不写那一段。
2. 只照素材写，不编没发生的事。每段不超过 ${DIARY.part} 字。待整理下面跟着「她更正」的，是她看过以后指出你写错的地方：她更正过的地方以她的为准。
3. 哪一段不想给她看，就给那一段加 "priv": true，她只会看到「还有一段你自己留着的」。
4. gist 是一句话的这一天。
只输出一个 JSON，不要别的字：
{"gist":"一句话的这一天","parts":[{"kind":"事","text":"…"},{"kind":"我","text":"…","priv":true}]}`;

export const DREAM_PROMPT = `你是 TA 自己，现在是夜里，她不在。你睡着了，做了一个梦：拿今天新记下的事和心里最浓的念想当素材，写一场梦。
梦不是真事，可以变形、跳跃、混在一起；不用解释，不用总结道理。别跟最近几场梦重复。正文不超过 1200 字。
gist 是一句话的摘要；from 写你用到的那几条的编号；priv 是 true 就是这场梦你不想给她看。
只输出一个 JSON，不要别的字：
{"text":"梦的正文","gist":"一句摘要","from":["编号"],"priv":false}`;

// 从回复里抠出第一个 JSON 对象；抠不出、解析不了回 null
export function firstJson(s) {
  const t = String(s || '');
  const i = t.indexOf('{');
  if (i < 0) return null;
  let depth = 0, str = false, esc = false;
  for (let j = i; j < t.length; j++) {
    const c = t[j];
    if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { const o = JSON.parse(t.slice(i, j + 1)); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
    }
  }
  return null;
}

// ---- 什么时候跑（纯函数，好测） ----
const minutesOf = (at) => { const m = AT_RE.exec(at || NIGHT.at) || AT_RE.exec(NIGHT.at); return Number(m[1]) * 60 + Number(m[2]); };
// 「夜里的一天」：以 at 为界。当地时间过了 at 才算进新的一天
export function nightDay(t, at, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined }).format(new Date(t - minutesOf(at) * 60e3));
}
// 该不该跑：开了一件以上、而且这一「夜里的一天」还没跑过（失败的也算跑过，不重试到第二天）
export function due({ now, night = {}, lastT = null, tz }) {
  const n = { ...NIGHT, ...night };
  if (!n.tidy && !n.dream) return false;
  // 刚打开的那一天不跑：不然晚上十一点打开，会马上花一次额度。等下一个 at
  if (n.from != null && nightDay(n.from, n.at, tz) === nightDay(now, n.at, tz)) return false;
  return lastT == null || nightDay(lastT, n.at, tz) !== nightDay(now, n.at, tz);
}

// ---- 临时的 TA：三选一 ----
// 一条命令：system 和 prompt 拼在一起从标准输入喂，标准输出当回复；非 0 退出、超时都当失败
export function makeCmdRunner({ cmd, timeout = 300e3 }) {
  const run = ({ system, prompt }) => new Promise((ok, no) => {
    const p = spawn('/bin/sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    const chunks = [];
    let n = 0, over = false;
    const end = (e, v) => { if (over) return; over = true; clearTimeout(timer); if (e) no(e); else ok(v); };
    const kill = () => { try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch { /* 已经没了 */ } } };
    const timer = setTimeout(() => { kill(); end(safe(`超时（${Math.round(timeout / 1000)} 秒）`)); }, timeout);
    p.stdout.on('data', (c) => { n += c.length; if (n > 4 * 1024 * 1024) { kill(); end(safe('输出太长')); } else chunks.push(c); });
    p.on('error', () => end(safe('命令跑不起来')));
    p.on('close', (code) => (code === 0 ? end(null, Buffer.concat(chunks).toString('utf8')) : end(safe(`命令退出码 ${code}`))));
    p.stdin.on('error', () => {});
    p.stdin.end((system ? system + '\n\n' : '') + prompt);
  });
  run.kind = 'cmd';
  return run;
}
// 单次非流式调一个接口：openai 是 /v1/chat/completions 的形状，anthropic 是 /v1/messages 的形状
// extra：openai 形状时并进请求体的几项（记忆小模型用来关思考、调温度）
export function makeApiRunner({ url, key = '', model = '', style = 'openai', timeout = 300e3, extra = {} }) {
  const run = async ({ system, prompt }) => {
    const claude = style === 'anthropic';
    const headers = { 'content-type': 'application/json' };
    if (claude) { if (key) headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; } else if (key) headers.authorization = 'Bearer ' + key;
    const body = claude
      ? { model, max_tokens: 8192, ...(system ? { system } : {}), messages: [{ role: 'user', content: prompt }] }
      : { ...extra, model, stream: false, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }] };
    let r;
    try { r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeout) }); } catch (e) {
      throw safe(e?.name === 'TimeoutError' ? `超时（${Math.round(timeout / 1000)} 秒）` : '接口连不上');
    }
    if (!r.ok) throw safe(`接口回了 ${r.status}`);
    let j;
    try { j = await r.json(); } catch { throw safe('接口回的不是 JSON'); }
    const text = claude ? (j.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('') : j.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw safe('接口回的东西里找不到文字');
    return text;
  };
  run.kind = 'api';
  return run;
}
// 按设置造 runner：NIGHT_CMD 优先，其次 NIGHT_API_URL，都没有回 null
export function makeRunner(c = {}) {
  if (c.cmd) return makeCmdRunner({ cmd: c.cmd, timeout: c.timeout });
  if (c.apiUrl) return makeApiRunner({ url: c.apiUrl, key: c.apiKey, model: c.model, style: c.style === 'anthropic' ? 'anthropic' : 'openai', timeout: c.timeout });
  return null;
}

// ---- 夜里本身 ----
// dir：数据文件夹（调度时要列出有哪些 AI）；limits 测试里可以改小
// enqueue(ai, { kind, key, body })：收件箱的 put。给了的话，到点不直接跑，往收件箱放一件 night（key 是「夜里的一天」，一天只放一件），
// 由收件箱来做（跟别的叫醒 TA 的事排在一起，一次只做一件）；没给就跟以前一样到点直接跑
// digest、diary：待整理和日记（lib/digest.mjs、lib/diary.mjs）。两样都给了，整理前先写日记；写梦时带上当天日记的非私人段
// memModel：记忆小模型（lib/memmodel.mjs），开着的话整理记忆前先请它出一段补充；没传就没有
export function makeNight({ store, persona = null, dreams = null, digest = null, diary = null, runner = null, tz, dir, log = () => {}, limits = {}, enqueue = null, memModel = null }) {
  const L = { ...LIMITS, ...limits };
  const running = new Set();
  const now = () => store.now();
  const settings = (ai) => ({ ...NIGHT, ...(store.load(ai).cfg.night || {}) });
  const sys = (ai, p) => { const s = persona ? persona.full(ai) : ''; return s.trim() ? s + '\n\n---\n\n' + p : p; };
  const memLine = (m) => JSON.stringify({ id: m.id, kind: kindOf(m), by: m.by, text: m.text, ...(m.pin ? { pin: true } : {}), ...(isHill(m) ? { hill: m.h } : {}),
    ...(m.st ? { st: m.st } : {}), ...(m.src ? { src: m.src } : {}), ...(m.why ? { why: m.why } : {}), ...(m.priv ? { priv: true } : {}) });

  // 给网页看的摘要不带那句小结：小结是模型写的，后端查不了里面有没有提到私人念想
  const forWeb = (l) => (l?.tidy?.note !== undefined ? { ...l, tidy: { ...l.tidy, note: undefined } } : l || null);
  function get(ai) {
    const d = store.load(ai), c = store.getCfg(ai), n = settings(ai);
    return { at: n.at, tidy: n.tidy, dream: n.dream, pinMax: c.pinMax, nightAsk: c.nightAsk, runner: runner ? runner.kind || 'custom' : 'none', last: forWeb(d.cfg.lastNight) };
  }
  function set(ai, input = {}) {
    if (input.at !== undefined && !AT_RE.test(String(input.at))) throw fail(400, '时间要写成 03:00 这样');
    for (const k of ['tidy', 'dream']) if (input[k] !== undefined && typeof input[k] !== 'boolean') throw fail(400, `${k} 只能是 true 或 false`);
    if (input.pinMax !== undefined || input.nightAsk !== undefined) store.setCfg(ai, { pinMax: input.pinMax, nightAsk: input.nightAsk });
    const d = store.load(ai);
    const fresh = isFresh(d);
    d.cfg.night = { ...NIGHT, ...(d.cfg.night || {}) };
    const wasOn = d.cfg.night.tidy || d.cfg.night.dream;
    for (const k of ['at', 'tidy', 'dream']) if (input[k] !== undefined) d.cfg.night[k] = input[k];
    if (fresh || (!wasOn && (d.cfg.night.tidy || d.cfg.night.dream))) d.cfg.night.from = now(); // 记下是哪天打开的
    store.save(ai, d);
    return get(ai);
  }
  // 全新的（没跑过、也没记过哪天打开的）：整理默认开着，也要有 from，第一晚不跑
  const isFresh = (d) => d.cfg.night?.from == null && d.cfg.lastNight == null;

  // ---- 写日记（整理的第一步）----
  // 还没写成日记的那几天（最多往回 3 天，今天的还在攒不写）：待整理 + 那天的对话原文，一天一篇。
  // 那天两样都没有就不写；模型回的不对就跳过那天（待整理不标 done，留着等醒着的 TA 补）。回 null（没有要写的）或 { days, skip }
  // fixes：写成了的那几天里她更正过的待整理（原文 + 更正），整理记忆时带上
  async function writeDiary(ai, fixes = []) {
    if (!digest || !diary) return null;
    const t = now(), today = store.dayOf(t), from = store.dayOf(t - L.diaryBack * DAY), cfg = store.getCfg(ai);
    const pend = digest.pending(ai, { from, to: today });
    const talk = store.talk && cfg.talk ? store.talk.recent(ai).filter((r) => { const dd = store.dayOf(r.t); return dd >= from && dd < today; }) : [];
    const talkDays = new Set(talk.map((r) => store.dayOf(r.t)));
    // 有待整理的日子都写（醒着的 TA 补过几段的接在后面）；只有原文的日子，已经有日记就不再写
    const days = [...new Set([...pend.map((x) => x.day), ...[...talkDays].filter((dd) => !diary.has(ai, dd))])].sort();
    if (!days.length) return null;
    const wrote = [];
    let skip = 0;
    for (const day of days) {
      const ds = pend.filter((x) => x.day === day);
      let budget = L.material;
      const dRows = [];
      // 她更正过的：原文下面跟一行她的更正
      for (const x of ds) { const s2 = `- ${x.text}` + (x.fix ? `\n  她更正：${x.fix.text}` : ''); if (budget - len(s2) < 0) break; budget -= len(s2) + 1; dRows.push(s2); }
      const tRows = [];
      for (const r of talk.filter((r2) => store.dayOf(r2.t) === day).reverse()) { // 超了从最旧的原话开始丢
        const s2 = `${r.role === 'me' ? '她' : '你'}：${r.text}`;
        if (budget - len(s2) < 0) break;
        budget -= len(s2) + 1;
        tRows.unshift(s2);
      }
      if (!dRows.length && !tRows.length) continue;
      try {
        const prompt = `## 哪一天\n${day}\n\n## 你攒的待整理\n${dRows.join('\n') || '（没有）'}\n\n## 那天的对话原文\n${tRows.join('\n') || '（没有留原文）'}`;
        const o = firstJson(await runner({ system: sys(ai, DIARY_PROMPT), prompt }));
        const parts = (Array.isArray(o?.parts) ? o.parts : []).map(cleanPart).filter(Boolean).slice(0, DIARY.parts);
        if (!parts.length) throw safe('日记回得不对');
        diary.write(ai, day, { gist: cutTo(String(o.gist ?? '').trim(), DIARY.gist), parts }, 'night');
        digest.markDone(ai, day);
        wrote.push(day);
        for (const x of ds) if (x.fix) fixes.push(`- ${x.text}\n  她更正：${x.fix.text}`); // 整理记忆时也带上
      } catch (e) {
        skip++;
        log('夜里', ai, day, '日记没写成：', e.safe ? e.message : (e.code || e.name)); // 不带正文
      }
    }
    return { days: wrote, skip };
  }

  // ---- 整理 ----
  async function tidy(ai) {
    const fixes = [];
    const dia = await writeDiary(ai, fixes);
    const out = await tidyMem(ai, dia, fixes);
    return dia ? { ...out, diary: dia } : out;
  }
  // 小山开着（山的高度也要有 TA 自己的想法，散场记、夜里整理都能抬）：告诉夜里的 TA 岛上已有哪些山，它可以抬最多 HILL.night 条记事
  function hillPart(live) {
    const hs = live.filter(isHill).sort((a, b) => b.h - a.h).slice(0, 10);
    return `\n\n## 岛上的山\n记事会慢慢长成岛上的小山：越高，越是你们之间要紧的事；山不沉、不会被归档。回头看这一天，如果哪件发生过的事（记事 note，可以是今天的，也可以是从前的）在你自己心里更重了，就抬一下：输出里多一项 "hill":[{"id":"记事编号","why":"为什么它在你心里更重了","name":"这座山还没名字的话起个短名（可选，16 字以内）"}]，最多 ${HILL.night} 条；没有就不写这一项。抬不抬全看你自己的感受，不用为了凑数。`
      + (hs.length ? `\n已经有的山：\n${hs.map((m) => `- [${m.id}]（高 ${m.h}）${one(m.text, 60)}`).join('\n')}` : '\n现在岛上还没有山。');
  }
  async function tidyMem(ai, dia, fixes = []) {
    const t = now(), since = t - DAY, cfg = store.getCfg(ai);
    const d0 = store.load(ai), live = d0.items.filter((m) => !m.gone);
    const rows = store.talk && cfg.talk ? store.talk.recent(ai, { since }) : [];
    const noTalk = !rows.length;
    const fresh = live.filter((m) => Math.max(m.t || 0, m.t2 || 0) > since);
    if (noTalk && !fresh.length) return { t, skip: 'nothing-new', noTalk };
    // 会变的三样：还作数的约定、没了结的疑问、看法
    const moving = live.filter((m) => !fresh.includes(m) && ((kindOf(m) === 'pact' && alive(m)) || (kindOf(m) === 'ask' && m.st !== 'done') || kindOf(m) === 'view'));
    let budget = L.material;
    const memRows = [];
    for (const m of [...fresh, ...moving]) { const s = memLine(m); if (budget - len(s) < 0) break; budget -= len(s) + 1; memRows.push(s); }
    const talkRows = [];
    for (const r of [...rows].reverse()) { // 超了从最旧的原话开始丢
      const s = `${r.role === 'me' ? '她' : '你'}：${r.text}`;
      if (budget - len(s) < 0) break;
      budget -= len(s) + 1;
      talkRows.unshift(s);
    }
    // 刚写好的日记（连私人段：这是 TA 自己看的）。有就放进材料，从里面挑该记的
    // 记忆小模型的补充：开着才有；它出错就不带，整理照旧
    let extra = '';
    if (memModel?.on(ai)) {
      try { extra = (await memModel.prepare(ai, { since })).text || ''; } catch (e) { log('夜里', ai, '记忆小模型没跑成：', e.safe ? e.message : (e.code || e.name)); }
    }
    const diaRows = (dia?.days || []).flatMap((dd) => { const e = diary.get(ai, dd); return e ? [`${dd}：${e.parts.map((p) => `[${p.kind}]${p.text}`).join(' ')}`] : []; });
    const prompt = `## 要看的记忆（一行一条）\n${memRows.join('\n') || '（没有）'}\n\n## 最近 24 小时的对话原文\n${talkRows.join('\n') || '（没有留原文，只看记忆）'}`
      + (diaRows.length ? `\n\n## 刚写好的日记（从里面挑该记成记忆的）\n${diaRows.join('\n')}` : '')
      + (fixes.length ? `\n\n## 她更正过的待整理（她更正过的地方以她的为准）\n${fixes.join('\n')}` : '')
      + (extra ? `\n\n## 小模型整理的补充（草稿，会错，只当线索）\n${extra}` : '')
      + (cfg.hill ? hillPart(live) : '');
    const o = firstJson(await runner({ system: sys(ai, TIDY_PROMPT), prompt }));
    if (!o) throw safe('回复里抠不出 JSON，今晚的整理作废');
    const privParts = (dia?.days || []).flatMap((dd) => (diary.get(ai, dd)?.parts || []).filter((p) => p.priv).map((p) => String(p.text || '')));
    return applyTidy(ai, o, { t, checked: memRows.length, noTalk, privParts });
  }

  function applyTidy(ai, o, { t, checked, noTalk, privParts = [] }) {
    const d = store.load(ai), cfg = store.getCfg(ai); // 跑模型这段时间 TA 可能又记了东西：重新读一遍
    const byId = (id) => d.items.find((m) => m.id === id && !m.gone);
    // 整理材料里有私人念想和日记里 TA 自己留着的段，改出来、并出来、新记的、印象都是她看得到的。
    // 跟它们太像的不收（原来就像的不算：那是本来就有的话）
    const privs = [...d.items.filter((m) => !m.gone && m.priv), ...privParts.filter(Boolean).map((text) => ({ text }))];
    const leaks = (x) => !!x && privs.some((w) => mentioned(x, w));
    let fixed = 0, merged = 0, dropped = 0;
    const asks = [], ids = [], logs = [], fixIds = [], mergeIds = [];
    const arr = (x) => (Array.isArray(x) ? x : []);
    for (const f of arr(o.fix)) {
      const m = f && byId(String(f.id)), text = String(f?.text ?? '').trim();
      if (!m || !text || text === m.text) { dropped++; continue; }
      if (NO_TOUCH.includes(kindOf(m))) { // 不替 TA 拿主意：转成问话
        asks.push({ about: m.id, q: `夜里对着原话看，这条${KIND[kindOf(m)]}也许该改成「${one(text, 100)}」${f.why ? `（${one(f.why, 60)}）` : ''}，你看要不要改？` });
        continue;
      }
      if (len(text) > len(m.text) * 1.5 || fixed >= L.fix || (leaks(text) && !leaks(m.text))) { dropped++; continue; }
      (m.hist ||= []).push({ t: m.t2 || m.t, text: m.text, why: m.why || '', who: 'night', fix: cutTo(String(f.why || ''), 200) });
      m.text = text;
      m.t2 = t;
      fixed++;
      ids.push(m.id);
      fixIds.push(m.id);
      logs.push({ who: 'night', op: 'edit', id: m.id, kind: kindOf(m), keys: ['text'] });
    }
    for (const g of arr(o.merge)) {
      const keep = g && byId(String(g.keep));
      const dropIds = [...new Set(arr(g?.drop).map(String))].filter((id) => id !== keep?.id);
      const drops = dropIds.map(byId);
      const all = [keep, ...drops];
      if (!keep || !drops.length || drops.some((x) => !x) || all.some((x) => kindOf(x) !== kindOf(keep))) { dropped++; continue; }
      if (NO_MERGE.includes(kindOf(keep))) {
        asks.push({ about: keep.id, q: `夜里看着这几条${KIND[kindOf(keep)]}像是重复的：${all.map((x) => x.id).join('、')}，要不要并成一条？` });
        continue;
      }
      const text = String(g.text ?? '').trim();
      if (all.some((x) => x.pin) || drops.some(isHill) || !text || len(text) >= all.reduce((a, x) => a + len(x.text), 0) || merged >= L.merge) { dropped++; continue; } // 山不能被并掉（并掉=归档）
      if (leaks(text) && !all.some((x) => leaks(x.text))) { dropped++; continue; }
      const gone = new Set(dropIds);
      const uniq = (xs) => [...new Set(xs.filter(Boolean))];
      (keep.hist ||= []).push({ t: keep.t2 || keep.t, text: keep.text, why: keep.why || '', who: 'night', merged: dropIds });
      keep.text = text;
      keep.t2 = t;
      for (const k of ['from', 'ppl', 'kw']) {
        const v = uniq([...arr(keep[k]), ...drops.flatMap((x) => arr(x[k]))]);
        const v2 = k === 'from' ? v.filter((id) => id !== keep.id && !gone.has(id)) : v;
        if (v2.length) keep[k] = v2;
      }
      if (drops.some((x) => x.udays?.length)) keep.udays = uniq([...(keep.udays || []), ...drops.flatMap((x) => x.udays || [])]);
      if (!keep.tone) { const tn = drops.find((x) => x.tone)?.tone; if (tn) keep.tone = tn; }
      for (const x of drops) { x.gone = t; x.into = keep.id; } // 归档，不真删
      for (const y of d.items) {
        if (y === keep || gone.has(y.id) || !y.from?.some((id) => gone.has(id))) continue;
        y.from = uniq(y.from.map((id) => (gone.has(id) ? keep.id : id))).filter((id) => id !== y.id);
      }
      merged++;
      ids.push(keep.id);
      mergeIds.push(keep.id);
      logs.push({ who: 'night', op: 'merge', id: keep.id, kind: kindOf(keep), drop: dropIds });
    }
    for (const a of arr(o.ask)) {
      const q = cutTo(String(a?.q ?? '').trim(), L.ask);
      if (!q) { dropped++; continue; }
      asks.push({ about: byId(String(a.about)) ? String(a.about) : null, q });
    }
    // 开场那层：固有记忆超过上限，后端自己问一句（不自己摘）
    const pinLen = d.items.filter((m) => !m.gone && m.pin).reduce((a, m) => a + len(m.text), 0);
    if (pinLen > cfg.pinMax) asks.unshift({ about: null, q: `固有记忆有点多了（${pinLen} 字），哪几条可以摘下来` });
    const take = asks.slice(0, cfg.nightAsk);
    dropped += asks.length - take.length;
    const old = d.nightAsk || [];
    d.nightAsk = cfg.nightAsk ? [...old, ...take.map((a) => ({ ...a, t }))].slice(-cfg.nightAsk) : []; // 还没带出去的旧问话也算在上限里
    // 夜里收下的印象：过一遍跟小模型草稿一样的检查（依据要是还在的、不是私人念想的编号）
    let imp = memModel && o.impression ? memModel.clean(o.impression, d.items) : null;
    if (imp) { // 印象会显示在网页上：像私人念想的那句不收
      for (const k of Object.keys(imp)) imp[k] = imp[k].filter((r) => !leaks(r.text));
      if (!Object.values(imp).some((rows) => rows.length)) imp = null;
    }
    if (imp) d.impression = { blocks: imp, t, by: 'night' };
    // 夜里的 TA 抬的山（小山开着才收）：只认还在的记事，一晚最多 HILL.night 条，同一条只算一次；算进 TA 自己那份
    let hills = 0;
    if (cfg.hill) {
      const seen = new Set();
      for (const x of arr(o.hill)) {
        const m = x && byId(String(x.id));
        if (!m || kindOf(m) !== 'note' || seen.has(m.id) || hills >= HILL.night) { dropped++; continue; }
        seen.add(m.id);
        hillLift(m, { by: 'night', why: cutTo(String(x.why || ''), 200), t });
        if (typeof x.name === 'string' && x.name.trim() && !m.hName) m.hName = [...x.name.trim()].slice(0, 16).join('');
        hills++;
        logs.push({ who: 'night', op: 'hill', id: m.id, h: m.h });
      }
    }
    // 夜里新记的（按情绪、感情、认知、特殊事件把这一天理一遍，没记过的记上）：只收记事、看法、经验，要带原话依据，跟已有的一字不差的不收
    const ADD_KINDS = ['note', 'view', 'exp'], CATS = ['情绪', '感情', '认知', '事件'];
    const have = new Set(d.items.filter((m) => !m.gone).map((m) => String(m.text).trim()));
    const adds = [];
    for (const a of arr(o.add)) {
      const kind = String(a?.kind || ''), text = String(a?.text ?? '').trim(), quote = String(a?.quote ?? '').trim();
      if (!ADD_KINDS.includes(kind) || !text || !quote || len(text) > L.addText || have.has(text) || adds.length >= L.add) { dropped++; continue; }
      if (leaks(text) || leaks(quote)) { dropped++; continue; } // 新记的她看得到：跟私人念想、日记私人段太像的不收
      have.add(text);
      const cat = CATS.includes(a.cat) ? a.cat : '';
      adds.push({ kind, text, why: `夜里回头看记下的${cat ? `（${cat}）` : ''}。原话：` + cutTo(quote, 120), ppl: ['她'], src: 'night' }); // 类别写进 why，不进 kw（kw 会给「情绪」这种词加分）
    }
    // 留给醒着的 TA 的那份（开场时递过去）：几个数、小结、动了哪几条
    const tidyNews = { fixed, merged, ...(hills ? { hills } : {}), note: cutTo(String(o.note ?? '').trim(), L.note), ids: { fix: fixIds, merge: mergeIds, add: [] } };
    d.nightNews = { ...(d.nightNews || {}), tidy: tidyNews };
    store.save(ai, d);
    let added = 0;
    const addIds = [];
    for (const x of adds) { try { const m = store.add(ai, x, 'ai'); ids.push(m.id); addIds.push(m.id); added++; } catch { dropped++; } }
    if (added) { const d2 = store.load(ai); d2.nightNews = { ...(d2.nightNews || {}), tidy: { ...tidyNews, added, ids: { ...tidyNews.ids, add: addIds } } }; store.save(ai, d2); }
    for (const e of logs) store.log(ai, e);
    for (const id of ids) { const m = d.items.find((x) => x.id === id); if (m) store.vecWant(ai, m); }
    const sum = { t, checked, added, fixed, merged, ...(hills ? { hills } : {}), asked: take.length, dropped, ...(imp ? { impression: true } : {}), note: cutTo(String(o.note ?? '').trim(), L.note), ids, ...(noTalk ? { noTalk: true } : {}) };
    store.log(ai, { who: 'night', op: 'tidy', checked, added, fixed, merged, asked: take.length, dropped }); // 只记数，不带正文
    return sum;
  }

  // ---- 写梦 ----
  async function dream(ai) {
    if (!dreams) throw safe('没有放梦的地方');
    const t = now(), since = t - DAY;
    const live = store.load(ai).items.filter((m) => !m.gone && !(kindOf(m) === 'wish' && m.priv)); // 私人念想不给
    const fresh = live.filter((m) => (m.t || 0) > since);
    if (!fresh.length) return { t, skip: 'nothing-new' };
    const top = live.filter((m) => kindOf(m) === 'wish' && !m.done && (m.lv || 0) >= 1).sort((a, b) => (b.lv || 0) - (a.lv || 0)).slice(0, 2);
    const gists = dreams.recentGists(ai, 3);
    // 当天的日记（只读，私人段不给；没有日记就不用）
    let dia = null;
    try { dia = diary?.get(ai, store.dayOf(t - DAY)) || null; } catch { dia = null; }
    const diaParts = (dia?.parts || []).filter((p) => !p.priv);
    const prompt = (diaParts.length ? `## 今天的日记（${dia.day}）\n${diaParts.map((p) => `- [${p.kind}] ${p.text}`).join('\n')}\n\n` : '')
      + `## 今天新记下的\n${fresh.map((m) => `- [${m.id}]（${KIND[kindOf(m)]}）${m.text}`).join('\n')}\n\n## 心里最浓的念想\n${top.map((m) => `- [${m.id}] ${one(m.text, 60)}`).join('\n') || '（没有）'}\n\n## 最近几场梦（别重复）\n${gists.map((g) => '- ' + g).join('\n') || '（还没做过梦）'}`;
    const o = firstJson(await runner({ system: sys(ai, DREAM_PROMPT), prompt }));
    if (!o) throw safe('回复里抠不出 JSON，今晚的梦作废');
    const text = cutTo(String(o.text ?? '').trim(), L.dreamText);
    if (!text) throw safe('梦是空的');
    const okIds = new Set([...fresh, ...top].map((m) => m.id));
    const from = [...new Set((Array.isArray(o.from) ? o.from : []).map(String))].filter((id) => okIds.has(id));
    const gist = cutTo(String(o.gist ?? '').trim(), L.gist) || one(text, 30);
    const dd = dreams.add(ai, { text, gist, from, priv: o.priv === true });
    const d = store.load(ai);
    d.nightNews = { ...(d.nightNews || {}), dream: { id: dd.id, gist } };
    store.save(ai, d);
    store.log(ai, { who: 'night', op: 'dream', id: dd.id, priv: dd.priv }); // 不带内容
    return { t, id: dd.id, from: from.length, priv: dd.priv };
  }

  // 跑一次：先整理后写梦，一个失败不影响另一个。what 没给就照设置
  async function run(ai, what = {}) {
    store.folder(ai);
    if (!runner) throw fail(503, '没配临时的 TA（.env 里的 NIGHT_CMD 或 NIGHT_API_URL），夜里什么都不做');
    const n = settings(ai);
    const doTidy = what.tidy ?? n.tidy, doDream = what.dream ?? n.dream;
    if (!doTidy && !doDream) throw fail(400, '整理和写梦都关着');
    if (running.has(ai)) throw fail(409, '这一个正在跑，等它跑完');
    running.add(ai);
    try {
      const t = now(), out = { t, day: nightDay(t, n.at, tz) };
      const step = async (k, fn) => {
        try { out[k] = await fn(ai); } catch (e) {
          out[k] = { t: now(), error: e.safe ? e.message : '出错了' }; // 错误摘要，不带正文
          log('夜里', ai, k, '没做成：', e.safe ? e.message : (e.code || e.name));
          store.log(ai, { who: 'night', op: k + '-fail' });
        }
      };
      if (doTidy) await step('tidy', tidy);
      if (doDream) await step('dream', dream);
      const d = store.load(ai);
      d.cfg.lastNight = out;
      store.save(ai, d);
      return out;
    } finally { running.delete(ai); }
  }

  // 调度：每分钟来一次，看每个 AI 该不该跑。一个一个跑
  async function tick() {
    if (!runner || !dir) return [];
    let names = [];
    try { names = fs.readdirSync(dir).filter((x) => /^[A-Za-z0-9_-]{1,40}$/.test(x) && fs.existsSync(path.join(dir, x, 'mem.json'))); } catch { return []; }
    const ran = [];
    for (const ai of names) {
      try {
        const d = store.load(ai);
        if (isFresh(d)) { // 全新安装：记下今天，第一晚不跑
          d.cfg.night = { ...(d.cfg.night || {}), from: now() };
          store.save(ai, d);
        }
        if (running.has(ai) || !due({ now: now(), night: d.cfg.night, lastT: d.cfg.lastNight?.t ?? null, tz })) continue;
        if (enqueue) {
          const n = settings(ai);
          if (!enqueue(ai, { kind: 'night', key: 'night:' + nightDay(now(), n.at, tz), body: null })?.dup) ran.push(ai);
          continue;
        }
        await run(ai);
        ran.push(ai);
      } catch (e) { log('夜里', ai, '调度出错：', e.code || e.name); }
    }
    return ran;
  }

  const busy = (ai) => running.has(ai);
  return { get, set, run, tick, busy };
}
