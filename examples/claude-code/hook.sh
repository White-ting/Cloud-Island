#!/bin/sh
# Claude Code 的记忆钩子。用法：hook.sh start|before|after|compact|end
#   start=SessionStart  before=UserPromptSubmit  after=Stop  compact=PreCompact  end=SessionEnd
#   compact 和 end 还会在后台调一次 digest.sh（散场记：快压缩了 / 这一场结束了），不等它、立刻返回。
#   SessionEnd 照 Claude Code 文档有这个事件，我们没实测；Claude Code 退出时会不会连后台的 digest.sh 一起结束，也没试过。
#   PreCompact 时分叉出去的那份读到的是压缩前还是压缩后的对话，同样没试过。
#   before 回来的 digest:true（上下文跌进 10%，只在配了 MEM_CTX_LEFT_CMD 时会有）这里不理：
#   Claude Code 真压缩时 compact 会去问，再问一次就花两份额度；而且那时原对话正在回她这句，分叉没试过。
# Claude Code 把这次事件的 JSON 从标准输入交进来；这里转给后端，把后端回的话交回去。
# 地址、哪个 AI、口令写在 ~/.config/mem/env 里（权限 600）：
#   MEM_URL=http://127.0.0.1:18400
#   MEM_AI=claude
#   MEM_TOKEN=后端 .env 里的 HOOK_TOKEN
#   MEM_CTX_LEFT_CMD=（可选）一条命令，打印 0 到 1 的小数：离自动压缩还剩多少。配了，每条消息前会把它当 ctxLeft
#                    交给后端，快压缩时后端会提醒 TA 写交接；这条命令从标准输入拿到这次事件的 JSON，最多等 1 秒。
#                    Claude Code 的钩子事件里有没有上下文占用我们没核实，所以留给使用者自己接；没配就不传、不提醒。
#   MEM_DIGEST=（可选）digest.sh 的完整路径，不写就用跟 hook.sh 放在一起的那个。
# 规矩：不管出什么错，都安静退出、退出码 0。记忆出毛病不能拦她说话。
# 散场记分叉出去的那份（digest.sh 用 MEM_FORK=1 跑的 claude -p）什么都不做：不然会被当成新的一场，开场、原文、小记都记两遍。
[ "${MEM_FORK:-}" = 1 ] && exit 0
ENVF="${MEM_ENV:-$HOME/.config/mem/env}"
[ -r "$ENVF" ] || exit 0
set -a; . "$ENVF"; set +a
WHEN="$1"
T=5; [ "$WHEN" = before ] && T=3          # 每条消息前那一步最不能慢
EV="$(cat)"; export EV                    # 先把事件读出来（下面标准输入要让给脚本本身）
LOG="${MEM_LOG:-$HOME/.config/mem/hook.log}"
# 散场记：压缩前、一场结束时，后台跑 digest.sh（标准输入输出都断开，钩子不用等它）。会话编号拿不到就不跑
if [ "$WHEN" = compact ] || [ "$WHEN" = end ]; then
  SID="$(python3 -c 'import os, json; print(json.loads(os.environ.get("EV") or "{}").get("session_id") or "")' 2>/dev/null)"
  DG="${MEM_DIGEST:-$(dirname "$0")/digest.sh}"
  WHY=compact; [ "$WHEN" = end ] && WHY=end
  if [ -n "$SID" ] && [ -r "$DG" ]; then
    nohup /bin/sh "$DG" "$SID" "$WHY" </dev/null >/dev/null 2>>"$LOG" &
  fi
fi
[ "$WHEN" = end ] && exit 0               # 一场结束只做散场记，后端没有别的要交
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost python3 - "$WHEN" "$T" <<'PY' 2>>"$LOG" || true
import sys, os, json, time, subprocess, urllib.request
when, timeout = sys.argv[1], float(sys.argv[2])
def ctx_left():                           # 离自动压缩还剩多少：只用使用者自己配的命令，拿不到就不传，不编
    cmd = os.environ.get("MEM_CTX_LEFT_CMD")
    if not cmd:
        return None
    try:
        r = subprocess.run(cmd, shell=True, input=os.environ.get("EV") or "", capture_output=True, text=True, timeout=1)
        x = float(r.stdout.strip())
        return x if 0 <= x <= 1 else None
    except Exception:
        return None
try:
    ev = json.loads(os.environ.get("EV") or "{}")
    if when == "after" and ev.get("stop_hook_active"):
        sys.exit(0)                       # 钩子自己引起的那一轮，不重复交
    body = {"start":   {"source": ev.get("source")},
            "before":  {"text": ev.get("prompt", ""), "sid": ev.get("session_id")},
            "after":   {"reply": ev.get("last_assistant_message") or "", "sid": ev.get("session_id")},
            "compact": {}}[when]
    if when == "before":
        left = ctx_left()
        if left is not None:
            body["ctxLeft"] = left
    req = urllib.request.Request(
        "%s/api/hook/%s/%s" % (os.environ["MEM_URL"].rstrip("/"), os.environ["MEM_AI"], when),
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + os.environ["MEM_TOKEN"], "Content-Type": "application/json"})
    out = json.load(urllib.request.urlopen(req, timeout=timeout))
    if when == "compact":
        if out.get("keep"):
            print(out["keep"])            # 压缩前：直接打印，会被当成写摘要的要求
    elif when in ("start", "before") and out.get("context"):
        name = "SessionStart" if when == "start" else "UserPromptSubmit"
        print(json.dumps({"hookSpecificOutput": {"hookEventName": name, "additionalContext": out["context"]}}, ensure_ascii=False))
except SystemExit:
    raise
except Exception as e:                    # 只往日志里记一行，不往对话里写
    sys.stderr.write("%s %s %s\n" % (time.strftime("%F %T"), when, repr(e)[:200]))
PY
exit 0
