#!/usr/bin/env bash
# Release fs-api to ai.transknights.com by SSH key (after fs-api-user.sh): build, upload, restart, health check.
set -euo pipefail
cd "$(dirname "$0")/../api"
npm run build
rsync -az --delete dist/ tk:/opt/freightstream/api/dist/
ssh tk 'sudo -n systemctl restart fs-api && sleep 2 && systemctl is-active fs-api && curl -s -m 10 http://127.0.0.1:8787/api/health'
echo
