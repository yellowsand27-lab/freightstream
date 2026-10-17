#!/usr/bin/env bash
# Run as root once: fs-api runs as the deploy user instead of root, and its code belongs to that user, so a release is
# rsync + "sudo systemctl restart fs-api" (allowed by /etc/sudoers.d/tk-deploy). systemd still reads
# /opt/freightstream/.env as root (EnvironmentFile), so the secret files stay root-only.
set -euo pipefail
U=luxsexdoll_magento
FS=/opt/freightstream
D=/tmp/tk-deploy
# newest build first (reads the connection settings from the environment only)
if [ -d $D/fs-api-dist ]; then rm -rf $FS/api/dist && cp -a $D/fs-api-dist $FS/api/dist; fi
chown -R $U:$U $FS/api
install -d /etc/systemd/system/fs-api.service.d
printf '[Service]\nUser=%s\nGroup=%s\n' $U $U > /etc/systemd/system/fs-api.service.d/user.conf
ls -dt $FS/api/dist.bak-* 2>/dev/null | tail -n +2 | xargs -r rm -rf   # keep the newest backup only
systemctl daemon-reload
systemctl restart fs-api
sleep 2
echo "fs-api: $(systemctl is-active fs-api), runs as $(ps -o user= -p "$(systemctl show -p MainPID --value fs-api)")"
curl -s -m 10 http://127.0.0.1:8787/api/health; echo
