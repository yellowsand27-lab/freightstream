#!/usr/bin/env bash
# 停止 FreightStream 本地服务
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for port in 8787 4173; do
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  [ -n "$pids" ] && { echo "· 停止端口 $port ($pids)"; kill $pids 2>/dev/null || true; }
done
rm -f "$ROOT/.run/"*.pid 2>/dev/null || true
echo "✅ 已停止"
