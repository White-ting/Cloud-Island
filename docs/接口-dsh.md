# 接口：dsh 的 TA（DeepSeek Harness）

名单（`data/ais.json`）里除了走 API 的 TA，还可以有一种 `kind: "dsh"` 的 TA：后端在这台电脑上拉起 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（命令叫 `dsh`，DeepSeek 官方开源的智能体，MIT），把她说的话交给 dsh 的会话。dsh 的回复、跑了什么工具一边出一边传回前端；dsh 要做越权的事（比如写工作目录外面的文件）会先问，问题转给前端，她点允许或拒绝。

代码在 `lib/dsh.mjs`（只用 Node 自带的模块），测试 `test/dsh.test.mjs`（用 `test/fixtures/fake-dsh.mjs` 当 dsh，不需要装真的）。

> **安全提醒**：dsh 能读写文件、跑命令、上网。给它**单独一个工作目录**，别指向放着私人资料的文件夹；dsh home 也单独一个。默认权限 `workspace-write`：只能写工作目录（和系统临时目录），别的要先问她。

---

## 1. 协议要点（dsh 这边）

dsh 的 SDK 模式：`dsh --profile sdk` 在 stdin/stdout 上说**一行一条**的 JSON-RPC 2.0（官方包 `@deepseek-ai/dsh-sdk-protocol`、服务端插件 `dsh-sdk-jsonrpc-server`）。stdout 只放协议帧，诊断写 stderr。

| 方向 | 方法 | 用法 |
|---|---|---|
| 我们 → dsh | `initialize` | `{ cwd, provider, model, approvalRequests: true, reasoningEffort?, maxTokens? }` → `{ serverInfo: { name: "deepseek-harness-sdk-runtime" } }`。这一步会等插件全部装载好，第一次启动要几秒 |
| 我们 → dsh | `session/prompt` | `{ sessionId, contentBlocks }` → `{ messageId }`（只是「排上队了」的回执，不是回复）。会话 id 由我们定，第一次用就新建 |
| 我们 → dsh | `session/resume` | `{ sessionId, permissionMode? }` → `{}`。换了进程以后接回存在 dsh home 里的旧会话；被打断的那一轮 dsh 自己补好 |
| 我们 → dsh | `session/query` | 跟 prompt 一样，但认 `/permission <预设>` 这类命令。用来改一个会话的权限 |
| 我们 → dsh | `shutdown` | 收拾干净后退出（退出码 0） |
| dsh → 我们（请求） | `approval/request` | `{ sessionId, toolName, callId?, reason? }`，要回 `{ outcome: "allowed-once" \| "rejected" \| "cancelled" }`。只有 `allowed-once` 是放行，而且只放这一次 |
| dsh → 我们（通知） | `session.event` | `{ sessionId, event: { type, data } }`：会话里记下的每件事。用到的：`agent/inbox/spliced`（她那句进了会话，`data.inserted[].id` 对上 messageId）、`assistant/message`（整段回复，`content` 里有 `text` 和 `reasoning`）、`tool/call`（`callId, name, arguments`）、`tool/result`（`message.toolCallId, isError, content`）、`turn/end`（`reason.kind`：completed / error / aborted / max-tokens…） |
| dsh → 我们（通知） | `session.status` | `{ sessionId, status: "running" \| "idle" }`。认到这一句之后又变 idle，这一轮就算完（跟官方 SDK 的 `run()` 一样） |

几件协议本身决定的事：

- **没有「停下这一轮」的方法**。官方说法是「客户端放弃轮次的方式是关闭运行时进程」。所以「停」= 关掉整个 dsh 进程，下一句再拉起来、`session/resume` 接回原会话。
- **字不是一个一个来的**：dsh 只把记进会话日志的事发出来，助手的话是一步说完一整段来一次。前端看到的是一段一段地出。
- 回执（`agent/inbox/spliced`）可能比 `session/prompt` 的回话先到，要先攒着。
- 启动参数：`--profile sdk`（完整版，带权限预设和确认；`sdk-minimal` 没有权限服务，不用）、`--patch <文件>`（叠在 profile 和 home 补丁之上的覆盖层）。环境变量：`DSH_HOME`（必须给，SDK 不会去找 `~/.dsh`）、`DSH_PERMISSION_MODE`（新会话的默认权限，dsh-base 的配置里读它）、`DSH_TELEMETRY_DISABLED=1`（关 OTel 反馈上传）。
- `user-question/ask`（dsh 反问她）这一版没接：握手时不声明 `capabilities.userQuestions`，dsh 就不会发过来。

## 2. ais.json 里一个 dsh TA 怎么写

```json
{
  "id": "dsh",
  "name": "小深",
  "kind": "dsh",
  "dsh": {
    "home": "/Users/me/yundao-dsh/home",
    "workspace": "/Users/me/yundao-dsh/work",
    "bin": "dsh",
    "provider": "siliconflow",
    "model": "deepseek-ai/DeepSeek-V4.1-Flash",
    "keyEnv": "SF_KEY",
    "providers": {
      "siliconflow": {
        "api": "openai-completions",
        "baseURL": "https://api.siliconflow.cn/v1",
        "apiKeyEnv": "SF_KEY",
        "compat": { "supportsDeveloperRole": false, "maxTokensField": "max_tokens" },
        "models": [{ "id": "deepseek-ai/DeepSeek-V4.1-Flash" }]
      }
    }
  }
}
```

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `home` | 是 | | dsh 的家（会话、设置、日志），绝对路径。一个 TA 一个；**不能放在 workspace 里面** |
| `workspace` | 是 | | dsh 干活的目录，绝对路径，要先建好 |
| `bin` | | `dsh` | 命令名（在 PATH 里找）或绝对路径。写的是 `.js`/`.mjs`（比如 `…/node_modules/@deepseek-ai/dsh/lib/bin.js`）就用 `node` 跑它 |
| `node` | | 后端自己的 node | `bin` 是 `.js` 时用哪个 node 跑（dsh 要 Node ≥ 24.9，后端可以是旧一点的 node） |
| `profile` | | `sdk` | dsh 的 profile |
| `permission` | | `workspace-write` | `read-only` / `workspace-write` / `danger-full-access`（后者不问就做，别用） |
| `provider` | | `deepseek-official` | 模型路由名。用官方 DeepSeek 就不用写 `providers`，key 放环境变量 `DEEPSEEK_API_KEY`，`keyEnv` 写 `"DEEPSEEK_API_KEY"` |
| `model` | | `deepseek-v4-flash` | 模型 id |
| `reasoningEffort` / `maxTokens` | | 模型默认 | 原样交给 `initialize` |
| `providers` | | | 自定义提供商（OpenAI 兼容的中转、硅基流动这类），原样写进 dsh 的 `llm-pi-ai` 配置。**key 不许写在这里**（写 `apiKey`、`key`、`token`、`headers` 这类字段会被拒绝），只写 `apiKeyEnv` |
| `keyEnv` | | | 要交给 dsh 的 key 的**环境变量名**（一个或数组）。值在拉起进程时从后端的环境 / `.env` 取，只放进 dsh 进程的环境 |
| `env` | | | 别的不是秘密的环境变量（如 `TZ`）。不能写 `DSH_HOME` 这些由后端定的 |
| `uploadLog` | | `false` | 见下面「为什么关日志上传」 |
| `telemetry` | | `false` | 开 dsh 的 OTel 反馈上传 |
| `approvalTimeout` | | `300` | 确认多少秒没回当拒绝（10–3600） |
| `idleMinutes` | | `30` | 闲了多少分钟关掉 dsh 进程省内存，下一句再起（0 = 不关） |

给前端的名单（`GET /api/ais` 那份）里，dsh 的 TA 长这样：`{ id, name, avatar?, kind: "dsh", model, permission, notes: false }`。前端靠 `kind === "dsh"` 显示「新会话」按钮、藏掉「重新生成」。

后端带给 dsh 进程的环境只有：系统路径、用户目录、语言时区、代理（`HTTP(S)_PROXY`、`NO_PROXY`）、证书（`NODE_EXTRA_CA_CERTS` 等），加上 `env`、`keyEnv` 和 `DSH_*` 几个。后端自己的口令（`HOOK_TOKEN` 等）不给。

## 3. 给前端的接口

### 发一句：`POST /api/chat/:ai/send`（跟别的 TA 一样）

请求体照旧（`text`、`img`、`quote`…）。回的 SSE 跟走 API 的 TA 同形，多了几种事件：

| 事件 | 什么时候 |
|---|---|
| `{ type: "status", state: "starting" }` | 要拉起 dsh 进程（第一次、停过、闲置关过、挂过），可能要几秒。可以显示「dsh 启动中」 |
| `{ type: "think", text }` | 一段思考 |
| `{ type: "delta", text }` | 一段正文（整段来，不是一个字一个字） |
| `{ type: "step", i, kind: "tool", name, input }` | 开始跑一个工具（`input` 是参数，比如 `{ file_path, content }`、`{ command }`） |
| `{ type: "step_end", i, ok, out? }` | 第 `i` 步跑完；`ok: false` 是失败或被拒；`out` 是结果，最多 2000 字 |
| `{ type: "approval", id, tool, reason?, i?, input?, t, until, timeout }` | **dsh 问「这一步行不行」**。`i` 对上哪一步（有的话），`until` 是到期时间（毫秒时间戳），`timeout` 是毫秒数。前端弹出允许 / 拒绝 |
| `{ type: "approval_end", id, outcome }` | 这个确认结束了：`allowed` / `rejected` / `timeout`（超时当拒绝） / `cancelled`（这一轮停了） |
| `{ type: "done", id, me, cut?, msg? }` | 完了。`id` 是存下的 TA 那句；`cut: true` 是被打断（停、进程挂了、出错）；`msg` 是补一句说明（比如「到了输出上限」） |
| `{ type: "error", status, msg, me }` | 没回成（一点内容都没有就出错了）。`status` 409：同一个 dsh home 被两个 TA 用了 / 接不上旧会话（点新会话） |

存进 `chat.jsonl` 的 TA 消息：`{ id, role: "ai", t, text, think?, steps?, cut?, dsh: { session } }`，`steps[i]` 多了 `ok`、`out`、`approval`（`allowed` / `rejected` / `timeout` / `cancelled`）。

### 回答确认：`POST /api/chat/:ai/approve`

请求体 `{ "id": "ap…", "allow": true }`。`allow` 只有严格等于 `true` 才是允许（只放行这一次），别的都是拒绝。

回 `{ ok: true, outcome: "allowed" | "rejected" }`；确认不存在（超时了、答过了、这一轮停了）回 404。结果同时会从发话那条 SSE 里出一个 `approval_end`。

### 还在等的确认：`GET /api/chat/:ai/approvals`

回 `{ items: [{ id, tool, reason?, i?, input?, t, until, left }] }`（`left` 剩多少毫秒）。前端断线重连、切回这个 TA 时用来把弹窗补回来。

### 停：`POST /api/chat/:ai/stop`（跟别的 TA 一样）

协议里没有「停这一轮」，所以是关掉 dsh 进程：发话那条 SSE 会以 `done`（`cut: true`）结束，已经说了的存下来。下一句会重新拉起 dsh（有 `status: starting`），接回原来的会话。

### 新会话：`POST /api/chat/:ai/dsh/new`

换一个 dsh 会话编号，下一句从头开始（dsh 不再记得前面说过的）。旧会话留在 dsh home 里不删。这一轮还在跑时回 409。回 `{ ok: true, session }`。

### 状态：`GET /api/chat/:ai/dsh`

回 `{ kind: "dsh", session, used, alive, busy }`：现在续的会话、发过话没有、dsh 进程在不在、是不是正在回。

### 不支持的（这一版）

重新生成、TA 主动开口（敲门、空下来）、散场记、开屏字幕的单问一句、记忆库的开场和小记：对 dsh 的 TA 都不做（dsh 自己记着上下文，聊天记录里删改一句不影响它）。调这些接口会回 400。

## 4. 集成改动（给 chat.mjs / server.mjs / backend.mjs）

一共 **3 个文件、11 处**：chat.mjs 9 处、server.mjs 1 处（4 条路由）、backend.mjs 1 处。合的时候按上下文找。

### lib/chat.mjs（9 处：import、cleanAi、pub、openDsh、ready、send 里 2 处、boot、return）

```diff
@@ import 区
 import { ASK, eachText, wholeText, makeCut } from './gateway.mjs';
+import { cleanDsh, pubDsh, openDsh } from './dsh.mjs';

@@ function cleanAi(x, i) {
   const at = `第 ${i + 1} 个`;
   if (!x || typeof x !== 'object' || Array.isArray(x)) throw fail(400, `${at}不是一个对象`);
+  if (x.kind === 'dsh') return cleanDsh(x, i);
   const id = String(x.id ?? '');

@@ 给前端看的
-const pub = (a) => ({ id: a.id, ...(a.name ? { name: a.name } : {}), model: a.model, ...(a.avatar ? { avatar: a.avatar } : {}), notes: !!a.notes });
+const pub = (a) => (a.kind === 'dsh' ? pubDsh(a) : { id: a.id, ...(a.name ? { name: a.name } : {}), model: a.model, ...(a.avatar ? { avatar: a.avatar } : {}), notes: !!a.notes });

@@ openChat 里，const callAt = new Map(); 前面
+  const dsh = openDsh({ dir, folder: (ai) => store.folder(ai), keyOf, log, now });

@@ function ready(conf) {   （这样重新生成、主动开口、散场记、单问一句对 dsh 的 TA 都会干净地报 400）
   function ready(conf) {
+    if (conf.kind === 'dsh') throw fail(400, `${conf.id} 是 dsh 的 TA，不支持这个（重新生成、主动开口、散场记、单问一句）`);
     const fam = FAMILY[conf.style], base = conf.url || upstream[fam];

@@ async function send(ai, body = {}, res) {
     const conf = confOf(ai);
-    ready(conf);
+    if (conf.kind === 'dsh') dsh.ready(conf); else ready(conf);
 …
     const timeTag = typeof body.timeTag === 'string' ? cutTo(body.timeTag.trim(), 200) : '';
     // 她刚才拍了拍 …
     let prefix = '';
     try { const n = pat ? pat.take(ai) : 0; if (n) prefix = pat.line(ai, n); } catch (e) { … }
+    if (conf.kind === 'dsh') {
+      // dsh 自己记着上下文：只交她这一句（带时间、拍一拍、引用），回复照常存进 chat.jsonl
+      const byId = new Map([...all, her].map((m) => [m.id, m]));
+      const input = [timeTag, prefix, says(her, byId)].filter(Boolean).join('\n');
+      const save = (f) => {
+        const m = { id: newId(), role: 'ai', t: now(), ...f };
+        append(ai, m);
+        if (!f.cut && f.text.trim()) Promise.resolve(onReply(ai, { id: m.id, text: f.text, again: false })).catch((e) => log('聊天', ai, '回完之后那一步出错：', e.code || e.name));
+        return m.id;
+      };
+      return run(ai, res, (job) => dsh.answer(ai, conf, res, job, { me: her.id, text: input, imgs: imgOut(imgs), save }));
+    }
     clearIdle(ai);

@@ function boot() {   （重启后不给 dsh 的 TA 挂散场记）
     for (const a of readAis()) {
+      if (a.kind === 'dsh') continue;
       try {

@@ return { ais, setAis, … , ask };
-  return { ais, setAis, usage, list, remove, restore, edit, getCtx, setCtx, send, again, stop, readAll, wake, info, busy, said, digest, boot, pat: patMe, ask };
+  return { ais, setAis, usage, list, remove, restore, edit, getCtx, setCtx, send, again, stop, readAll, wake, info, busy, said, digest, boot, pat: patMe, ask, dsh };
```

`stop` 不用改：`dsh.answer` 会把 `job.abort` 换成「关进程」，`chat.stop(ai)` 照旧调 `job.abort()`。

### lib/server.mjs（1 处，4 条路由）

放在 `['POST', /^\/api\/chat\/([^/]+)\/stop$/, …]` 后面、通用的 `/api/chat/:ai/:id` 那几条前面：

```diff
     ['POST', /^\/api\/chat\/([^/]+)\/stop$/, (ai) => need(chat).stop(ai)],
+    // dsh 的 TA：回答确认、还在等的确认、新会话、状态（docs/接口-dsh.md）
+    ['POST', /^\/api\/chat\/([^/]+)\/approve$/, (ai, { body }) => need(chat).dsh.approve(ai, body.id, body.allow === true)],
+    ['GET', /^\/api\/chat\/([^/]+)\/approvals$/, (ai) => need(chat).dsh.pending(ai)],
+    ['POST', /^\/api\/chat\/([^/]+)\/dsh\/new$/, (ai) => need(chat).dsh.reset(ai)],
+    ['GET', /^\/api\/chat\/([^/]+)\/dsh$/, (ai) => need(chat).dsh.state(ai)],
```

### backend.mjs（1 处）

关机时把 dsh 进程收拾掉（不收拾的话，dsh 读到 stdin 断了也会自己退，但会少一次干净的 shutdown）：

```diff
   const stop = () => {
     clearInterval(timer);
     try { store.flush(); vec?.close(); } catch (e) { console.error('关机前写盘出错', e.message); }
-    srv.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref();
+    Promise.all([srv.close(), chat.dsh.closeAll().catch(() => {})]).then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref();
   };
```

key 用的是现成的 `cfg.keyOf`（环境变量 + `.env`），不用另加配置。

## 5. 安装

1. **装 Node 24.9 以上**（dsh 的要求；云岛后端本身用旧一点的 Node 也行，见 `dsh.node`）。
2. **装 dsh**（锁版本，预发布阶段协议没有兼容承诺）：
   - 全局：`npm i -g @deepseek-ai/dsh@0.2.2-rc.1`，`bin` 写 `"dsh"`；
   - 或装在一个文件夹里：`npm i @deepseek-ai/dsh@0.2.2-rc.1`，`bin` 写那个文件夹下 `node_modules/@deepseek-ai/dsh/lib/bin.js` 的绝对路径，`node` 写 Node 24 的绝对路径。
   - `npx @deepseek-ai/dsh@0.2.2-rc.1` 只适合先手动试试；给 TA 用别走 npx（每次拉起都要过一遍 npx）。
   - 已知：Linux 的 Alpine（musl）装不上（依赖 koffi 没有预编译），用 Debian 系（比如 `node:24-slim`）。
3. **建两个文件夹**：dsh home（比如 `~/yundao-dsh/home`）和工作目录（`~/yundao-dsh/work`），不要一个套在另一个里。home 不用先初始化，第一次启动 dsh 会自己建 `sdk` profile。
4. **配模型**：
   - 官方 DeepSeek：`.env` 里加 `DEEPSEEK_API_KEY=…`，ais.json 里 `"keyEnv": "DEEPSEEK_API_KEY"`，`provider`、`model` 用默认就行。
   - 硅基流动或别的 OpenAI 兼容服务：照第 2 节的样子写 `providers`，`.env` 里放对应的 key（例子里是 `SF_KEY`）。
   - 后端每次拉起 dsh 前，把这个 TA 的 `providers` 写进 `<home>/yundao-<id>.patch.yml`，用 `--patch` 叠上去。这份文件里只有变量名，没有 key；别手改，会被重写。
5. **为什么关日志上传**：dsh 默认挂着 `session-log-deepseek` 插件，用 DeepSeek 官方接口时会把会话日志随请求带给 DeepSeek。云岛默认关掉：后端每次启动前检查 `<home>/cordis.patch.yml`，没有就补上

   ```yaml
   # >>> 云岛（yundao） …
   - id: session-log-deepseek
     config:
       enabled: false
   # <<< 云岛（yundao）
   ```

   （对这个 home 下所有 profile 都管用，包括你自己另外开的 `dsh web`），`--patch` 覆盖层里也再写一遍。想打开就在 TA 设置里写 `"uploadLog": true`，后端会拿掉自己写的那段，别的不动。OTel 反馈上传同样默认关（`DSH_TELEMETRY_DISABLED=1`），要开写 `"telemetry": true`。
6. **安全**：dsh 能读写文件、跑命令、上网。工作目录单独一个；权限保持 `workspace-write`（写工作目录外、要更大权限时它会先问，前端弹窗）；别用 `danger-full-access`。确认 5 分钟没回当拒绝。

## 6. 实测记录（v1）

- 假 dsh：`node --test test/dsh.test.mjs`，7 个测试（设置校验、日志补丁、启动和流式、确认允许 / 拒绝 / 超时、停和接回、进程挂了重起、出错 / 新会话 / 找不到 dsh / 两个 TA 抢一个 home / key 不外泄）全过。
- 真 dsh（`@deepseek-ai/dsh@0.2.2-rc.1`，`node:24-slim` 容器，硅基流动 `deepseek-ai/DeepSeek-V4.1-Flash`）：
  - 发话：冷启动约 0.7 秒握手完，2.5 秒回完一段。
  - 工具：工作目录里写文件、跑 bash 不问，直接做；写系统临时目录 `/tmp` 也不问（沙箱放行临时区）。
  - 确认：写 `/opt/outside.txt` 先被沙箱拒（`step_end ok:false`），模型申请提权，来了 `approval` 事件，批准后写成，`approval_end: allowed`。
  - 停：dsh 跑着 `sleep 20` 时按停，当场 `done cut:true`，进程关掉；下一句重新拉起（约 0.6 秒）、接回原会话，正常回复。
  - 组合后的配置（`--dump-config`）里 `session-log-deepseek` 是 `enabled: false`。
- 没核实：Mac / Windows 上直接跑（只在 Linux 容器里测过）；停的时候 dsh 正在跑的子命令会不会被一起结束；图片输入（代码按协议写了 `{ type: "image", data, mimeType }`，没用真模型测）；`session-log-deepseek` 关掉以后是不是真的不传（只验证了配置生效）。
