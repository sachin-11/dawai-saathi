#!/usr/bin/env bash
# dawai.service ExecStart. After a stop/start, bring the stack back.
#   - DESIRED_SHA (SSM) != CURRENT_SHA and not known-bad  -> deploy it (CI may have pushed while we were stopped)
#   - otherwise                                           -> start the last good release
set -euo pipefail
# shellcheck disable=SC1091
. /etc/dawai/instance.env
ROOT=/opt/dawai
desired="$(aws ssm get-parameter --region "$AWS_REGION" --name /dawai/prod/config/DESIRED_SHA --query Parameter.Value --output text 2>/dev/null || true)"
[ "$desired" != "none" ] || desired=""
current="$(cat "$ROOT/CURRENT_SHA" 2>/dev/null || true)"
failed="$(cat "$ROOT/FAILED_SHA" 2>/dev/null || true)"
if [ -n "$desired" ] && [ "$desired" != "$current" ] && [ "$desired" != "$failed" ]; then
  exec "$ROOT/bin/run-release.sh" "$desired"
fi
if [ -n "$current" ]; then
  exec "$ROOT/bin/run-release.sh" "$current"
fi
echo "boot: nothing deployed yet (run the deploy workflow, see docs/runbooks/go-live.md)"
