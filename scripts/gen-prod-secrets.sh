#!/usr/bin/env bash
# scripts/gen-prod-secrets.sh [out-file]      (default: prod.secrets.env, gitignored)
#
# Writes a template for the production SECRETS: the ones we can generate are filled in, the ones that come
# from an external account are left empty for you. Then upload with `scripts/put-secrets.sh <file>`.
#
# !! ENCRYPTION_KEY and PHONE_HASH_PEPPER: copy them to a password manager NOW. Losing either one means the
# !! stored phone numbers can no longer be decrypted or looked up. They cannot be recovered from AWS.
set -euo pipefail
OUT="${1:-prod.secrets.env}"
[ ! -e "$OUT" ] || { echo "$OUT already exists, not overwriting" >&2; exit 1; }
umask 077
b64() { openssl rand -base64 32 | tr -d '\n'; }
hex() { openssl rand -hex 24; }
cat > "$OUT" <<ENVFILE
# ---- generated (openssl) ----
SERVICE_TOKEN=$(b64)
ENCRYPTION_KEY=$(b64)
PHONE_HASH_PEPPER=$(b64)
WA_VERIFY_TOKEN=$(hex)
METRICS_TOKEN=$(hex)
POSTGRES_PASSWORD=$(hex)
AI_RO_PASSWORD=$(hex)
REDIS_PASSWORD=$(hex)
DEMO_API_KEY=$(hex)
DEMO_SERVICE_TOKEN=$(hex)
ADMIN_JWT_SECRET=$(b64)
NEXTAUTH_SECRET=$(b64)

# ---- from external accounts (fill in) ----
# Meta (developers.facebook.com): app secret, and the System User permanent token of the production number
WA_APP_SECRET=
WA_ACCESS_TOKEN=
# LLM providers (the one named in LLM_PRIMARY is required)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
# Speech
SARVAM_API_KEY=
SMALLEST_API_KEY=
# Langfuse Cloud
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
# Cloudflare Turnstile (demo uploads) and GitHub OAuth app (admin login)
TURNSTILE_SECRET_KEY=
AUTH_GITHUB_ID=
AUTH_GITHUB_SECRET=
ENVFILE
echo "wrote $OUT (mode 600). Fill the empty values, back up ENCRYPTION_KEY and PHONE_HASH_PEPPER, then:"
echo "  scripts/put-secrets.sh $OUT"
