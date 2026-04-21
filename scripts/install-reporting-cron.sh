#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${LOG_DIR:-/var/log/namibarden}"

mkdir -p "$LOG_DIR"
chmod 750 "$LOG_DIR"

install -Dm644 /dev/stdin /etc/cron.d/namibarden-reporting <<'CRON'
TZ=Asia/Tokyo
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 3 * * * root flock -n /tmp/namibarden-reporting-refresh.lock docker exec namibarden node scripts/refresh-reporting.js >> /var/log/namibarden/reporting-refresh.log 2>&1
30 3 * * * root flock -n /tmp/namibarden-orphan-refunds.lock docker exec namibarden node scripts/reconcile-orphan-refunds.js --live >> /var/log/namibarden/orphan-refunds.log 2>&1
CRON

echo "Installed /etc/cron.d/namibarden-reporting"
