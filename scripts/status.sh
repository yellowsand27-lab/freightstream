#!/usr/bin/env bash
for p in "8787 API" "4173 Web"; do
  set -- $p
  if lsof -ti :"$1" >/dev/null 2>&1; then echo "● $2 运行中  (端口 $1, PID $(lsof -ti :$1 | tr '\n' ' '))"
  else echo "○ $2 已停止  (端口 $1)"; fi
done
