#!/usr/bin/env bash
# scripts/smoke-prod.sh <api-domain> <site-domain> [verify-token] [app-secret]
#
# Post-deploy smoke test against the PUBLIC https endpoints. The secrets are optional: without them the
# two webhook checks are skipped (and said so). Secrets are read from the arguments or the environment
# (WA_VERIFY_TOKEN, WA_APP_SECRET) and are never printed.
#
# The signed POST uses a phone_number_id the app does not own, so it is acknowledged (200) and ignored:
# nothing is stored and nothing is sent to anyone.
set -uo pipefail

API="${1:?usage: smoke-prod.sh <api-domain> <site-domain> [verify-token] [app-secret]}"
SITE="${2:?site domain}"
VERIFY="${3:-${WA_VERIFY_TOKEN:-}}"
SECRET="${4:-${WA_APP_SECRET:-}}"
fail=0

check() { # check <name> <ok:0|1> [detail]
  if [ "$2" = "0" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 ${3:-}"; fail=1; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }

echo "smoke: https://$API  https://$SITE"
[ "$(code "https://$API/health/live")" = "200" ]; check "GET /health/live" $?
[ "$(code "https://$API/health/ready")" = "200" ]; check "GET /health/ready" $?
[ "$(code "https://$API/metrics")" = "404" ]; check "/metrics is not public" $?
[ "$(code "https://$SITE/")" = "200" ]; check "landing page" $?
[ "$(code "https://$SITE/privacy")" = "200" ]; check "privacy page" $?
[ "$(code "https://$SITE/terms")" = "200" ]; check "terms page" $?
[ "$(code "http://$SITE/")" = "308" ] || [ "$(code "http://$SITE/")" = "301" ]; check "http redirects to https" $?

if [ -n "$VERIFY" ]; then
  challenge="smoke$RANDOM"
  body="$(curl -s --max-time 20 -G "https://$API/webhook/whatsapp" \
    --data-urlencode "hub.mode=subscribe" --data-urlencode "hub.verify_token=$VERIFY" \
    --data-urlencode "hub.challenge=$challenge")"
  [ "$body" = "$challenge" ]; check "webhook GET handshake echoes the challenge" $?
  [ "$(code -G "https://$API/webhook/whatsapp" --data-urlencode 'hub.mode=subscribe' \
      --data-urlencode 'hub.verify_token=wrong' --data-urlencode 'hub.challenge=x')" != "200" ]
  check "webhook GET with a wrong token is refused" $?
else
  echo "  SKIP  webhook GET (no verify token given)"
fi

if [ -n "$SECRET" ]; then
  payload='{"object":"whatsapp_business_account","entry":[{"id":"0","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"0","phone_number_id":"000000000000000"},"statuses":[]}}]}]}'
  sig="sha256=$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"
  [ "$(code -X POST "https://$API/webhook/whatsapp" -H 'Content-Type: application/json' \
      -H "X-Hub-Signature-256: $sig" --data "$payload")" = "200" ]
  check "signed webhook POST (foreign phone_number_id) -> 200" $?
  [ "$(code -X POST "https://$API/webhook/whatsapp" -H 'Content-Type: application/json' \
      -H 'X-Hub-Signature-256: sha256=00' --data "$payload")" = "401" ]
  check "bad signature -> 401" $?
else
  echo "  SKIP  signed webhook POST (no app secret given)"
fi

# Demo: a cached sample answers without calling a model and carries a trace.
sample="$(curl -s --max-time 30 -X POST "https://$SITE/api/demo" -F language=en -F sample_id=rx_clean || true)"
case "$sample" in
  *trace*) check "demo sample answers with a trace" 0 ;;
  *) echo "  WARN  demo sample returned no trace (check the sample id in apps/web/public/samples)" ;;
esac

[ "$fail" = "0" ] && echo "smoke: ALL PASSED" || echo "smoke: FAILED"
exit "$fail"
