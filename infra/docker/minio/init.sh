#!/bin/sh
# One-shot bucket bootstrap (runs in the minio/mc container). Idempotent: safe to run on every `make up`.
#   BUCKETS         space-separated bucket names to create (private)
#   EXPIRE_BUCKETS  subset that gets a lifecycle rule expiring objects after EXPIRE_DAYS (0 = none)
set -eu

mc alias set local "$MINIO_ENDPOINT" "$MINIO_USER" "$MINIO_PASSWORD" >/dev/null

for bucket in $BUCKETS; do
  mc mb --ignore-existing "local/$bucket"
  # Private bucket: no anonymous access (CLAUDE.md §2.6, §12).
  mc anonymous set none "local/$bucket"
done

for bucket in ${EXPIRE_BUCKETS:-}; do
  if [ "${EXPIRE_DAYS:-0}" -gt 0 ]; then
    # Replace existing rules so re-running never stacks duplicates or keeps a stale retention value.
    mc ilm rule rm --all --force "local/$bucket" >/dev/null 2>&1 || true
    mc ilm rule add --expire-days "$EXPIRE_DAYS" "local/$bucket"
    echo "bucket $bucket: objects expire after $EXPIRE_DAYS days"
  fi
done
