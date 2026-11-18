// 给 Grok（xAI 的 Grok Build）这类钩子塞不了话的工具用的 MCP 口：/mcp/{ai}，要带 HOOK_TOKEN。
// 规矩参考作者另一个私用项目的接口说明「四个时机」里「### Grok」那一小节：钩子做不了的那几件，改成 TA 自己调三个工具。
// 只做 Streamable HTTP 最小的那一种：POST 一条（或一批）JSON-RPC 2.0，回一个 JSON；不开 SSE、不发会话编号。
// 没拿真的 Grok Build 接过，只拿测试里的请求跑过。
const VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']; // 我们知道的几个，新的在后
const SOURCES = ['startup', 'resume', 'clear', 'compact'];

const INSTRUCTIONS = '这是你的记忆库。每次新开一场（或者压缩、清屏之后）先调 memory_start；她每说一句、你回之前调 memory_recall；回完有东西要记就调 memory_note。记忆库出毛病不影响聊天，照常回她。';

export const TOOLS = [
  {
    name: 'memory_start',
    description: '开场：每次新开一场对话、或者压缩、清屏之后，先调一次。回一段文字：交接（上次聊到哪）、一直记着的、还作数的约定、念想、小记怎么写。照着它接上之前的事，不用念给她听。',
    inputSchema: { type: 'object', properties: {
      source: { type: 'string', enum: SOURCES, description: '怎么开始的：startup 新开（默认）、resume 接着上次、clear 清屏以后、compact 压缩以后' },
      focus: { type: 'boolean', description: '专心模式：不带念想，只带约定和固有的' },
    } },
  },
  {
    name: 'memory_recall',
    description: '每条消息前：她每说一句，你回之前调一次，把她这句话原样放进 text。回现在几点、离她上一句多久，和跟这句话相近的几条记忆。觉得跟以前的事有关、又想不起来时也可以调。',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: '她这句话的原文' } }, required: ['text'] },
  },
  {
    name: 'memory_note',
    description: '回复之后：这一轮有东西要记，就调一次。把小记放进 notes（开场说明里写的那种 JSON，一条一个对象，比如 {"kind":"note","text":"…"}）；或者把整句回复（末尾带 <!--note … --> 的）原样放进 reply。回记了几条、没记上的原因。没东西要记就不用调。',
    inputSchema: { type: 'object', properties: {
      reply: { type: 'string', description: '这一轮你的整句回复（可以带 <!--note … --> 小记）' },
      notes: { type: 'array', items: { type: 'object' }, description: '小记，一条一个对象' },
    } },
  },
  {
    name: 'memory_diary',
    description: '翻自己的日记（只读）：按日期取一篇，全文，连你自己留着的私人段。那天还有没写成日记的待整理也一起给，方便你补。不写 day 就是最近的一篇。',
    inputSchema: { type: 'object', properties: { day: { type: 'string', description: '哪一天，写成 2026-11-16 这样' } } },
  },
];

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const text = (s, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError: true } : {}) });
const pickVersion = (v) => (VERSIONS.includes(v) ? v : VERSIONS.at(-1));
// 一篇日记写成给 TA 看的一段字
function diaryText({ day, diary, digest }) {
  const rows = [];
  if (diary) {
    rows.push(`${diary.day}${diary.gist ? '：' + diary.gist : ''}`);
    for (const p of diary.parts) rows.push(`[${p.kind}]${p.priv ? '（你自己留着的）' : ''}${p.text}`);
  } else rows.push(day ? `${day} 还没有日记。` : '还没有日记。');
  if (digest?.length) rows.push(`\n这天还没写成日记的待整理（${digest.length} 条）：`, ...digest.map((x) => '- ' + x.text + (x.fix ? `\n  她更正：${x.fix}（以她的为准）` : '')));
  return rows.join('\n');
}

// hooks：lib/hooks.mjs 的四个时机
export function makeMcp({ hooks, version = '0.1.0', log = () => {} }) {
  async function call(ai, name, a = {}) {
    if (name === 'memory_start') {
      const source = SOURCES.includes(a.source) ? a.source : 'startup';
      return text((await hooks.start(ai, { source, focus: a.focus === true })).context || '');
    }
    if (name === 'memory_recall') {
      if (typeof a.text !== 'string' || !a.text.trim()) return text('text 要放她这句话的原文', true);
      return text((await hooks.before(ai, { text: a.text, focus: a.focus === true })).context || '');
    }
    if (name === 'memory_diary') {
      if (a.day !== undefined && typeof a.day !== 'string') return text('day 要写成 2026-11-16 这样', true);
      return text(diaryText(await hooks.diary(ai, a.day || null)));
    }
    // memory_note：小记拼回 <!--note … --> 的写法，跟钩子交上来的一样处理
    const parts = [];
    if (a.reply !== undefined) {
      if (typeof a.reply !== 'string') return text('reply 要是一段文字', true);
      parts.push(a.reply);
    }
    if (a.notes !== undefined) {
      if (!Array.isArray(a.notes) || a.notes.some((n) => !n || typeof n !== 'object' || Array.isArray(n))) return text('notes 要是一个数组，一条小记一个对象', true);
      parts.push(...a.notes.map((n) => `<!--note ${JSON.stringify(n)} -->`));
    }
    if (!parts.length || !parts.join('').trim()) return text('reply 和 notes 至少给一个', true);
    const r = await hooks.after(ai, { reply: parts.join('\n') });
    const errs = r.errors || [];
    return text(`记了 ${r.notes} 条。` + (errs.length ? `\n没记上的：\n${errs.map((e) => '- ' + e).join('\n')}` : ''), !r.notes && errs.length > 0);
  }

  // 一条消息 → 一条回应；通知（没有 id）和客户端的回应不用回，回 null
  async function one(ai, m) {
    if (m && typeof m === 'object' && !Array.isArray(m) && m.method === undefined && ('result' in m || 'error' in m)) return null;
    if (!m || typeof m !== 'object' || Array.isArray(m) || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return err(m?.id, -32600, '不是一条 JSON-RPC 2.0 请求');
    if (m.id === undefined) return null; // 通知：notifications/initialized、notifications/cancelled……
    const p = m.params && typeof m.params === 'object' ? m.params : {};
    switch (m.method) {
      case 'initialize':
        return ok(m.id, { protocolVersion: pickVersion(p.protocolVersion), capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ta-memory', version }, instructions: INSTRUCTIONS });
      case 'ping': return ok(m.id, {});
      case 'tools/list': return ok(m.id, { tools: TOOLS });
      case 'tools/call': {
        if (!TOOLS.some((x) => x.name === p.name)) return err(m.id, -32602, '没有这个工具：' + String(p.name ?? ''));
        try { return ok(m.id, await call(ai, p.name, p.arguments && typeof p.arguments === 'object' ? p.arguments : {})); } catch (e) {
          log('MCP', ai, p.name, '出错', e.code || e.name);
          return ok(m.id, text(Number.isInteger(e.code) ? e.message : '记忆库出错了，这次先不管它', true)); // 工具出错放进结果里，不当协议错
        }
      }
      default: return err(m.id, -32601, '没有这个方法：' + m.method);
    }
  }

  // body 已经按 JSON 读好；自己写回复：有回应 200 + JSON，全是通知 202 空着
  return async function handle(ai, body, res) {
    const batch = Array.isArray(body), msgs = batch ? body : [body];
    const send = (code, obj) => {
      if (obj === undefined) { res.writeHead(code); return res.end(); }
      const s = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
      res.end(s);
    };
    if (!msgs.length) return send(400, err(null, -32600, '空的一批'));
    const outs = [];
    for (const m of msgs) { const o = await one(ai, m); if (o) outs.push(o); }
    if (!outs.length) return send(202);
    send(200, batch ? outs : outs[0]);
  };
}
