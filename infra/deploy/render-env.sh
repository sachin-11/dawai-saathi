#!/usr/bin/env bash
# Writes /opt/dawai/.env from SSM Parameter Store using the INSTANCE ROLE (no access keys anywhere).
#
#   /dawai/prod/secrets/<NAME>   SecureString  (keys, passwords)       -> NAME='value'
#   /dawai/prod/config/<NAME>    String        (domain, bucket, ...)   -> NAME='value'
#
# Then it derives the connection strings and checks the production rules. A failed check stops the
# deploy BEFORE any container starts. Values are never printed: only the NAME of a bad variable.
# The file is root-only (chmod 600) and is replaced atomically.
set -euo pipefail
umask 077

OUT="${1:-/opt/dawai/.env}"
REGION="${AWS_REGION:-ap-south-1}"
PREFIX="${SSM_PREFIX:-/dawai/prod}"
TMP="$(mktemp "${OUT}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

declare -A V=()
for kind in secrets config; do
  # Names only appear in errors; a value never leaves this process except into $TMP.
  json="$(aws ssm get-parameters-by-path --region "$REGION" --path "$PREFIX/$kind" \
    --recursive --with-decryption --output json)"
  while IFS=$'\t' read -r name value; do
    [ -n "$name" ] || continue
    case "$name" in DESIRED_SHA) continue ;; esac
    if [[ "$value" == *"'"* || "$value" == *$'\n'* ]]; then
      echo "render-env: ${name} contains a quote or newline, which the .env format cannot hold" >&2
      exit 1
    fi
    V["$name"]="$value"
  done < <(printf '%s' "$json" | jq -r '.Parameters[] | "\(.Name | split("/") | last)\t\(.Value)"')
done

# ---- derived values (only when not set explicitly)
DB_HOST="${V[DB_HOST]:-postgres}"
: "${V[DATABASE_URL]:=postgresql://dawai:${V[POSTGRES_PASSWORD]:-}@${DB_HOST}:5432/dawai}"
: "${V[AI_DATABASE_URL]:=postgresql://dawai_ai_ro:${V[AI_RO_PASSWORD]:-}@${DB_HOST}:5432/dawai}"
: "${V[REDIS_URL]:=redis://:${V[REDIS_PASSWORD]:-}@redis:6379}"
: "${V[AI_SERVICE_URL]:=http://ai-service:8000}"
: "${V[NODE_ENV]:=production}"
: "${V[LLM_MODE]:=real}"
: "${V[REDACTION_ENABLED]:=true}"
: "${V[AWS_REGION]:=$REGION}"
V[S3_ENDPOINT]=''          # on AWS the endpoint is empty and the instance role signs requests
V[S3_ACCESS_KEY_ID]=''     # never static keys on AWS
V[S3_SECRET_ACCESS_KEY]=''
if [ "$DB_HOST" = "postgres" ]; then V[COMPOSE_PROFILES]="${V[COMPOSE_PROFILES]:-localdb}"; fi
V[GATEWAY_URL]="http://gateway-api:3000"
V[NEXTAUTH_URL]="https://${V[DOMAIN]:-}"
V[ADMIN_DATA_DIR]="${V[ADMIN_DATA_DIR]:-/app/admin-data}"

# ---- production checks
errors=()
need() { [ -n "${V[$1]:-}" ] || errors+=("$1 is missing"); }
for k in DOMAIN API_DOMAIN ACME_EMAIL ECR_REGISTRY S3_BUCKET ALLOWED_MEDIA_HOSTS PRIVACY_POLICY_URL \
         SERVICE_TOKEN ENCRYPTION_KEY PHONE_HASH_PEPPER \
         WA_PHONE_NUMBER_ID WA_ACCESS_TOKEN WA_APP_SECRET WA_VERIFY_TOKEN \
         POSTGRES_PASSWORD AI_RO_PASSWORD REDIS_PASSWORD \
         METRICS_TOKEN LLM_DAILY_BUDGET_USD LLM_PRIMARY VISION_MODEL TEXT_MODEL CHEAP_MODEL; do
  need "$k"
done
[ "${V[LLM_MODE]}" = "real" ] || errors+=("LLM_MODE must be real")
[ "${V[REDACTION_ENABLED]}" != "false" ] || errors+=("REDACTION_ENABLED must be true")
[ "${V[DEV_ECHO_BOT]:-false}" = "false" ] || errors+=("DEV_ECHO_BOT must be false")
[ -z "${V[REMINDER_TEST_OFFSET_MIN]:-}" ] || errors+=("REMINDER_TEST_OFFSET_MIN must be unset")
[ "${V[TURNSTILE_SKIP]:-false}" = "false" ] || errors+=("TURNSTILE_SKIP must be false")
case "${V[LLM_PRIMARY]:-}" in
  anthropic) need ANTHROPIC_API_KEY ;;
  openai) need OPENAI_API_KEY ;;
  *) errors+=("LLM_PRIMARY must be anthropic or openai") ;;
esac
# Passwords go into URLs: letters and digits only (`openssl rand -hex 24`).
for k in POSTGRES_PASSWORD AI_RO_PASSWORD REDIS_PASSWORD; do
  [[ "${V[$k]:-}" =~ ^[A-Za-z0-9]{16,}$ ]] || errors+=("$k must be 16+ letters/digits (openssl rand -hex 24)")
done
# Public links must be HTTPS.
for k in PRIVACY_POLICY_URL NEXT_PUBLIC_SITE_URL; do
  [ -z "${V[$k]:-}" ] || [[ "${V[$k]}" == https://* ]] || errors+=("$k must be https")
done
# Placeholders from .env.example are refused.
for k in "${!V[@]}"; do
  case "${V[$k]}" in
    *change-me*|*changeme*|*local-dev*|*dawaisaathi.example*) errors+=("$k still holds a placeholder") ;;
  esac
done
# The demo needs its own token and budget; the admin needs its signing secret.
if [ -n "${V[DEMO_API_KEY]:-}" ]; then
  need DEMO_SERVICE_TOKEN; need DEMO_DAILY_BUDGET_USD
fi
if [ -n "${V[ADMIN_EMAILS]:-}" ]; then
  need ADMIN_JWT_SECRET; need NEXTAUTH_SECRET
fi

if [ "${#errors[@]}" -gt 0 ]; then
  printf 'render-env: production check failed:\n' >&2
  printf '  - %s\n' "${errors[@]}" >&2
  exit 1
fi

for k in "${!V[@]}"; do printf "%s='%s'\n" "$k" "${V[$k]}"; done | sort > "$TMP"
chown root:root "$TMP"
chmod 600 "$TMP"
mv -f "$TMP" "$OUT"
trap - EXIT
echo "render-env: wrote ${OUT} (${#V[@]} variables, values not shown)"
