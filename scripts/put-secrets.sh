#!/usr/bin/env bash
# scripts/put-secrets.sh <file> [--config]
#
#   <file>     KEY=value lines (comments and empty values are skipped)
#   (default)  each KEY becomes a SecureString   /dawai/prod/secrets/KEY
#   --config   each KEY becomes a plain String   /dawai/prod/config/KEY   (models, limits, URLs ...)
#
# Values are passed through a 600-mode temp file (file://), so they never appear in a process list or in
# shell history. Nothing is printed except the names. Needs your own AWS credentials (not the instance's).
# Keys Terraform manages (DOMAIN, S3_BUCKET, ...) are refused here: change them in Terraform instead.
set -euo pipefail
FILE="${1:?usage: put-secrets.sh <file> [--config]}"
KIND=secrets; TYPE=SecureString
if [ "${2:-}" = "--config" ]; then KIND=config; TYPE=String; fi
REGION="${AWS_REGION:-ap-south-1}"
MANAGED=" DOMAIN API_DOMAIN ACME_EMAIL ECR_REGISTRY S3_BUCKET BACKUP_BUCKET AWS_REGION ALLOWED_MEDIA_HOSTS PRIVACY_POLICY_URL MEDIA_RETENTION_DAYS NEXT_PUBLIC_SITE_URL DESIRED_SHA "

umask 077
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
# Git Bash on Windows: the AWS CLI is a Windows program and cannot read /tmp paths, so give it a Windows path.
tmp_path="$tmp"; if command -v cygpath >/dev/null 2>&1; then tmp_path="$(cygpath -m "$tmp")"; fi
n=0
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in ''|'#'*) continue ;; esac
  key="${line%%=*}"; value="${line#*=}"
  [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "skipping a line with an invalid name" >&2; continue; }
  [ -n "$value" ] || { echo "  - $key is empty, skipped"; continue; }
  case "$MANAGED" in *" $key "*) echo "  ! $key is managed by Terraform, skipped" >&2; continue ;; esac
  printf '%s' "$value" > "$tmp"
  aws ssm put-parameter --region "$REGION" --name "/dawai/prod/$KIND/$key" --type "$TYPE" \
    --value "file://$tmp_path" --overwrite >/dev/null
  echo "  + /dawai/prod/$KIND/$key"
  n=$((n + 1))
done < "$FILE"
echo "put-secrets: $n parameters written to /dawai/prod/$KIND/"
