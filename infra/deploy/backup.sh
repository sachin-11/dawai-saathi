#!/usr/bin/env bash
# backup.sh <label>     label: pre-migrate | nightly | pre-stop | manual
#
# Postgres in the container -> pg_dump (custom format) to s3://<backups>/postgres/
# Postgres on RDS           -> a manual RDS snapshot (DB_INSTANCE_ID in config)
# Redis                     -> dump.rdb to s3://<backups>/redis/ (queues and reminders can be rebuilt by the
#                              M10 planner; this only shortens the gap)
# The backups bucket is private, SSE-S3, with a lifecycle rule (Terraform). Nothing here prints secrets.
set -euo pipefail

LABEL="${1:-manual}"
ENV_FILE=/opt/dawai/.env
REGION="${AWS_REGION:-ap-south-1}"
env_get() { grep -m1 "^$1='" "$ENV_FILE" | sed -e "s/^$1='//" -e "s/'$//"; }

BUCKET="$(env_get BACKUP_BUCKET)"
[ -n "$BUCKET" ] || { echo "backup: BACKUP_BUCKET is not configured" >&2; exit 1; }
TS="$(date -u +%Y%m%dT%H%M%SZ)"

if [ "$(env_get COMPOSE_PROFILES)" = "localdb" ]; then
  PG="$(docker ps -q --filter label=com.docker.compose.project=dawai --filter label=com.docker.compose.service=postgres)"
  if [ -n "$PG" ]; then
    docker exec "$PG" pg_dump -U dawai -d dawai -Fc \
      | aws s3 cp - "s3://$BUCKET/postgres/${TS}-${LABEL}.dump" --sse AES256 --region "$REGION"
    echo "backup: postgres dump written (${LABEL})"
  else
    echo "backup: postgres container is not running, skipped" >&2
  fi
elif [ -n "$(env_get DB_INSTANCE_ID)" ]; then
  aws rds create-db-snapshot --region "$REGION" --db-instance-identifier "$(env_get DB_INSTANCE_ID)" \
    --db-snapshot-identifier "dawai-${LABEL}-${TS}" >/dev/null
  echo "backup: RDS snapshot requested (${LABEL})"
fi

RD="$(docker ps -q --filter label=com.docker.compose.project=dawai --filter label=com.docker.compose.service=redis)"
if [ -n "$RD" ]; then
  docker exec "$RD" sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning SAVE' >/dev/null
  docker cp "$RD:/data/dump.rdb" - | aws s3 cp - "s3://$BUCKET/redis/${TS}-${LABEL}.rdb.tar" --sse AES256 --region "$REGION"
  echo "backup: redis snapshot written (${LABEL})"
fi
