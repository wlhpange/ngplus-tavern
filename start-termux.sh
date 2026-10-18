#!/data/data/com.termux/files/usr/bin/bash
# 二周目协会 · Termux 一键启动（Android 手机本地运行 / 单用户，无登录）
#
# 用途：手机桌面点一下图标 → 后台拉起 Next 服务 → 自动用浏览器打开界面。
# 依赖：Termux（F-Droid 版）+ nodejs-lts + python + make + clang + pnpm
#       pkg install -y nodejs-lts python make clang pkg-config
#       npm i -g pnpm
#
# 用法：
#   ./start-termux.sh           生产模式（无 .next 会先 build）
#   ./start-termux.sh --dev     开发模式
#   ./start-termux.sh --stop    停止服务并释放 wake-lock
#   ./start-termux.sh --status  查看是否在运行
#
# 做成「点开即用」的桌面图标见文末注释（Termux:Widget）。
set -uo pipefail
cd "$(dirname "$0")"

APP_URL="http://localhost:3000"
LOG="$HOME/ngplus.log"
PIDFILE="$HOME/ngplus.pid"

is_up() { curl -fsS -o /dev/null --max-time 2 "$APP_URL" 2>/dev/null; }
open_url() { am start -a android.intent.action.VIEW -d "$APP_URL" >/dev/null 2>&1; }

case "${1:-}" in
  --stop)
    [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null; rm -f "$PIDFILE"
    pkill -f "next start" 2>/dev/null; pkill -f "next dev" 2>/dev/null
    termux-wake-unlock 2>/dev/null
    echo "[停止] 协会服务已关闭。"; exit 0 ;;
  --status)
    if is_up; then echo "[运行中] $APP_URL"; else echo "[未运行]"; fi; exit 0 ;;
esac

# ---------- [1/4] 依赖 ----------
# Android 没有 better-sqlite3 预编译产物，patch-sqlite3.mjs 会失败，
# 因此首次安装跳过 install 脚本，再本地源码编译 sqlite 原生模块。
if [ ! -d node_modules ]; then
  echo "[1/4] 首次运行：安装依赖（跳过脚本）…"
  pnpm install --ignore-scripts
fi
if [ ! -f node_modules/better-sqlite3/build/Release/better_sqlite3.node ]; then
  echo "[1/4] 编译 better-sqlite3（首次较慢，需 python/clang/make）…"
  ( cd node_modules/better-sqlite3 && npm run build-release )
fi

# ---------- [2/4] 数据库迁移 ----------
echo "[2/4] 数据库迁移…"
pnpm db:migrate

# ---------- [3/4] 已在运行则直接打开 ----------
termux-wake-lock 2>/dev/null
if is_up; then
  echo "[3/4] 服务已在运行，直接打开。"
  open_url; exit 0
fi

# ---------- [4/4] 后台启动并打开 ----------
echo "[4/4] 后台启动协会…（日志：$LOG）"
if [ "${1:-}" = "--dev" ]; then
  CMD="pnpm dev"
else
  [ -d .next ] || pnpm build
  CMD="pnpm start"
fi
nohup $CMD >"$LOG" 2>&1 &
echo $! > "$PIDFILE"

for _ in $(seq 1 60); do is_up && break; sleep 1; done

if is_up; then
  open_url
  echo "[OK] 已启动并打开：$APP_URL"
else
  echo "[!] 启动超时，请查看日志：$LOG"
fi

# ============================================================
# 做成「点一下」的桌面图标（推荐）：
#   1. F-Droid 安装 Termux:Widget
#   2. 手机桌面长按 → 小组件 → Termux:Widget
#   3. 把本脚本放进捷径目录并赋权（在 Termux 里执行一次）：
#        mkdir -p ~/.shortcuts
#        ln -sf ~/AItwo/start-termux.sh ~/.shortcuts/启动协会.sh
#        chmod +x ~/AItwo/start-termux.sh
#   4. 之后桌面点「启动协会」即可：服务自动起、浏览器自动开。
#   5.（可选）给 Termux 关闭电池优化 + 装 Termux:Boot 实现开机自启。
# ============================================================
