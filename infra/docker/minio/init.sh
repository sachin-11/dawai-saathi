#!/bin/sh
# One-shot bucket bootstrap (runs in the minio/mc container). Idempotent: safe to run on every `make up`.
#   BUCKETS         space-separated bucket names to create (private)
#   DEMO_EXPIRE_DAYS  M16: a SECOND rule on prefix demo/ (public web-demo uploads) that expires after this many days (default 1)
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
    # Demo uploads are deleted right after processing; this 24 h rule is the backstop (never linked to a user).
    mc ilm rule add --prefix "demo/" --expire-days "${DEMO_EXPIRE_DAYS:-1}" "local/$bucket"
    echo "bucket $bucket: demo/ objects expire after ${DEMO_EXPIRE_DAYS:-1} day(s)"
  fi
done
