# Security (production, M17)

What is enforced in code or Terraform, and what is still a human task. "Test" names the check that proves it.

## Network
- Security group: inbound **80, 443/tcp and 443/udp only**; **no port 22**. Nothing else is reachable from the internet.
- Postgres, Redis and the AI service have no published ports: only containers on the Compose network reach them.
  Caddy has no route to the AI service, `/metrics` is answered 404 at the edge, `/metrics` also needs `METRICS_TOKEN`.
- IMDSv2 only (`http_tokens = required`); hop limit 2 so containers can use the instance role.
- No NAT gateway, no public database. (RDS later goes into private subnets.)

## Identity and access
- **No access keys anywhere.** The instance uses its IAM role; GitHub Actions uses OIDC and a role that only trusts this repository
  on `v*` tags and `main`.
- Instance role: ECR pull, the two buckets, `ssm:GetParameter*` on `/dawai/prod/*`, one Route 53 zone, `/dawai/*` log groups, SSM core.
- Deploy role: ECR push, `s3:PutObject` on `deploy/*`, `ssm:SendCommand` on **this instance and `AWS-RunShellScript`**, one SSM parameter.
- Shell access = SSM Session Manager (with your own IAM identity, logged by CloudTrail). Session logging to CloudWatch is an optional
  account setting (Systems Manager > Session Manager > Preferences): turn it on.
- Admin UI: GitHub login + `ADMIN_EMAILS` allowlist; `Reveal` writes an audit row first (M16).

## Secrets
- SSM Parameter Store `SecureString` (AWS-managed key). Values are never in Terraform state (Terraform only creates non-secret config),
  never in images (`.dockerignore` excludes `.env*`), never in GitHub (only non-secret repository variables), never in logs.
- `render-env.sh` writes `/opt/dawai/.env` as root, mode 600, atomically, and prints variable NAMES only.
- Boot guards, three layers: the gateway env schema, the AI service settings and `render-env.sh` refuse `change-me`/`local-dev`
  placeholders, `LLM_MODE=fake`, `REDACTION_ENABLED=false`, `DEV_ECHO_BOT`, `TURNSTILE_SKIP`, plain-http public URLs and static S3 keys in production
  (tests: `env.schema.spec.ts`, the AI service settings tests).

## Data
- Everything in `ap-south-1`. EBS, S3 (SSE-S3) and ECR encrypted; buckets block public access and deny non-TLS requests.
- Media: `MEDIA_RETENTION_DAYS` expiry; versioning on, noncurrent versions expire after 7 days, so a user's `DELETE` is complete in S3 within a week.
  Database dumps keep a deleted user for up to 30 days: say so in the privacy policy (known limit from M4).
- Phone numbers: HMAC hash + AES-256-GCM (M2). PHI redaction in logs and traces (M6, M15). CloudWatch logs hold no phone numbers (e2e tests from M15).
- Caddy access logs: JSON, query values replaced (`hub.verify_token`), Authorization/Cookie/signature headers deleted, bodies never logged.

## Containers and images
- Non-root users, `no-new-privileges`, `cap_drop: ALL` (+ the few a service needs), read-only root file system with tmpfs for `/tmp`.
- Images pinned by git SHA, ECR tags **immutable**, scan on push, Trivy in `deploy.yml` fails the release on CRITICAL findings with a fix.
- Security updates: `dnf-automatic` (security only). The AMI is Amazon Linux 2023; rebuild the instance (runbook D in `restore.md`) for a new AMI.

## Not done / future work
- Key rotation for `ENCRYPTION_KEY` / `PHONE_HASH_PEPPER` (payload is versioned `v1:` so it is possible).
- WAF in front of Caddy; GuardDuty; CloudTrail data events for S3; customer-managed KMS keys (each costs money).
- Single instance: no zero-downtime deploy and no high availability (see `docs/modules/M17.md`).
- Checkov/tfsec and tflint run in CI (`terraform` job); findings must be fixed or explicitly skipped with a reason.
