#!/usr/bin/env bash
# scripts/aws-start.sh        start the instance for a demo (make start)
#
# Refuses to start when this month's AWS spend is already at the cap (default $10, CAP_USD to change),
# so "stopped for the rest of the month" holds even if you forget. The counter resets by itself next month.
# Cost Explorer must be enabled once in the console (Billing > Cost Explorer); each query costs $0.01.
# FORCE=1 skips the check (use it when Cost Explorer is not available yet).
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-ap-south-1}"
CAP_USD="${CAP_USD:-10}"
ID="${INSTANCE_ID:-$(terraform -chdir=infra/terraform output -raw instance_id)}"
SITE="$(terraform -chdir=infra/terraform output -raw site_url 2>/dev/null || true)"

if [ "${FORCE:-0}" != "1" ]; then
  start="$(date -u +%Y-%m-01)"
  end="$(date -u -d 'tomorrow' +%Y-%m-%d)"
  spent="$(aws ce get-cost-and-usage --region us-east-1 --time-period "Start=$start,End=$end" \
    --granularity MONTHLY --metrics UnblendedCost --query 'ResultsByTime[0].Total.UnblendedCost.Amount' \
    --output text 2>/dev/null || true)"
  if [ -z "$spent" ] || [ "$spent" = "None" ]; then
    echo "could not read this month's cost (is Cost Explorer enabled?). Re-run with FORCE=1 to start anyway." >&2
    exit 1
  fi
  echo "this month so far: \$$spent (cap \$$CAP_USD)"
  if awk -v s="$spent" -v c="$CAP_USD" 'BEGIN { exit !(s >= c) }'; then
    echo "cap reached: not starting. It opens again next month (or FORCE=1 to override)." >&2
    exit 1
  fi
fi

aws ec2 start-instances --region "$REGION" --instance-ids "$ID" >/dev/null
aws ec2 wait instance-running --region "$REGION" --instance-ids "$ID"
echo "instance running. The stack needs about 2-4 minutes (DNS update, containers, HTTPS)."
echo "it stops by itself after MAX_UPTIME_MIN (default 180). Extend: make extend MIN=120"
[ -z "$SITE" ] || echo "site: $SITE"
