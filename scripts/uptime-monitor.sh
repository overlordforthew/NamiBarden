#!/bin/bash
set -u

STATE_DIR="/root/backups/namibarden/uptime-monitor"
ALERT_WHATSAPP_DEFAULT="84393251371@s.whatsapp.net"
MONITOR_STAGING="${MONITOR_STAGING:-0}"
APP_CONTAINER="${APP_CONTAINER:-namibarden}"

mkdir -p "$STATE_DIR"

container_env() {
  local key="$1"
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$APP_CONTAINER" 2>/dev/null \
    | awk -v target="${key}=" 'index($0, target) == 1 { print substr($0, length(target) + 1); exit }'
}

OVERLORD_URL="${OVERLORD_URL:-$(container_env OVERLORD_URL)}"
WEBHOOK_TOKEN="${WEBHOOK_TOKEN:-$(container_env WEBHOOK_TOKEN)}"
SMTP_HOST="${SMTP_HOST:-$(container_env SMTP_HOST)}"
SMTP_PORT="${SMTP_PORT:-$(container_env SMTP_PORT)}"
SMTP_USER="${SMTP_USER:-$(container_env SMTP_USER)}"
SMTP_PASS="${SMTP_PASS:-$(container_env SMTP_PASS)}"
SMTP_FROM="${SMTP_FROM:-$(container_env SMTP_FROM)}"
ALERT_WHATSAPP_JID="${ALERT_WHATSAPP_JID:-$(container_env ALERT_WHATSAPP_JID)}"
ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-$(container_env ALERT_EMAIL_TO)}"

ALERT_WHATSAPP_JID="${ALERT_WHATSAPP_JID:-$ALERT_WHATSAPP_DEFAULT}"
ALERT_EMAIL_TO="${ALERT_EMAIL_TO:-${SMTP_USER:-${SMTP_FROM:-}}}"

send_whatsapp() {
  local text="$1"
  if [ -z "${OVERLORD_URL:-}" ] || [ -z "${WEBHOOK_TOKEN:-}" ] || [ -z "$ALERT_WHATSAPP_JID" ]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  curl -fsS --max-time 20 \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${WEBHOOK_TOKEN}" \
    -d "{\"to\":\"${ALERT_WHATSAPP_JID}\",\"text\":$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" \
    "${OVERLORD_URL}/api/send" >/dev/null 2>&1 || return 1
}

send_email() {
  local subject="$1"
  local body="$2"
  if [ -z "${SMTP_HOST:-}" ] || [ -z "${SMTP_PORT:-}" ] || [ -z "${SMTP_USER:-}" ] || [ -z "${SMTP_PASS:-}" ] || [ -z "${SMTP_FROM:-}" ] || [ -z "$ALERT_EMAIL_TO" ]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  SUBJECT="$subject" BODY="$body" python3 - <<'PY' >/dev/null 2>&1
import os, smtplib
from email.message import EmailMessage

msg = EmailMessage()
msg["Subject"] = os.environ["SUBJECT"]
msg["From"] = os.environ["SMTP_FROM"]
msg["To"] = os.environ["ALERT_EMAIL_TO"]
msg.set_content(os.environ["BODY"])

host = os.environ["SMTP_HOST"]
port = int(os.environ.get("SMTP_PORT", "587"))
user = os.environ["SMTP_USER"]
password = os.environ["SMTP_PASS"]

with smtplib.SMTP(host, port, timeout=20) as server:
    server.ehlo()
    try:
        server.starttls()
        server.ehlo()
    except Exception:
        pass
    server.login(user, password)
    server.send_message(msg)
PY
}

notify_all() {
  local subject="$1"
  local body="$2"
  send_whatsapp "$body" || true
  send_email "$subject" "$body" || true
}

check_json_status() {
  local url="$1"
  local expected="$2"
  local response
  response="$(curl -fsS --max-time 20 "$url")" || return 2
  if [[ "$response" != *"\"status\":\"${expected}\""* ]]; then
    printf '%s' "$response"
    return 1
  fi
  printf '%s' "$response"
}

check_http_ok() {
  local url="$1"
  local code
  code="$(curl -fsS -o /dev/null -w "%{http_code}" --max-time 20 "$url" || printf '000')"
  if [ "$code" != "200" ]; then
    printf '%s' "$code"
    return 1
  fi
  printf '%s' "$code"
}

run_check() {
  local key="$1"
  local label="$2"
  local mode="$3"
  local url="$4"
  local expected="${5:-}"
  local state_file="${STATE_DIR}/${key}.state"
  local previous="unknown"
  local result=""
  local rc=0

  if [ -f "$state_file" ]; then
    previous="$(cat "$state_file" 2>/dev/null || printf 'unknown')"
  fi

  if [ "$mode" = "json" ]; then
    result="$(check_json_status "$url" "$expected" 2>&1)"
    rc=$?
  else
    result="$(check_http_ok "$url" 2>&1)"
    rc=$?
  fi

  if [ $rc -eq 0 ]; then
    printf 'ok' > "$state_file"
    if [ "$previous" = "fail" ]; then
      notify_all \
        "[Nami Recovery] ${label}" \
        "RECOVERY\n${label}\n${url}\nResult: ${result}"
    fi
    return 0
  fi

  printf 'fail' > "$state_file"
  if [ "$previous" != "fail" ]; then
    notify_all \
      "[Nami Alert] ${label}" \
      "ALERT\n${label}\n${url}\nResult: ${result}"
  fi
  return 1
}

failures=0
run_check "prod-health" "Production health degraded" "json" "https://namibarden.com/api/health" "ok" || failures=$((failures + 1))
run_check "prod-ready" "Production readiness failed" "json" "https://namibarden.com/api/ready" "ready" || failures=$((failures + 1))
run_check "lumina-home" "Lumina homepage unreachable" "http" "https://lumina.namibarden.com/" || failures=$((failures + 1))

if [ "$MONITOR_STAGING" = "1" ]; then
  run_check "staging-health" "Staging health degraded" "json" "https://staging.namibarden.com/api/health" "ok" || failures=$((failures + 1))
  run_check "staging-ready" "Staging readiness failed" "json" "https://staging.namibarden.com/api/ready" "ready" || failures=$((failures + 1))
fi

if [ $failures -gt 0 ]; then
  exit 1
fi

exit 0
