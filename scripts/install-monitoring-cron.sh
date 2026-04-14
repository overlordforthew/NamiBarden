#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/root/projects/NamiBarden}"
LOG_DIR="${LOG_DIR:-/var/log/namibarden}"
BLOCK_START="# BEGIN NAMIBARDEN_MONITORING"
BLOCK_END="# END NAMIBARDEN_MONITORING"

mkdir -p "$LOG_DIR"
chmod 750 "$LOG_DIR"

existing_cron="$(crontab -l 2>/dev/null || true)"
cleaned_cron="$(printf '%s\n' "$existing_cron" | awk -v start="$BLOCK_START" -v end="$BLOCK_END" '
  $0 == start { skipping = 1; next }
  $0 == end { skipping = 0; next }
  !skipping { print }
')"

monitoring_block="$(cat <<EOF
${BLOCK_START}
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/10 * * * * /usr/bin/flock -n /tmp/namibarden-uptime.lock /usr/bin/env APP_CONTAINER=namibarden /usr/bin/bash ${PROJECT_DIR}/scripts/uptime-monitor.sh >> ${LOG_DIR}/uptime-monitor.log 2>&1
12 * * * * /usr/bin/flock -n /tmp/namibarden-smoke.lock /usr/bin/bash ${PROJECT_DIR}/scripts/smoke-test.sh >> ${LOG_DIR}/smoke-test.log 2>&1
${BLOCK_END}
EOF
)"

{
  printf '%s\n' "$cleaned_cron"
  [ -n "$cleaned_cron" ] && printf '\n'
  printf '%s\n' "$monitoring_block"
} | crontab -

echo "Installed Namibarden monitoring cron jobs:"
printf '%s\n' "$monitoring_block"
