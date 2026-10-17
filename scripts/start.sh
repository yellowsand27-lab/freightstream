#!/usr/bin/env bash
# 启动 FreightStream 本地服务（后台常驻，关掉终端也不停）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p .logs .run

is_up() { lsof -ti :"$1" >/dev/null 2>&1; }

# 依赖与构建（缺什么补什么）
[ -d api/node_modules ] || (echo "· 安装 api 依赖…"; cd api && npm install --silent)
[ -d web/node_modules ] || (echo "· 安装 web 依赖…"; cd web && npm install --silent)
if [ ! -d web/dist ] || [ -n "$(find web/src -newer web/dist -type f 2>/dev/null | head -1)" ]; then
  echo "· 构建前端…"; (cd web && npm run build >/dev/null 2>&1)
fi

# API
if is_up 8787; then echo "· API 已在运行 (8787)"; else
  echo "· 启动 API…"
  (cd api && nohup npx tsx src/index.ts > "$ROOT/.logs/api.log" 2>&1 & echo $! > "$ROOT/.run/api.pid")
fi
# Web（生产构建 + 静态托管，/api 代理到 8787）
if is_up 4173; then echo "· Web 已在运行 (4173)"; else
  echo "· 启动 Web…"
  (cd web && nohup npx vite preview --port 4173 --strictPort > "$ROOT/.logs/web.log" 2>&1 & echo $! > "$ROOT/.run/web.pid")
fi

# 等就绪
for i in $(seq 1 20); do
  if curl -s -o /dev/null "http://localhost:4173/" && curl -s -o /dev/null "http://localhost:8787/api/health"; then break; fi
  sleep 0.5
done
echo
echo "✅ 已启动 →  http://localhost:4173"
echo "   停止:  ./scripts/stop.sh    日志: .logs/api.log  .logs/web.log"
