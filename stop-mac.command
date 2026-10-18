#!/usr/bin/env bash
# ============================================================
# 二周目协会 · 停止后台服务（Finder 双击可用）
#
# 与 start-mac.command 配套：后台启动的服务用这个停。
# 精确按「PID 文件 + 端口监听」停止，不影响其它项目的 next dev。
#
# 用法：
#   ./stop-mac.command          # 停止
#   NGPLUS_PORT=3000 ./stop-mac.command
# ============================================================
set -uo pipefail
cd "$(dirname "$0")"

PORT="${NGPLUS_PORT:-3000}"
PIDFILE=".ngplus.pid"

echo "正在停止协会服务（端口 ${PORT}）…"

if [ -f "$PIDFILE" ]; then
  kill "$(cat "$PIDFILE")" 2>/dev/null || true
fi
if command -v lsof >/dev/null 2>&1; then
  lsof -ti tcp:"$PORT" 2>/dev/null | while read -r pid; do kill "$pid" 2>/dev/null || true; done
fi
rm -f "$PIDFILE"

sleep 1

if command -v lsof >/dev/null 2>&1 && lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[!] 端口 ${PORT} 仍被占用，可能有其它程序在跑。"
else
  echo "[OK] 已停止。"
fi

if [ -t 0 ]; then
  echo
  echo "按回车关闭窗口…"
  read -r _ || true
fi
