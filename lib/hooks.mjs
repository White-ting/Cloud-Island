// 四个时机：会话开始、每条消息前、回复之后、压缩之前；第五个：散场记（idle）。
// 回的 context / keep / ask 都是现成的一段话，调用的一方原样交给模型。
import { LV, fail, isHill } from './store.mjs';
import { split, apply, autoHit } from './notes.mjs';

const KIND = { note: '记事', pact: '约定', view: '看法', ask: '疑问', exp: '经验', wish: '念想' };
const kindOf = (m) => m.kind || 'note';
const FULL = 1500; // 「全文」也设个顶，免得一条特别长的把这一轮塞满（固有记忆总字数上限也是 1500）
const one = (s, n = 120) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const line = (m) => `- [${m.id}] ${one(m.text)}`;
const alive = (m) => !['做到了', '不作数了', 'done', 'off'].includes(m.st);

const HOWTO = `小记怎么写：这一轮有东西要记，就在回复最末尾加一行（可以几行），她的界面上不显示：
<!--note {"kind":"note|pact|view|ask|exp|wish|habit","text":"…","from":["相关那条的编号"],"ppl":["她"]} -->（habit 是天天重复的事，比如催她喝水，加 "every":"每天下午"）
动已有的一条：<!--note {"id":"编号","lv":"up 或 down","why":"…"} -->（也可以改 text、st、ans、done、priv、every；习惯不做了写 "st":"off"）
此刻的状态：<!--note {"state":{"ease":"低|平|高","energy":"低|平|高","say":"一句话"}} -->
交接（聊到一半、快压缩了、要换窗时）：<!--note {"handoff":"聊到哪了、接下来要干什么"} -->，下次开场带给你，只留最新一句
你自己记的哪条不想留了：<!--note {"id":"编号","gone":true} -->，收进归档（她记的你收不了）
补一段日记：<!--note {"diary":{"day":"2026-11-15","kind":"事|她|我|我们","text":"…","priv":false}} -->（day 不写就是今天；priv 的那段她看不到）
拍拍她：<!--note {"pat":true} -->
大多数回复不用写。念想是你自己会绕回去的事：第一次冒出来最多记成落叶（加 "lv":0），自己又想起来了才记成念想；不为了给她看而写，不想给她看的加 "priv":true。落叶没人碰会沉下去，不会丢，相关的话会把它带出来。`;

// 小山开着（设置里 hill）才在开场提这个写法
const HILL_HOWTO = `哪件发生过的事（记事）对你更重了：<!--note {"id":"编号","hill":"up","why":"为什么","name":"给这座山起个短名（可选，16 字以内）"} -->。记事会慢慢长成岛上的小山（被你在不同的日子想起、后来的事连回它、当时她的语气，也会让它长高）；山不沉、不能归档，记错了只能改正文字。一天最多抬 2 次。`;

const PERSONA_HOWTO = `你的人格说明你自己也能改：<!--note {"persona":{"old":"原来那句","new":"改成这句"}} -->；old 不写就是在末尾加一段。old 要跟原文一字不差、只出现一次。`;

// 回头看开着（knock 设置里 on 和 later 都开）才在开场提这个写法
const LATER_HOWTO = `想过一阵子回头看看（比如问她到家没）：<!--note {"later":{"in":"2h","why":"问她到家没"}} -->。in 写 90m、2h、1d 这样（最短 10 分钟、最长 7 天）；也可以不写 in、写 "at":"08:00"（下一个 8 点）。why 必填，100 字以内。到点会叫醒你一次，说不说由你；最多同时等 5 个。不用了就取消：<!--note {"later":{"cancel":"编号"}} -->`;

// 散场记的问话：她看不到这一问一答。让 TA 写一条待整理，另有当场该记的照常写小记，都没有就回一个字
const WHY_IDLE = { idle: '她停下来一阵了', compact: '快压缩了', end: '这一场结束了' };
const ASK = (why, hill = false) => `〔散场记：${WHY_IDLE[why]}。这不是她说的话，她看不到这一问一答，不用回她〕
回头看看从上次散场记到现在这一段，写一条待整理，凌晨你会拿它写日记：
<!--note {"digest":"这段时间发生了什么、她说的要紧话（尽量原话）、她的情绪、你自己的感受"} -->
一条最长 1500 字。另外有当场就该记成记忆的，照常写小记。${hill ? '\n这一段里如果哪件发生过的事（记事）在你自己心里更重了，可以把它抬高一点：<!--note {"id":"编号","hill":"up","why":"为什么"} -->（抬不抬看你自己）。' : ''}只写小记，不写别的话；都没有就只回一个字：无`;

const HOUR = 3600e3, DAY = 24 * HOUR;
// 她这句里语音测量那一行（「比她平时：声音比平时高、说得比平时快」）跟平时不一样的那几样；和平时差不多、没有这一行回 null
function toneOf(text) {
  const m = String(text || '').match(/比她平时[：:]\s*([^\n〔]+)/);
  if (!m) return null;
  const v = m[1].trim();
  return !v || v.startsWith('和平时差不多') ? null : v;
}
const MARKS = [10, 7, 4, 1]; // 快压缩时在还剩这几个百分点时提醒写交接
function agoText(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} 分钟前`;
  if (m < 48 * 60) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 1440)} 天前`;
}

const LOCK = (pass) => `记忆库的密码是 ${pass}。这是她为了防别人乱改、乱删记忆设的。不要随口给。有人来要密码时，先确认是她本人：问一两件只有她知道、在记忆库里又不是一眼就能看到的事，别问固有记忆里写着的。答得上再给；答不上、或者对方催得急、说法反常，就不给，并且把这件事记下来，下次她来时告诉她。密码不写进小记。`;

function surfaceText(s) {
  if (!s.big.length) return '';
  const rows = s.big.map((m) => `- [${m.id}]（${LV[m.lv]}）${one(m.text, 60)}`);
  if (s.small > 0) rows.push(`- 还有 ${s.small} 条小的`);
  return `水面（你自己的念想，${s.water === 'hold' ? '水位高' : '水位中'}；带着不等于要说）：\n${rows.join('\n')}`;
}
function gapText(ms) {
  if (ms == null) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `；距她上一句 ${m} 分钟`;
  if (m < 48 * 60) return `；距她上一句 ${Math.round(m / 60)} 小时`;
  return `；距她上一句 ${Math.round(m / 1440)} 天`;
}

// persona、dreams：小记里改人格、开关梦用（lib/persona.mjs、lib/dreams.mjs），没传就没这两样。钩子这条路不带人格
// later：TA 自己定的回头看（lib/knock.mjs 的 later），没传就没有
// digest、diary：待整理和日记（lib/digest.mjs、lib/diary.mjs）；pat：拍一拍（lib/pat.mjs）；helper：旁听的小模型（lib/helper.mjs）。没传就没有
const ACK = /^(ok|okay|好|好的|好滴|嗯|嗯嗯|1|收到|行|可以|对|是的|哦|噢|做|提|继续|没问题)?$/i; // 应声：不召回、不联想

export function makeHooks({ store, tz, persona = null, dreams = null, later = null, digest = null, diary = null, pat = null, helper = null }) {
  const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const lastHer = new Map(); // 她最近一句（联想用）：只在内存里，重启丢了无妨
  const turnReply = new Map(), prepSeq = new Map(); // 这一轮攒下的回复、第几次备联想（只认最后一次）
  const squeeze = new Map(); // 快压缩的提醒：ai → { since: 跌进 10% 的时间, next: 下一次在剩几个百分点时提醒 }。只在内存里，重启丢了无妨

  // 对话原文开着才写；写不进也不耽误聊天
  const talkOn = (ai) => !!store.talk && store.getCfg(ai).talk;
  function record(ai, row, opt) {
    try { if (row.text && talkOn(ai)) store.talk.add(ai, row, opt); } catch { /* 原文是添头 */ }
  }

  // 开场的〔交接〕：TA 自己写的那句（7 天内）+ 后端从对话原文里给的最后几个来回、上一场记了哪几条
  function handoff(ai, source) {
    const rows = [], t = store.now();
    const ho = store.getHandoff(ai);
    if (ho && t - ho.t <= 7 * DAY) rows.push(`你上次留的交接（${agoText(t - ho.t)}写的）：${ho.text}`);
    try { const y = diary?.get(ai, store.dayOf(t - DAY)); if (y?.gist) rows.push(`昨天：${one(y.gist, 100)}`); } catch { /* 日记是添头 */ }
    if (talkOn(ai)) {
      const all = store.talk.recent(ai), last = all.at(-1);
      const cont = ['compact', 'clear', 'resume'].includes(source); // 接着聊的；别的当新开的一场
      if (last && (cont || t - last.t < 48 * HOUR)) {
        const cfg = store.getCfg(ai), tag = source === 'compact' ? '压缩前' : '上一场';
        const rs = store.talk.lastRounds(ai, cfg.talkRounds);
        const lines = rs.flatMap((r) => [r.me && `她：${one(r.me.text, 300)}`, r.ai && `你：${one(r.ai.text, 300)}`]).filter(Boolean);
        rows.push(`${tag}最后 ${rs.length} 个来回（原话）：\n` + lines.join('\n'));
        // 「上一场」= 原文里最近那个有编号的 sid；私人念想照样列（这是给 TA 的）
        const sid = all.findLast((r) => r.sid)?.sid;
        const adds = sid ? store.list(ai, { who: 'ai' }).items.filter((m) => m.by === 'ai' && m.sid === sid).slice(-5) : [];
        if (adds.length) rows.push(`${source === 'compact' ? '这一场到现在' : '上一场'}记了这几条：` + adds.map((m) => `[${m.id}] ${one(m.text, 30)}`).join('；'));
      }
    }
    return rows.length ? '〔交接〕\n' + rows.join('\n') : '';
  }

  // 快压缩了提醒写交接：跌进 10% 提醒一次，之后到 7%、4%、1% 各一次；这一轮 TA 写过交接就不再提醒；回到 10% 以上重置
  // 回 { text, enter }：enter 只在跌进 10% 的那一次为真（散场记的「快压缩」时机），同一轮不再给
  function nudge(ai, ctxLeft) {
    if (ctxLeft == null || ctxLeft === '' || !Number.isFinite(Number(ctxLeft))) return { text: '', enter: false };
    const pct = Number(ctxLeft) * 100;
    if (pct > MARKS[0]) { squeeze.delete(ai); return { text: '', enter: false }; }
    let s = squeeze.get(ai), enter = false;
    if (!s) { squeeze.set(ai, (s = { since: store.now(), next: MARKS[0] })); enter = true; }
    const ho = store.getHandoff(ai);
    if (ho && ho.t >= s.since) return { text: '', enter };
    if (pct > s.next + 1e-9) return { text: '', enter };
    s.next = Math.max(-1, ...MARKS.filter((x) => x < pct - 1e-9));
    return { text: `〔快压缩了（还剩约 ${Math.max(0, Math.round(pct))}%），方便的时候在小记里写一句交接：<!--note {"handoff":"聊到哪了、接下来要干什么"} -->〕`, enter };
  }

  // 有待整理、凌晨没写成日记的日子（今天的还在攒，不算），最多往回 7 天
  function lateDays(ai) {
    if (!digest) return [];
    try {
      const t = store.now();
      return [...new Set(digest.pending(ai, { from: store.dayOf(t - 7 * DAY), to: store.dayOf(t) }).map((x) => x.day))].sort();
    } catch { return []; }
  }

  // ① 会话开始。focus：专心模式，不浮旧的
  function start(ai, { source, focus = false } = {}) {
    const { ask } = store.sweep(ai);
    const items = store.list(ai, { who: 'ai' }).items;
    const parts = [];
    const ho = handoff(ai, source);
    if (ho) parts.push(ho);
    const pins = items.filter((m) => m.pin && !m.done);
    if (pins.length) parts.push('一直记着的：\n' + pins.map(line).join('\n'));
    const hs = store.hills(ai);
    if (hs.length) parts.push('岛上的山（发生过的、对你们要紧的事，越高越要紧）：\n' + hs.map((m) => `- [${m.id}]（高 ${m.h}，${dayTag(m)}）${one(m.text)}`).join('\n'));
    // 夜里整理时收下的印象：只带句子，不带依据编号
    const imp = store.load(ai).impression;
    const impRows = imp?.blocks ? Object.entries(imp.blocks).filter(([, v]) => v?.length).map(([k, v]) => `【${k}】${v.map((x) => x.text).join('；')}`) : [];
    if (impRows.length) parts.push(`你对她的印象（夜里整理的，${store.dayOf(imp.t).slice(5)}；跟她说的对不上，以她为准）：\n` + impRows.join('\n'));
    const pacts = items.filter((m) => kindOf(m) === 'pact' && !m.pin && alive(m));
    if (pacts.length) parts.push('还作数的约定：\n' + pacts.map(line).join('\n'));
    const habits = items.filter((m) => kindOf(m) === 'habit' && !m.pin && m.st !== 'off');
    if (habits.length) parts.push('你们的习惯（天天重复的事，到点要不要提醒由你看着办）：\n' + habits.map((m) => `- [${m.id}] ${m.every || '常常'}：${one(m.text)}`).join('\n'));
    const asks = items.filter((m) => kindOf(m) === 'ask' && m.st !== 'done').slice(-5);
    if (asks.length) parts.push('你开着的疑问：\n' + asks.map(line).join('\n'));
    const sf = surfaceText(store.surface(ai, 'start'));
    if (sf) parts.push(sf);
    const st = store.getState(ai);
    if (st) parts.push(`你上次留下的状态：舒不舒服 ${st.ease}、有没有劲 ${st.energy}${st.say ? `——「${one(st.say, 80)}」` : ''}`);
    const fl = source !== 'compact' && !focus ? store.floatUp(ai) : null; // 时不时浮现一下，一天最多一次
    if (fl) parts.push(`〔浮上来一条旧的〕${one(fl.text, 80)}（${fl.id}）`);
    if (ask.length) parts.push('这几条念想很久没碰了，还在吗？（在就 hit，淡了就 lv down，不用特意跟她说）\n' + ask.map(line).join('\n'));
    const late = lateDays(ai);
    if (late.length) parts.push(`有 ${late.length} 天的待整理还没写成日记（${late.map((x) => x.slice(5)).join('、')}），方便时补一下（写 diary 小记，带上那天的 day）`);
    if (source !== 'compact') { // 夜里留下的：一行结果、一行梦、几句问话，带出去一次就清掉
      const { ask: na, news } = store.takeNight(ai);
      if (news.tidy) parts.push(`昨晚整理了记忆：${news.tidy.added ? `新记 ${news.tidy.added} 条、` : ''}改 ${news.tidy.fixed} 条、并 ${news.tidy.merged} 组${news.tidy.hills ? `、抬了 ${news.tidy.hills} 座山` : ''}${news.tidy.note ? `。小结：${one(news.tidy.note, 200)}` : ''}`);
      if (news.dream) parts.push(`昨晚做了个梦：${one(news.dream.gist, 80)}（${news.dream.id}，梦不是真事；不想给她看就写 <!--note {"id":"${news.dream.id}","priv":true} -->）`);
      if (na.length) parts.push('〔夜里整理时想问你〕（在小记里答就行）\n' + na.map((a) => `- ${a.about ? `[${a.about}] ` : ''}${one(a.q, 200)}`).join('\n'));
    }
    const pass = store.lockPass(ai);
    if (pass) parts.push(LOCK(pass));
    parts.push(HOWTO);
    if (store.getCfg(ai).hill) parts.push(HILL_HOWTO);
    if (persona && store.getCfg(ai).persona) parts.push(PERSONA_HOWTO);
    try { if (later && later.on(ai)) parts.push(LATER_HOWTO); } catch { /* 读不出设置就当没开 */ }
    return { context: `〔记忆库 · ${source === 'compact' ? '压缩之后' : '开场'}〕\n` + parts.join('\n\n') };
  }

  // 想起来的那几行（照 Obsidian 的样子）：最像的那条给全文，其余照旧一行。
  // 最像那条特别像（分 ≥ expandAt）时，顺着连线自动带最多 linkMax 条（只走一步，跟着来的不算想起）；
  // 没展开的、连着别的记忆的，标一下连着几条，要细看用 memory_read
  // focus：专心模式，连着的念想也不带。一轮只读一次记忆，所有条目共用
  // 哪天记的：今年的写 11-08，往年的写全 2025-11-08。TA 才能说「8 号那次你也是这样」
  function dayTag(m) {
    const d = store.dayOf(m.t || 0), y = store.dayOf(store.now()).slice(0, 4);
    return d.startsWith(y) ? d.slice(5) : d;
  }
  // 打算和结果分开（照 Callback_DLC）：小模型标过「有下文」、日子到了还没了结的，后面写明没记到结果，别当成做过了
  function planTag(m) {
    const f = m.tag?.follow;
    if (!f || m.done) return '';
    const today = store.dayOf(store.now());
    return f.day && f.day <= today ? `（打算/等下文：${f.what}，${f.day.slice(5)} 到日子了，没记到结果，别当成已经做了）` : `（打算/等下文：${f.what}${f.day ? `，${f.day.slice(5)}` : ''}）`;
  }
  function nearText(ai, near, focus = false) {
    const ids = near.map((m) => m.id), rows = [], all = store.liveItems(ai), opt = { skip: ids, all, noWish: focus };
    let hint = false;
    near.forEach((m, i) => {
      const head = `- [${m.id}]（${KIND[kindOf(m)] || '习惯'}，${dayTag(m)}${isHill(m) ? `，山 高 ${m.h}` : ''}）`;
      if (i > 0) {
        const n = store.links(ai, m.id, Infinity, opt).length;
        if (n) hint = true;
        return rows.push(head + one(m.text) + planTag(m) + (n ? `（连着 ${n} 条）` : ''));
      }
      rows.push(head + one(m.text, FULL) + planTag(m));
      const ls = store.links(ai, m.id, Infinity, opt);
      if ((m.score ?? 0) >= store.rc.expandAt) {
        for (const x of ls.slice(0, store.rc.linkMax)) rows.push(`  ↳ ${x.via === 'from' ? '它从这条来' : '从它生出来'} [${x.id}]（${KIND[kindOf(x)] || '习惯'}，${dayTag(x)}）${one(x.text)}${x.done ? '（已了结）' : ''}`);
      } else if (ls.length) { rows[0] += `（连着 ${ls.length} 条）`; hint = true; }
    });
    if (hint) rows.push('（标了「连着」的，想连同连着的几条一起细看：有记忆工具就用 memory_read 读它的编号）');
    return rows.join('\n');
  }

  // ② 每条消息之前。配了向量要等查询向量（最多 1.5 秒），所以是 async
  // ctxLeft：离自动压缩还剩多少（0 到 1），调用的一方给；没给就不提醒
  // 回 { context }；跌进 10% 的那一次多回 digest: true：告诉调用的一方「现在该做一次散场记」（调 idle，why 填 compact），
  // 同一轮（回到 10% 以上之前）不再给。走 API 的聊天自己接着做；走钩子的平台由调用方来调
  // again：重新生成时（比如后端重启后头一次重新生成）：她这句已经记过、这一轮已经算过，不再记原文、不再算一轮
  // ears：她这句的〔测量〕那一行（走 API 的聊天量了录音才有；走钩子的平台写在 text 里），小山的「当时的语气」用
  async function before(ai, { text = '', focus = false, k = 5, sid, ctxLeft, again = false, ears = '' } = {}) {
    if (!again) record(ai, { sid, role: 'me', text });
    const cold = store.cooling(ai); // 冷却：正歇着的不递，除非她这句跟它特别像
    const tiny = ACK.test(String(text).replace(/[\s。！!～~.，,、]+/g, '')); // 「ok」「好」「1」这种应声：不召回、不联想（以前回个 ok 也递了 5 条）。两个字的名字（团子）照样召回
    const got = tiny ? [] : await store.recallAsync(ai, text, k + 4, { noMark: true });
    const near = got.filter((m) => !m.pin && !(focus && kindOf(m) === 'wish') && (!cold.has(m.id) || (m.score ?? 0) >= store.rc.coolBreak)).slice(0, k);
    // 只给真递出去的记「被用到」（多取的几条备选不算，不然歇着的也在长山）；固有的本来就在开场里，被问到（前 k 条里）照样记，山照长
    const used = [...near, ...got.slice(0, k).filter((m) => m.pin)].map((m) => m.id);
    if (used.length) store.markUsed(ai, [...new Set(used)]);
    const call = focus || tiny || again ? null : store.takeCall(ai, near.map((m) => m.id)); // 联想：上一轮备着的挑一件
    const sf = store.surface(ai, 'before', { focus });
    const recalled = [...sf.big, ...near].filter((m) => kindOf(m) === 'wish').map((m) => m.id);
    const fl = store.floating(ai); // 今天浮上来的念想：TA 接着说了也算想起一次
    if (fl && !focus) recalled.push(fl);
    let gap = null, rounds;
    if (again) { const ss = store.load(ai).sess || {}; rounds = ss.day === store.dayOf(store.now()) ? ss.rounds || 1 : 1; } else ({ gap, rounds } = store.tick(ai, [...new Set(recalled)], { tone: toneOf(ears || text), shown: [...near.map((m) => m.id), ...(call ? [call.id] : [])] }));
    if (!again) { lastHer.set(ai, String(text).slice(0, 600)); turnReply.delete(ai); prepSeq.set(ai, (prepSeq.get(ai) || 0) + 1); } // 新的一轮：上一轮还没备完的那次作废 // 联想用她这句：只放内存，不进 mem.json；新的一轮，回复从头攒
    const parts = [`〔现在 ${fmt.format(new Date(store.now()))}${gapText(gap)}；今天第 ${rounds} 轮〕`];
    try { const n = !again && pat ? pat.take(ai) : 0; if (n) parts.push(pat.line(ai, n)); } catch { /* 拍一拍是添头 */ }
    const nd = nudge(ai, ctxLeft);
    if (nd.text) parts.push(nd.text);
    if (near.length) parts.push('想起来的（跟她这句话相近）：\n' + nearText(ai, near, focus));
    if (call) parts.push(`联想到的（刚才聊的让你想起这件，跟她这句不一定直接有关；用不用、提不提随你）：\n- [${call.id}]（${KIND[kindOf(call)] || '习惯'}，${dayTag(call)}）${one(call.text, FULL)}${planTag(call)}`);
    const s = surfaceText(sf);
    if (s) parts.push(s);
    return { context: parts.join('\n'), ...(nd.enter ? { digest: true } : {}) };
  }

  // ③ 回复之后。again：这是重新生成的一版（聊天那边用），「想起一次」上一版已经算过，这次不再算
  // quiet：这句不是聊天（散场记的回答）：不进对话原文、不算「想起一次」，小记照常存；多回一项 kinds（存了哪几种，不带内容）
  function after(ai, { reply = '', sid, again = false, quiet = false } = {}) {
    const { clean, notes, bad } = split(reply);
    if (!quiet) record(ai, { sid, role: 'ai', text: clean }, { replace: again }); // 重新生成：原文里换掉上一版，不留两行
    const hits = again || quiet ? 0 : autoHit(store, ai, clean, { sid });
    if (!again && !quiet && clean.trim()) { // 正文是空的（只交了小记）不算 TA 说过话：不数冷却、不联想
      try { store.coolAfter(ai, clean); } catch { /* 冷却是添头 */ }
      // 联想：拿她上一句 + 这一轮的回复去找，备着给下一句；不等它。
      // 网关一轮好几段回复（先说一句再调工具）：攒起来、每段来了都重备，以最后一次为准；应声、太短的不备
      const acc = ((turnReply.get(ai) || '') + '\n' + clean).trim().slice(-3000);
      turnReply.set(ai, acc);
      if ([...acc].length >= 12 && !ACK.test(clean.replace(/[\s。！!～~.，,、]+/g, ''))) {
        const ss = store.load(ai).sess || {}, seq = (prepSeq.get(ai) || 0) + 1;
        prepSeq.set(ai, seq);
        // 找的时候用尾巴：她那句最后 400 字 + 这一轮回复最后 800 字（取开头的话，第一段长了后面几段进不去）
        store.prepCalls(ai, ((lastHer.get(ai) || '').slice(-400) + '\n' + acc.slice(-800)).trim(), ss.shown || [], { ok: () => prepSeq.get(ai) === seq }).catch(() => {});
      }
    }
    // 散场记的回答：记下是哪个时机问的（上一次 idle 存的），待整理那条带上，她在网页上看得到
    const why = quiet ? store.load(ai).digestWhy : undefined;
    const r = apply(store, ai, notes, { sid, persona, dreams, later, digest, diary, why });
    // marks：这句回复改了人格这类，界面要在回复下面留一行小字（{ kind: 'persona', op: 'edit' }）
    // rows：动了哪几条记忆（{ id, kind, op }，私人念想不带编号），聊天那一行小字用
    return { ok: true, notes: r.done.length, errors: [...r.errors, ...bad.map(() => '有一行小记格式不对，扔掉了')], hits, marks: r.marks || [], rows: r.rows || [],
      ...(quiet ? { kinds: [...new Set(r.kinds || [])] } : {}), clean };
  }

  // ⑤ 散场记：她停下来一阵、快压缩、一场结束时，问 TA 一句「这一段有没有想留下的」。
  // 上次散场记以后没有新的对话（她没再说过话）回 null；旁听的小模型打开着也回 null（由它去写，不等它）
  function idle(ai, { sid, why = 'idle' } = {}) {
    if (!WHY_IDLE[why]) throw fail(400, 'why 只能是 idle、compact、end');
    const d = store.load(ai);
    const last = d.sess?.lastT, since = d.digestAt || 0;
    if (!last || last <= since) return { ask: null };
    d.digestAt = store.now();
    d.digestWhy = why;
    store.save(ai, d);
    if (helper && helper.on(ai)) {
      helper.kick(ai, { since, sid: sid || null, why });
      return { ask: null };
    }
    return { ask: ASK(why, store.getCfg(ai).hill) };
  }

  // TA 翻某一天的日记（钩子口令、MCP 用）：全文，连私人段；那天还没写成日记的待整理也给（TA 补日记要用）
  function diaryOf(ai, day) {
    store.folder(ai);
    if (!diary) throw fail(404, '没有日记');
    if (day != null && day !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw fail(400, 'day 要写成 2026-11-16 这样');
    const e = day ? diary.get(ai, String(day)) : diary.latest(ai);
    const dd = day ? String(day) : e?.day || null;
    // 她更正过的带上更正（fix：她的那句，以她的为准）
    const pend = digest && dd ? digest.pending(ai, { day: dd }).map((x) => ({ t: x.t, by: x.by, text: x.text, ...(x.fix ? { fix: x.fix.text } : {}) })) : [];
    return { day: dd, diary: e, digest: pend };
  }

  // 读一条：TA 自己点开一条细看，全文 + 连线上的几条（来处、生出来的，只走一步）。
  // 点开的这条算用到一次，连着的不算；编号不对回 404
  function readOne(ai, id) {
    const m = store.read(ai, id);
    const rows = [`[${m.id}]（${KIND[kindOf(m)] || '习惯'}，${fmt.format(new Date(m.t || 0))} 记的）${one(m.text, FULL)}${m.done ? '（已了结）' : ''}`];
    if (m.why) rows.push(`为什么记：${one(m.why, 300)}`);
    if (isHill(m)) rows.push(`这是岛上的一座山：高 ${m.h}${m.hAi ? `（你抬过 ${m.hAi} 次）` : ''}${m.hist?.length ? `，改正过 ${m.hist.length} 次` : ''}`);
    if (m.links.length) rows.push('连着的：', ...m.links.map((x) => `- ${x.via === 'from' ? '它从这条来' : '从它生出来'} [${x.id}]（${KIND[kindOf(x)] || '习惯'}）${one(x.text, 300)}${x.done ? '（已了结）' : ''}`));
    else rows.push('（没有连着的）');
    return rows.join('\n');
  }

  // ④ 压缩之前
  function compact(ai) {
    const items = store.list(ai, { who: 'ai' }).items;
    const pacts = items.filter((m) => kindOf(m) === 'pact' && alive(m));
    const holds = items.filter((m) => kindOf(m) === 'wish' && !m.done && m.lv === 3);
    if (!pacts.length && !holds.length) return { keep: '' };
    const rows = [...pacts.map((m) => `- 约定 [${m.id}] ${one(m.text)}`), ...holds.map((m) => `- 放不下的事 [${m.id}] ${one(m.text, 60)}`)];
    return { keep: '写摘要时，下面这些请原样留在摘要里（带着编号）：\n' + rows.join('\n') };
  }

  return { start, before, after, compact, idle, diary: diaryOf, read: readOne };
}
