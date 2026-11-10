#!/usr/bin/env bash
# run-release.sh <sha>  -- what SSM (CI) and boot.sh call. Fetches the release bundle that CI uploaded
# (compose file, Caddyfile, scripts, postgres init) from S3 and runs its deploy.sh.
set -euo pipefail
SHA="${1:?usage: run-release.sh <sha>}"
[[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || { echo "run-release: not a git sha" >&2; exit 2; }
# shellcheck disable=SC1091
. /etc/dawai/instance.env
DIR="/opt/dawai/releases/$SHA"
mkdir -p "$DIR"
aws s3 sync "s3://$ARTIFACT_BUCKET/deploy/$SHA/" "$DIR/" --region "$AWS_REGION" --only-show-errors
chmod +x "$DIR"/*.sh
exec "$DIR/deploy.sh" "$SHA"
