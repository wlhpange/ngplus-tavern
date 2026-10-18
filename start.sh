#!/usr/bin/env bash
# 二周目协会 · 一键启动（bash / Linux / macOS / Git Bash）
# 用法：./start.sh [--check | --prod]
#   --check  只做环境自检（依赖/密钥/迁移），不启动服务器
#   --prod   生产模式（先 build 再 start），默认开发模式
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-}"
NODE_DIR="${NGPLUS_NODE_DIR:-/d/tools/node22}"

# ---------- 定位 Node ----------
if ! command -v node >/dev/null 2>&1; then
  if [ -x "$NODE_DIR/node.exe" ] || [ -x "$NODE_DIR/bin/node" ]; then
    export PATH="$NODE_DIR:$NODE_DIR/bin:$PATH"
  else
    echo "[x] 未找到 Node.js 22。请安装 Node 22 或设置 NGPLUS_NODE_DIR 指向便携版。" >&2
    exit 1
  fi
fi

# ---------- 定位 pnpm ----------
PNPM="pnpm"
if ! command -v pnpm >/dev/null 2>&1; then
  PNPM="npx pnpm"
fi

echo "============================================"
echo "  二周目协会 · 一键启动"
echo "============================================"

# ---------- [1/4] 依赖 ----------
echo "[1/4] 检查依赖…"
if [ ! -d node_modules ]; then
  echo "      首次运行：安装依赖，稍慢，请耐心等…"
  $PNPM install
else
  node scripts/patch-sqlite3.mjs
fi

# ---------- [2/4] 密钥 ----------
echo "[2/4] 检查 .env.local…"
if [ ! -f .env.local ]; then
  if [ -f .env.example ]; then
    cp .env.example .env.local
    echo "      已生成 .env.local，请把 DEEPSEEK_API_KEY 填进去（填好后重新运行）。"
  else
    echo "      [!] 没有 .env.example，跳过。没有 Key 时会长暂时不会说话。"
  fi
fi
if grep -q "^DEEPSEEK_API_KEY=..*" .env.local 2>/dev/null; then
  echo "      Key 已配置。"
else
  echo "      [!] .env.local 里还没有 DEEPSEEK_API_KEY：界面能开，但会长不会说话。"
fi

# ---------- [3/4] 数据库 ----------
echo "[3/4] 数据库迁移…"
$PNPM db:migrate

if [ "$MODE" = "--check" ]; then
  echo ""
  echo "[OK] 自检通过：依赖、密钥、数据库都就绪。运行 ./start.sh 即可进入协会。"
  exit 0
fi

# ---------- 文字模型（不强制；启动后在设置里配）----------
echo "[模型] 启动后在「设置 → 模型与渠道」填你自己的 API；也可以先写进 .env.local。"

# ---------- [4/4] 启动 ----------
echo "[4/4] 启动协会…打开 http://localhost:3000（Ctrl+C 停止）"
if [ "$MODE" = "--prod" ]; then
  $PNPM build
  exec $PNPM start
else
  exec $PNPM dev
fi
