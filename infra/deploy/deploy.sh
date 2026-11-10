#!/usr/bin/env bash
# deploy.sh <git-sha>   (run on the instance by run-release.sh, which SSM calls; there is no SSH)
#
#   render env -> ECR login -> pull -> [snapshot when the release has new migrations] -> migrate
#   -> start service by service (worker last) -> wait healthy -> smoke test
#   -> on ANY failure: roll back to PREVIOUS_SHA and exit non-zero.
#
# Rules this script relies on (CLAUDE.md §10): migrations are backward compatible (expand -> migrate ->
# contract), so the previous app image still works on the migrated database. A rollback therefore never
# runs migrations.
set -euo pipefail

SHA="${1:?usage: deploy.sh <git-sha>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT=/opt/dawai
ENV_FILE="$ROOT/.env"
export AWS_REGION="${AWS_REGION:-ap-south-1}"

exec 9>"$ROOT/deploy.lock"
flock -n 9 || { echo "deploy: another deploy is running" >&2; exit 1; }

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

dc() {
  DAWAI_ENV_FILE="$ENV_FILE" IMAGE_TAG="$TAG" docker compose -p dawai --env-file "$ENV_FILE" -f "$HERE/docker-compose.prod.yml" "$@"
}

env_get() { grep -m1 "^$1='" "$ENV_FILE" | sed -e "s/^$1='//" -e "s/'$//"; }

# ---------------------------------------------------------------- one release
start_release() {
  local with_migrate="$1"
  # 1. data stores first
  if [ "$(env_get COMPOSE_PROFILES)" = "localdb" ]; then dc up -d --no-deps --wait postgres || return 1; fi
  dc up -d --no-deps --wait redis || return 1
  # 2. migrations (forward deploys only; a rollback never migrates)
  if [ "$with_migrate" = "yes" ]; then
    log "running migrations"
    dc run --rm --no-deps migrate || return 1
  fi
  # 3. AI service, then the HTTP side, web and the edge
  dc up -d --no-deps --wait ai-service || return 1
  dc up -d --no-deps --wait gateway-api web || return 1
  dc up -d --no-deps --wait caddy || return 1
  # 4. workers LAST: they start consuming jobs only when everything they call is healthy
  dc up -d --no-deps --wait gateway-worker || return 1
}

smoke() {
  log "smoke test"
  dc exec -T gateway-api node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || return 1
  dc exec -T ai-service python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=5).status==200 else 1)" || return 1
  dc exec -T web node -e "fetch('http://127.0.0.1:3001/').then(r=>process.exit(r.status<400?0:1)).catch(()=>process.exit(1))" || return 1
  dc exec -T gateway-worker node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || return 1
  # Caddy answers on :80 (it redirects to HTTPS): proves the edge is up even before DNS points here.
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $(env_get DOMAIN)" http://127.0.0.1/ || true)"
  case "$code" in 200|301|302|307|308) ;; *) echo "caddy answered $code on :80" >&2; return 1 ;; esac
}

migration_list() { # names of the migrations an image carries
  docker run --rm --entrypoint ls "$1" /app/prisma/migrations 2>/dev/null | sort || true
}

# ---------------------------------------------------------------- main
CURRENT="$(cat "$ROOT/CURRENT_SHA" 2>/dev/null || true)"
PREVIOUS="$(cat "$ROOT/PREVIOUS_SHA" 2>/dev/null || true)"
TAG="$SHA"

log "deploying $SHA (current: ${CURRENT:-none})"
"$HERE/render-env.sh" "$ENV_FILE"
REGISTRY="$(env_get ECR_REGISTRY)"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

dc pull --quiet

# Snapshot before a release that brings new migrations (spec §7).
if [ -n "$CURRENT" ] && [ "$CURRENT" != "$SHA" ]; then
  new_list="$(migration_list "$REGISTRY/dawai/migrate:$SHA")"
  old_list="$(migration_list "$REGISTRY/dawai/migrate:$CURRENT")"
  if [ "$new_list" != "$old_list" ]; then
    log "new migrations in $SHA: taking a database snapshot first"
    "$HERE/backup.sh" pre-migrate || { echo "deploy: snapshot failed, not migrating" >&2; exit 1; }
  fi
elif [ -z "$CURRENT" ]; then
  log "first deploy: no snapshot needed"
fi

rollback() {
  local why="$1"
  log "FAILED ($why)"
  echo "$SHA" > "$ROOT/FAILED_SHA" # boot.sh will not try this sha again by itself
  if [ -n "$CURRENT" ] && [ "$CURRENT" != "$SHA" ]; then
    log "rolling back to $CURRENT"
    TAG="$CURRENT"
    if dc pull --quiet && start_release no && smoke; then
      log "rolled back to $CURRENT and healthy; the failed release was $SHA"
      echo "$CURRENT" > "$ROOT/CURRENT_SHA"
    else
      log "ROLLBACK ALSO FAILED: manual action needed (docs/runbooks/deploy-rollback.md)"
    fi
  else
    log "no previous release to go back to"
  fi
  exit 1
}

if start_release yes && smoke; then
  if [ "$CURRENT" != "$SHA" ]; then
    [ -z "$CURRENT" ] || echo "$CURRENT" > "$ROOT/PREVIOUS_SHA"
    echo "$SHA" > "$ROOT/CURRENT_SHA"
  fi
  docker image prune -af --filter "until=168h" >/dev/null 2>&1 || true
  log "deploy of $SHA OK (previous: $(cat "$ROOT/PREVIOUS_SHA" 2>/dev/null || echo none))"
else
  rollback "start or smoke test"
fi
