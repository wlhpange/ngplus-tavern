#!/usr/bin/env bash
# ============================================================
# 二周目协会 · macOS 一键启动（Finder 双击可用）
#
# 默认**前台运行**：服务日志就在这个终端窗口里，按 Control+C 即停止。
# 这样大家不会找不到关闭服务的地方。
#
# 用法：
#   ./start-mac.command               # 前台运行（推荐；Ctrl+C 停止）
#   ./start-mac.command --prod        # 生产模式（先 build 再前台启动）
#   ./start-mac.command --background  # 后台运行（停止用 stop-mac.command）
#   ./start-mac.command --check       # 只做环境自检，不启动
#
# 环境变量：
#   NGPLUS_PORT=3000          端口
#   NGPLUS_NO_OPEN=1          启动后不自动打开浏览器
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-}"
PORT="${NGPLUS_PORT:-3000}"
PIDFILE=".ngplus.pid"
LOGDIR="logs"
LOGFILE="$LOGDIR/ngplus.log"
URL="http://localhost:${PORT}"

# 出错时别让 Finder 双击的窗口闪一下就消失（非交互运行时直接退出）
trap 'echo; echo "[x] 启动失败，见上方信息。"; if [ -t 0 ]; then echo "按回车关闭窗口…"; read -r _ || true; fi' ERR

echo "============================================"
echo "  二周目协会 · 一键启动（macOS）"
echo "============================================"

# ---------- 工具函数 ----------
node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

# 健康检查：访问一个业务路由。根路由即使服务半坏也可能返回 200，
# /quests 能反映路由清单是否完整（坏实例常见表现：/ 正常但 /quests 404）。
health_ok() {
  curl -fsS -o /dev/null --max-time 20 "$URL/quests" 2>/dev/null
}

port_listening() {
  command -v lsof >/dev/null 2>&1 && lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1
}

# 按「PID 文件 + 端口监听」停止，避免误杀其它项目的 next dev
stop_server() {
  echo "      正在停止旧实例…"
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$PORT" 2>/dev/null | while read -r pid; do kill "$pid" 2>/dev/null || true; done || true
  fi
  rm -f "$PIDFILE"
  sleep 2
}

open_browser() {
  [ "${NGPLUS_NO_OPEN:-}" = "1" ] || open "$URL" >/dev/null 2>&1 || true
}

# ---------- 定位 Node（优先 22，≥22 均可）----------
find_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge 22 ] 2>/dev/null; then
    return 0
  fi
  # Homebrew node@22
  for p in /opt/homebrew/opt/node@22/bin /usr/local/opt/node@22/bin; do
    if [ -x "$p/node" ]; then export PATH="$p:$PATH"; return 0; fi
  done
  # 便携版
  for d in "$HOME"/.local/node-v22*-darwin-*/bin; do
    if [ -x "$d/node" ]; then export PATH="$d:$PATH"; return 0; fi
  done
  # nvm
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge 22 ] 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

if ! find_node; then
  echo "[x] 没找到可用的 Node（需要 22 或更高）。"
  echo "    安装方式：brew install node@22（或到 nodejs.org 下载 22 LTS）"
  exit 1
fi
echo "[环境] Node $(node -v)"

# ---------- 定位 pnpm ----------
if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  PNPM=(corepack pnpm)
else
  echo "[x] 没找到 pnpm。安装：npm install -g pnpm"
  exit 1
fi
echo "[环境] pnpm $("${PNPM[@]}" -v)"

# ---------- 已有实例处理 ----------
if port_listening; then
  if [ "$MODE" = "--prod" ] || [ "$MODE" = "--background" ]; then
    echo "[!] 端口 ${PORT} 有服务在跑；本次启动需先停掉它。"
    stop_server
  elif health_ok; then
    echo "[OK] 协会已在运行 → ${URL}"
    echo "     若要停止：切到它的终端窗口按 Control+C（前台启动的），"
    echo "     或双击 stop-mac.command（后台启动的）。"
    open_browser
    exit 0
  else
    echo "[!] 端口 ${PORT} 被占用但服务不健康（常见于 .next 被 build 打坏）——自动重启。"
    stop_server
  fi
fi

# ---------- [1/4] 依赖 ----------
echo "[1/4] 检查依赖…"
if [ ! -d node_modules ]; then
  echo "      首次运行：安装依赖，稍慢，请耐心等…"
  "${PNPM[@]}" install
else
  node scripts/patch-sqlite3.mjs >/dev/null 2>&1 || true
fi

# 原生模块预检：换过 Node 版本时最常出问题的地方
if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
  echo "      [!] better-sqlite3 与当前 Node 不匹配，尝试修复…"
  "${PNPM[@]}" rebuild better-sqlite3 || "${PNPM[@]}" install
  if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
    echo "[x] better-sqlite3 仍不可用。请确认 Node 22 + 已安装编译工具链后重试。"
    exit 1
  fi
fi
echo "      依赖就绪"

# ---------- [2/4] 密钥 ----------
echo "[2/4] 检查 .env.local…"
if [ ! -f .env.local ]; then
  if [ -f .env.example ]; then
    cp .env.example .env.local
    echo "      已生成 .env.local，请把 DEEPSEEK_API_KEY 或 OPENCODE_API_KEY 填进去。"
  else
    echo "      [!] 没有 .env.example，跳过。没有 Key 时会长暂时不会说话。"
  fi
fi
if grep -qE "^(DEEPSEEK_API_KEY|OPENCODE_API_KEY)=..*" .env.local 2>/dev/null; then
  echo "      Key 已配置。"
else
  echo "      [!] .env.local 里还没有 Key——界面能开，但会长不会说话。"
  echo "      填好后重新运行本脚本即可（见 .env.example）。"
fi

# ---------- [3/4] 数据库 ----------
echo "[3/4] 数据库迁移…"
"${PNPM[@]}" db:migrate
if grep -q "^CRON_ENABLED=1" .env.local 2>/dev/null; then
  echo "      [i] 定时巡检已启用：服务运行期间每天凌晨 01:00 做断签判定（合盖休眠会跳过）。"
fi

if [ "$MODE" = "--check" ]; then
  echo ""
  echo "[OK] 自检通过：Node、pnpm、依赖、密钥、数据库都就绪。"
  echo "     运行 ./start-mac.command 即可进入协会。"
  exit 0
fi

# ---------- 文字模型（不强制；启动后在设置里配）----------
echo "[模型] 启动后在「设置 → 模型与渠道」填你自己的 API；也可以先把 Key 写进 .env.local。"

# ---------- [4/4] 启动 ----------
# 后台模式（可选）：日志写文件、PID 记文件，停止用 stop-mac.command
if [ "$MODE" = "--background" ]; then
  mkdir -p "$LOGDIR"
  echo "[4/4] 后台启动 → ${URL}"
  if [ "$MODE" = "--prod" ]; then
    "${PNPM[@]}" build >>"$LOGFILE" 2>&1 || { echo "[x] 构建失败：$LOGFILE"; tail -20 "$LOGFILE"; exit 1; }
    CMD=("${PNPM[@]}" start)
  else
    CMD=("${PNPM[@]}" dev)
  fi
  nohup "${CMD[@]}" >"$LOGFILE" 2>&1 </dev/null &
  echo $! >"$PIDFILE"
  disown 2>/dev/null || true
  echo "      等待服务就绪…"
  ready=0
  for _ in $(seq 1 90); do
    if health_ok; then ready=1; break; fi
    sleep 1
  done
  if [ "$ready" = "1" ]; then
    open_browser
    echo ""
    echo "[OK] 已启动：${URL}"
    echo "     停止服务：双击 stop-mac.command（或 kill \$(cat .ngplus.pid)）"
    exit 0
  fi
  echo "[x] 启动超时。日志尾部："; tail -20 "$LOGFILE" || true; exit 1
fi

# 默认：前台运行，日志在本窗口，Ctrl+C 停止
if [ "$MODE" = "--prod" ]; then
  echo "[4/4] 生产构建中（约 1-2 分钟）…"
  "${PNPM[@]}" build
  echo ""
  echo "============================================"
  echo "  协会运行中 → ${URL}"
  echo "  停止服务：在本窗口按 Control + C"
  echo "============================================"
  open_browser
  exec "${PNPM[@]}" start
fi

echo "[4/4] 前台启动 → ${URL}"
echo ""
echo "============================================"
echo "  协会运行中 → ${URL}"
echo "  停止服务：在本窗口按 Control + C"
echo "  （想让它在后台跑：./start-mac.command --background）"
echo "============================================"
open_browser
exec "${PNPM[@]}" dev
