# Moving Postgres from the container to RDS (when the bill allows it)

Demo mode runs Postgres in a container to stay under about $10/month. RDS (`db.t4g.micro`, 20 GB) costs roughly $15-20/month more
and gives automated backups with point-in-time recovery, patching and a separate failure domain. It is **not implemented in
Terraform yet**; this is the plan so it is a small change, not a redesign.

1. Terraform: two private subnets in two AZs, a DB subnet group, a security group allowing 5432 from the app security group only,
   `aws_db_instance` (PostgreSQL 16, encrypted, `deletion_protection = true`, 7-day backups, parameter group allowing `pg_trgm`).
2. Create the extensions and the read-only role once (`01-extensions.sql`, `02-roles.sh` from `infra/docker/postgres/init`).
3. SSM config: `DB_HOST=<rds endpoint>`, `DB_INSTANCE_ID=<id>` (so `backup.sh` takes RDS snapshots instead of dumps).
   `render-env.sh` then builds `DATABASE_URL` against that host and no longer enables the `localdb` compose profile.
4. Take a dump (`backup.sh manual`), restore it into RDS, switch `DB_HOST`, deploy.
5. Remove the `postgres` volume only after a week without problems.
