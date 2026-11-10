#!/usr/bin/env bash
# dawai.service ExecStop: runs BEFORE docker stops (shutdown, `make stop`, the budget guard).
# Dump the database and Redis, then stop the app containers gracefully so workers finish their jobs.
set -uo pipefail
ROOT=/opt/dawai
current="$(cat "$ROOT/CURRENT_SHA" 2>/dev/null || true)"
[ -n "$current" ] || exit 0
"$ROOT/releases/$current/backup.sh" pre-stop || echo "stop: backup failed (continuing)" >&2
export IMAGE_TAG="$current"
docker compose -p dawai --env-file "$ROOT/.env" -f "$ROOT/releases/$current/docker-compose.prod.yml" stop -t 40 || true
