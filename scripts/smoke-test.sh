#!/usr/bin/env bash
#
# Smoke test for namibarden.com — run after deploy to verify key endpoints.
# Exit 0 if all pass, 1 if any fail.

set -euo pipefail

BASE_URL="https://namibarden.com"
PASS=0
FAIL=0
TOTAL=0

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

# Test a redirect endpoint for expected HTTP status and Location header
test_redirect() {
  local path="$1"
  local expect="$2"
  local expected_location="$3"
  local headers
  local code
  local location

  headers=$(curl -s -I --max-time 10 "${BASE_URL}${path}")
  code=$(printf '%s\n' "$headers" | awk 'toupper($1) ~ /^HTTP\\// {print $2; exit}')
  location=$(printf '%s\n' "$headers" | awk 'tolower($1) == "location:" {sub(/\r$/, "", $2); print $2; exit}')

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
test_get "/lumina" "200"
test_get "/consultation" "200"
test_get "/consultation-en" "200"
test_get "/couples-coaching" "200"
test_get "/couples-coaching-en" "200"
test_get "/api/youtube-feed" "200"
test_redirect "/en/" "308" "https://namibarden.com/en"
test_redirect "/executive-coaching/" "308" "https://namibarden.com/executive-coaching"

# -------------------------------------------------------------------
# 7: POST /api/contact — 200 or 429 (rate-limited) both acceptable
# -------------------------------------------------------------------
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

# -------------------------------------------------------------------
# 8: GET /api/stripe/verify-session?session_id=fake — 200 with {"valid":false}
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
echo "  Smoke test summary: ${PASS}/${TOTAL} tests passed"
echo "========================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

exit 0
