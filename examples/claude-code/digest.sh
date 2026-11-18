#!/bin/sh
# 散场记（第五个时机）的范例：问后端要一句问话，分叉一份 Claude Code 去问 TA，原对话不动，再把 TA 的回答交给 ③（quiet）。
# 用法：digest.sh <会话编号> [idle|compact|end]
#   会话编号就是 Claude Code 钩子事件里的 session_id。hook.sh 在压缩前（compact）和一场结束时（end）会在后台自动调它；
#   「她停下来一阵」（idle）没有现成的钩子事件，要不要定时来调由你定。
# 地址、哪个 AI、口令跟 hook.sh 一样写在 ~/.config/mem/env 里（权限 600）。
#
# 只在 Claude Code 2.1.325 上试过分叉本身（claude -p --resume <编号> --fork-session：分出去的带着原来的上下文，原对话文件前后一样）。
# 这个脚本没真跑过。没试过：原对话正开着时分叉、真的 TA 照不照做。
#
# 分出去的那份带 MEM_FORK=1：hook.sh 看到它就什么都不做，不然会被当成新的一场。
# 规矩跟 hook.sh 一样：出什么错都安静退出、退出码 0，只往日志里记一行（不带原文）。
[ "${MEM_FORK:-}" = 1 ] && exit 0
SID="$1"
WHY="${2:-idle}"
[ -n "$SID" ] || exit 0
ENVF="${MEM_ENV:-$HOME/.config/mem/env}"
[ -r "$ENVF" ] || exit 0
set -a; . "$ENVF"; set +a
LOG="${MEM_LOG:-$HOME/.config/mem/hook.log}"
CLAUDE="${MEM_CLAUDE:-claude}"          # claude 不在 PATH 里（比如定时任务）就在 env 里写 MEM_CLAUDE=它的完整路径
export SID WHY

# 1. 问后端要问话：上次散场记以后没有新的对话，ask 是 null，就不用问
ASK="$(NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost python3 - <<'PY' 2>>"$LOG"
import os, sys, json, time, urllib.request
try:
    req = urllib.request.Request(
        "%s/api/hook/%s/idle" % (os.environ["MEM_URL"].rstrip("/"), os.environ["MEM_AI"]),
        data=json.dumps({"sid": os.environ["SID"], "why": os.environ["WHY"]}).encode(),
        headers={"Authorization": "Bearer " + os.environ["MEM_TOKEN"], "Content-Type": "application/json"})
    out = json.load(urllib.request.urlopen(req, timeout=5))
    if out.get("ask"):
        sys.stdout.write(out["ask"])
except Exception as e:
    sys.stderr.write("%s digest-idle %s\n" % (time.strftime("%F %T"), repr(e)[:200]))
PY
)"
[ -n "$ASK" ] || exit 0

# 2. 分叉一份去问（原对话不动）。TA 的回答只拿来摘小记，不显示给她
REPLY="$(MEM_FORK=1 "$CLAUDE" -p --resume "$SID" --fork-session "$ASK" 2>>"$LOG")" || { echo "$(date '+%F %T') digest-fork 分叉没跑成" >>"$LOG"; exit 0; }
[ -n "$REPLY" ] || exit 0
export REPLY

# 3. 交给 ③：quiet 表示这句不是聊天（不进对话原文、不算想起一次），小记照常存
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost python3 - <<'PY' 2>>"$LOG" || true
import os, sys, json, time, urllib.request
try:
    req = urllib.request.Request(
        "%s/api/hook/%s/after" % (os.environ["MEM_URL"].rstrip("/"), os.environ["MEM_AI"]),
        data=json.dumps({"reply": os.environ["REPLY"], "sid": os.environ["SID"], "quiet": True}).encode(),
        headers={"Authorization": "Bearer " + os.environ["MEM_TOKEN"], "Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=5).read()
except Exception as e:
    sys.stderr.write("%s digest-after %s\n" % (time.strftime("%F %T"), repr(e)[:200]))
PY
exit 0
