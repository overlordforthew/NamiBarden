#!/usr/bin/env bash
#
# Smoke test for namibarden.com.
# Safe by default for scheduled monitoring: only non-invasive checks run unless
# --live-post is provided explicitly.

set -euo pipefail

BASE_URL="${BASE_URL:-https://namibarden.com}"
RUN_LIVE_POST=0
PASS=0
FAIL=0
SKIP=0
TOTAL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --live-post)
      RUN_LIVE_POST=1
      ;;
    --base-url)
      shift
      BASE_URL="${1:-}"
      if [ -z "$BASE_URL" ]; then
        echo "Missing value for --base-url" >&2
        exit 1
      fi
      ;;
    --help|-h)
      cat <<EOF
Usage: $(basename "$0") [--live-post] [--base-url URL]

  --live-post   Run a real POST /api/contact check. This writes production data.
  --base-url    Override the site URL. Default: ${BASE_URL}
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

# Print result helper
result() {
  local status="$1"
  local expect="$2"
  local endpoint="$3"
  local extra="$4"
  TOTAL=$((TOTAL + 1))

  if [ "$status" = "PASS" ]; then
    PASS=$((PASS + 1))
    printf "[PASS] %s %s\n" "$endpoint" "$extra"
  else
    FAIL=$((FAIL + 1))
    printf "[FAIL] %s %s\n" "$endpoint" "$extra"
  fi
}

skip() {
  local endpoint="$1"
  local reason="$2"
  TOTAL=$((TOTAL + 1))
  SKIP=$((SKIP + 1))
  printf "[SKIP] %s %s\n" "$endpoint" "$reason"
}

# Test a GET endpoint for expected HTTP status code
test_get() {
  local path="$1"
  local expect="$2"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE_URL}${path}")
  if [ "$code" = "$expect" ]; then
    result "PASS" "$expect" "GET ${path}" "(HTTP ${code})"
  else
    result "FAIL" "$expect" "GET ${path}" "(expected ${expect}, got ${code})"
  fi
}

# Test a GET endpoint for expected HTTP status code and response fragment
test_get_body() {
  local path="$1"
  local expect="$2"
  local fragment="$3"
  local body
  local code

  body=$(curl -s --max-time 10 -w '\n%{http_code}' "${BASE_URL}${path}")
  code=$(printf '%s\n' "$body" | tail -n1)
  body=$(printf '%s\n' "$body" | sed '$d')

  if [ "$code" = "$expect" ] && printf '%s' "$body" | tr -d '[:space:]' | grep -Fq "$(printf '%s' "$fragment" | tr -d '[:space:]')"; then
    result "PASS" "${expect}+body" "GET ${path}" "(HTTP ${code}, body ok)"
  else
    result "FAIL" "${expect}+body" "GET ${path}" "(expected HTTP ${expect} with fragment ${fragment}, got HTTP ${code})"
  fi
}

# Test a redirect endpoint for expected HTTP status and Location header
test_redirect() {
  local path="$1"
  local expect="$2"
  local expected_location="$3"
  local headers
  local code
  local location

  headers=$(curl -s -I --max-time 10 "${BASE_URL}${path}")
  code=$(printf '%s\n' "$headers" | sed -n '1{s/.* \([0-9][0-9][0-9]\).*/\1/p;q}')
  location=$(printf '%s\n' "$headers" | sed -n 's/^[Ll]ocation: //p' | tr -d '\r' | sed -n '1p')

  if [ "$code" = "$expect" ] && [ "$location" = "$expected_location" ]; then
    result "PASS" "${expect}+location" "GET ${path}" "(HTTP ${code}, Location ${location})"
  else
    result "FAIL" "${expect}+location" "GET ${path}" "(expected HTTP ${expect} to ${expected_location}, got HTTP ${code} to ${location})"
  fi
}

# -------------------------------------------------------------------
# 1-6: GET endpoints expecting 200
# -------------------------------------------------------------------
test_get "/" "200"
test_get "/en" "200"
test_get "/lumina" "200"
test_get "/consultation" "200"
test_get "/consultation-en" "200"
test_get "/couples-coaching" "200"
test_get "/couples-coaching-en" "200"
test_get "/api/youtube-feed" "200"
test_get_body "/api/health" "200" '"status":"ok"'
test_get_body "/api/ready" "200" '"status":"ready"'
test_redirect "/en/" "308" "https://namibarden.com/en"
test_redirect "/executive-coaching/" "308" "https://namibarden.com/executive-coaching"

# -------------------------------------------------------------------
# Optional: POST /api/contact — writes real data when explicitly enabled
# -------------------------------------------------------------------
if [ "$RUN_LIVE_POST" = "1" ]; then
  contact_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -X POST \
    -H "Content-Type: application/json" \
    -d '{"name":"smoke","email":"test@test.com","message":"smoke test"}' \
    "${BASE_URL}/api/contact")

  if [ "$contact_code" = "200" ] || [ "$contact_code" = "429" ]; then
    result "PASS" "200|429" "POST /api/contact" "(HTTP ${contact_code})"
  else
    result "FAIL" "200|429" "POST /api/contact" "(expected 200 or 429, got ${contact_code})"
  fi
else
  skip "POST /api/contact" "(disabled by default; pass --live-post to enable)"
fi

# -------------------------------------------------------------------
# GET /api/stripe/verify-session?session_id=fake — 200 with {"valid":false}
# -------------------------------------------------------------------
verify_body=$(curl -s --max-time 10 "${BASE_URL}/api/stripe/verify-session?session_id=fake")
verify_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE_URL}/api/stripe/verify-session?session_id=fake")

if [ "$verify_code" = "200" ] && echo "$verify_body" | grep -q '"valid":false'; then
  result "PASS" "200+body" "GET /api/stripe/verify-session?session_id=fake" "(HTTP ${verify_code}, body ok)"
else
  result "FAIL" "200+body" "GET /api/stripe/verify-session?session_id=fake" "(expected 200 with {\"valid\":false}, got HTTP ${verify_code})"
fi

# -------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------
echo ""
echo "========================================="
echo "  Smoke test summary: ${PASS} passed, ${SKIP} skipped, ${FAIL} failed"
echo "========================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

exit 0
