# Restore and disaster recovery

Target: **back online in under one hour** after losing the instance. Not yet measured: see "Drill log" at the bottom
(the drill is part of M17 acceptance and is done together with you, on a throw-away instance).

## What is where

| Data | Lives in | Backup |
|---|---|---|
| Users, messages, medications, reminders (Postgres) | Docker volume `dawai_postgres_data` on the instance disk | `pg_dump` to `s3://<backups>/postgres/` at every stop, before a migrating deploy and nightly (kept 30 days) |
| Queues and reminder jobs (Redis) | volume `dawai_redis_data` (AOF) | `dump.rdb` to `s3://<backups>/redis/` (kept 14 days). The M10 planner can rebuild reminder jobs from the database, so losing Redis loses only jobs in flight |
| Media (prescriptions, lab reports, voice) | S3 media bucket | versioned; `media/` expires after `MEDIA_RETENTION_DAYS`; noncurrent versions after 7 days |
| TLS certificates | volume `dawai_caddy_data` | none: Caddy re-issues (mind Let's Encrypt rate limits) |
| Secrets and config | SSM Parameter Store | **you**: `ENCRYPTION_KEY` and `PHONE_HASH_PEPPER` in a password manager |
| Infrastructure | Terraform state in S3 (versioned) | `terraform apply` rebuilds it |
| Release bundles / images | S3 `deploy/` (90 d) and ECR (last 5) | rebuild by re-running the deploy workflow for a tag |

A stopped instance keeps its disk, so a normal stop/start loses nothing.

## A. The instance is broken but the disk is fine

```bash
aws ec2 reboot-instances --instance-ids <id>     # or stop + start (make stop && make start)
```

## B. Restore the database to a dump

1. `make shell`, then list: `aws s3 ls s3://<backups>/postgres/ | tail`
2. Stop the writers: `cd /opt/dawai/releases/$(cat /opt/dawai/CURRENT_SHA) && sudo IMAGE_TAG=$(cat /opt/dawai/CURRENT_SHA) docker compose -p dawai --env-file /opt/dawai/.env stop gateway-worker gateway-api ai-service`
3. Restore into an empty database:
   ```bash
   PG=$(sudo docker ps -qf label=com.docker.compose.service=postgres)
   aws s3 cp s3://<backups>/postgres/<file>.dump - | sudo docker exec -i $PG pg_restore -U dawai -d dawai --clean --if-exists --no-owner
   ```
4. Start again: `sudo /opt/dawai/bin/run-release.sh $(cat /opt/dawai/CURRENT_SHA)` (idempotent: it re-runs migrations and health checks).
5. Point-in-time recovery does NOT exist in container mode: you lose everything after the dump (at most the time since the last stop/nightly dump). RDS gives PITR (see `docs/runbooks/rds-upgrade.md`).

Users deleted (`DELETE`) after the dump come back when you restore it, and the anonymous `user_deleted` audit rows taken after the dump are
lost too. Erase those users again by hand and say so in the privacy policy: this is the honest cost of any backup.

## C. Restore Redis

`aws s3 cp s3://<backups>/redis/<file>.rdb.tar -` contains `dump.rdb`; stop redis, replace `/data/dump.rdb` in the volume, start redis. Then
wait 15 minutes: the repeatable planner job recreates the next 36 hours of reminder jobs from the database.

## D. Rebuild everything on a new instance (the 1-hour path)

1. `terraform apply` (taint the instance first if the old one is unusable: `terraform apply -replace=aws_instance.app`). The new box runs
   cloud-init (Docker, swap, units), writes its IP to Route 53 and waits.
2. Secrets are still in SSM: nothing to re-enter.
3. Deploy the last good release: `make rollback SHA=<current sha>` (or push a tag).
4. Restore the database (B) and, if you want, Redis (C).
5. `make smoke-prod API=api.<zone> SITE=<zone>`.
6. Meta webhook needs no change: the URL is the same name.

## Drill log

| Date | What | Time to healthy | Notes |
|---|---|---|---|
| _not run yet_ | rebuild on a temporary instance + restore latest dump | — | do it after the first real deploy, record the number here and in `docs/modules/M17.md` |
