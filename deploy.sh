#!/bin/bash
# Auto-deploy script — called by webhook on git push
set -e
cd /root/NamiBarden
git pull origin main
docker compose up --build -d
echo "$(date) — NamiBarden deployed" >> /var/log/namibarden-deploy.log
