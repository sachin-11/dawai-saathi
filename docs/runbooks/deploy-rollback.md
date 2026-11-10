# Deploy and rollback

There is no SSH. Everything goes through GitHub Actions (OIDC) and AWS Systems Manager (SSM).

## How a release works

1. `git tag v0.1.0 && git push origin v0.1.0` (or **Actions > deploy > Run workflow**).
2. `deploy.yml`: full CI (tests + eval gates) → arm64 images → ECR, tag = the **full git SHA** → Trivy (CRITICAL fails) →
   release bundle (compose file, Caddyfile, scripts) to `s3://<backups>/deploy/<sha>/` → `DESIRED_SHA` in SSM → SSM Run Command
   `run-release.sh <sha>` on the instance.
3. On the instance `deploy.sh <sha>`: render `.env` from SSM (production checks) → ECR login → pull → **snapshot first when
   the release carries new migrations** → data stores → `migrate` → AI service → gateway-api + web → Caddy → **gateway-worker last**
   → health checks → smoke test.
4. Any failure → **automatic rollback** to `PREVIOUS_SHA` (the old images are still local or in ECR), the failed SHA is written to
   `/opt/dawai/FAILED_SHA` so the next boot does not retry it, and the command exits non-zero (the GitHub job turns red).
5. If the instance is **stopped**, the workflow only records `DESIRED_SHA`. The release is deployed at the next `make start`.

## Manual rollback (to any earlier release)

```bash
make rollback SHA=<full git sha of the release you want>
```

Same SSM command as a deploy, with an older SHA. Find SHAs in the Actions history or `git log`. The bundle for that SHA must
still exist in S3 (kept 90 days) and its images in ECR (the last 5 are kept). Rollbacks never run migrations.

## The rule that makes rollback safe

Migrations are **expand → migrate → contract** (CLAUDE.md §10). A release may add columns and tables, never drop or rename
something the previous release still reads. The destructive step goes into a LATER release, after the old code is gone.
If a release really needs a breaking change, deploy it in two steps and say so in the PR.

## Looking at a failed deploy

```bash
make shell      # Session Manager (needs the AWS CLI session-manager-plugin)
sudo docker compose -p dawai ps
sudo docker compose -p dawai logs --tail 100 gateway-api     # also in CloudWatch: /dawai/<service>
cat /opt/dawai/CURRENT_SHA /opt/dawai/PREVIOUS_SHA /opt/dawai/FAILED_SHA
```

| Symptom | Likely cause |
|---|---|
| `render-env: production check failed: X is missing` | a secret/config value is not in SSM yet: `docs/production-checklist.md` |
| `render-env: ... still holds a placeholder` | a `change-me` / `local-dev` value was uploaded |
| `migrate` fails | read its log in CloudWatch `/dawai/gateway-api` (stream `migrate`); the snapshot taken before it is in `s3://<backups>/postgres/` |
| `no matching manifest for linux/arm64` | an image was built for x86: the instance is Graviton |
| ECR `tag invalid: immutable` | the SHA already has an image; the workflow skips existing images, re-run it |
| Caddy cannot get a certificate | DNS does not point to the instance yet (NS records at GoDaddy; `dig api.<zone>`) |

## After a rollback

The failed SHA stays failed. Fix forward: new commit, new tag.
