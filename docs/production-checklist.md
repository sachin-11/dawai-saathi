# Production checklist (M17)

Every variable the production stack needs, grouped by where it comes from. Tick each box when the value is
in AWS. Nothing here is ever committed to git.

- **Secrets** go to SSM Parameter Store as `SecureString` under `/dawai/prod/secrets/<NAME>`.
- **Config** goes to `/dawai/prod/config/<NAME>` (plain `String`).
- Both are written with `scripts/put-secrets.sh <file> [--config]` from your own machine. On the instance,
  `infra/deploy/render-env.sh` turns them into `/opt/dawai/.env` (root only, mode 600) at every deploy and **refuses
  to continue** when a required value is missing, still a placeholder, or breaks a production rule.
- Start: `make secrets-template` writes `prod.secrets.env` with the generated values filled in.

> **Back up `ENCRYPTION_KEY` and `PHONE_HASH_PEPPER` in a password manager now.** They are the only way to
> decrypt stored phone numbers and to find a user by number. AWS cannot recover them. Rotation is future work
> (the ciphertext carries a `v1:` version prefix so a second key can be added later).

## 1. External accounts and keys (you create them)

| ☐ | Name | From | Notes |
|---|------|------|-------|
| ☐ | `WA_PHONE_NUMBER_ID` (config) | Meta > WhatsApp > API setup | the PRODUCTION number, not the test number |
| ☐ | `WA_ACCESS_TOKEN` | Meta Business > System User | **permanent** token, not the 24 h one |
| ☐ | `WA_APP_SECRET` | Meta app > Settings > Basic | signs every webhook (`X-Hub-Signature-256`) |
| ☐ | `WA_BUSINESS_ACCOUNT_ID` (config) | Meta | template management |
| ☐ | `WA_API_VERSION` (config, optional) | Meta | default `v21.0` |
| ☐ | `ANTHROPIC_API_KEY` | console.anthropic.com | needed when `LLM_PRIMARY=anthropic` |
| ☐ | `OPENAI_API_KEY` | platform.openai.com | needed when `LLM_PRIMARY=openai` or as fallback; Whisper STT |
| ☐ | `SARVAM_API_KEY` | sarvam.ai | Indic STT/TTS (optional) |
| ☐ | `SMALLEST_API_KEY` | smallest.ai | first-choice TTS (optional) |
| ☐ | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` (config) | Langfuse Cloud | do not self-host on this instance |
| ☐ | `PINECONE_API_KEY`, `PINECONE_INDEX_HOST` (config) | Pinecone | only with `VECTOR_BACKEND=pinecone` |
| ☐ | `EMBEDDING_API_KEY`, `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL` | embeddings provider | only with Pinecone |
| ☐ | `TURNSTILE_SECRET_KEY` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Cloudflare Turnstile | without the secret, demo uploads are refused (samples still work) |
| ☐ | `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | GitHub OAuth app | callback `https://<site>/api/auth/callback/github` |
| ☐ | `GRAFANA_OTLP_ENDPOINT`, `GRAFANA_OTLP_AUTH` | Grafana Cloud | only with compose profile `obs` |

## 2. Generated secrets (`openssl rand ...`, done by `make secrets-template`)

| ☐ | Name | How |
|---|------|-----|
| ☐ | `SERVICE_TOKEN` | `openssl rand -base64 32` (gateway ⇄ AI service) |
| ☐ | `ENCRYPTION_KEY` | `openssl rand -base64 32` (exactly 32 bytes, AES-256-GCM) **backup!** |
| ☐ | `PHONE_HASH_PEPPER` | `openssl rand -base64 32` **backup!** |
| ☐ | `WA_VERIFY_TOKEN` | `openssl rand -hex 24` (you paste it into the Meta webhook form) |
| ☐ | `METRICS_TOKEN` | `openssl rand -hex 24` (required in production) |
| ☐ | `POSTGRES_PASSWORD`, `AI_RO_PASSWORD`, `REDIS_PASSWORD` | `openssl rand -hex 24` (letters and digits only: they go into URLs) |
| ☐ | `DEMO_API_KEY`, `DEMO_SERVICE_TOKEN` | `openssl rand -hex 24`; the two must differ from each other and from `SERVICE_TOKEN` |
| ☐ | `ADMIN_JWT_SECRET`, `NEXTAUTH_SECRET` | `openssl rand -base64 32` (>= 32 chars) |

## 3. Config values (`scripts/put-secrets.sh <file> --config`)

Created by **Terraform** (do not set by hand): `DOMAIN`, `API_DOMAIN`, `ACME_EMAIL`, `ECR_REGISTRY`, `S3_BUCKET`,
`BACKUP_BUCKET`, `AWS_REGION`, `ALLOWED_MEDIA_HOSTS`, `PRIVACY_POLICY_URL`, `MEDIA_RETENTION_DAYS`,
`NEXT_PUBLIC_SITE_URL`, `DESIRED_SHA`.

Derived by `render-env.sh` (do not set): `DATABASE_URL`, `AI_DATABASE_URL`, `REDIS_URL`, `AI_SERVICE_URL`,
`GATEWAY_URL`, `NEXTAUTH_URL`, `S3_ENDPOINT` (empty on AWS), `NODE_ENV=production`.

Set by you:

| ☐ | Name | Value |
|---|------|-------|
| ☐ | `LLM_MODE` | `real` (the AI service and the deploy refuse `fake` in production) |
| ☐ | `LLM_PRIMARY` / `LLM_FALLBACK` | `anthropic` / `openai` |
| ☐ | `VISION_MODEL`, `TEXT_MODEL`, `CHEAP_MODEL` | model ids; `CHEAP_MODEL` must accept images |
| ☐ | `FALLBACK_VISION_MODEL`, `FALLBACK_TEXT_MODEL`, `FALLBACK_CHEAP_MODEL` | model ids of the fallback provider |
| ☐ | `STT_PRIMARY`, `STT_MODEL_WHISPER`, `STT_MODEL_SARVAM` | voice notes |
| ☐ | `TTS_ENABLED`, `TTS_PRIMARY`, `TTS_FALLBACK` | `false` until consent text is reviewed |
| ☐ | `LLM_DAILY_BUDGET_USD` | **required**: the app-level daily cap (keep it small, e.g. `1`) |
| ☐ | `USER_DAILY_COST_USD`, `MAX_COST_PER_REQUEST_USD` | per-user and per-request ceilings |
| ☐ | `DEMO_DAILY_BUDGET_USD` | **required** when `DEMO_API_KEY` is set |
| ☐ | `ADMIN_EMAILS` | comma-separated operator e-mails (empty = admin routes are 404) |
| ☐ | `REDACTION_ENABLED` | `true` (the default; `false` is refused) |
| ☐ | `EXTRACTION_MIN_CONFIDENCE`, `EMERGENCY_MIN_CONFIDENCE`, `DRUG_*`, `MIN_SAVINGS_PCT` | defaults from `.env.example` are fine |
| ☐ | `RL_*`, `WEBHOOK_RATE_LIMIT_PER_MIN`, `BUDGET_*_PCT` | defaults are fine |
| ☐ | `REMINDER_ACK_TIMEOUT_MIN`, `CAREGIVER_ALERT_AFTER_MISSES` | defaults are fine |
| ☐ | `OTEL_EXPORTER_OTLP_ENDPOINT` | empty (off) or `http://otel-collector:4318` with the `obs` profile |
| ☐ | `NEXT_PUBLIC_WA_NUMBER`, `NEXT_PUBLIC_CONTACT_EMAIL`, `NEXT_PUBLIC_GITHUB_URL` | **GitHub repository variables**, baked into the web image at build time |
| ☐ | `GRAFANA_URL`, `LANGFUSE_URL` | links on the admin Operations page (optional) |

Must stay unset or false in production (the app and `render-env.sh` both refuse them): `DEV_ECHO_BOT`,
`REMINDER_TEST_OFFSET_MIN`, `TURNSTILE_SKIP`, `ADMIN_TEST_LOGIN`, static `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`.

## 4. GitHub repository variables (not secrets)

☐ `AWS_DEPLOY_ROLE_ARN` · ☐ `EC2_INSTANCE_ID` · ☐ `BACKUP_BUCKET` · ☐ `SITE_DOMAIN` · ☐ `NEXT_PUBLIC_WA_NUMBER` ·
☐ `NEXT_PUBLIC_CONTACT_EMAIL` · ☐ `NEXT_PUBLIC_GITHUB_URL` · ☐ `NEXT_PUBLIC_TURNSTILE_SITE_KEY` · ☐ `BUILD_RUNNER` (optional).
Create a GitHub **environment** named `production` and add yourself as required reviewer if you want a click before every deploy.

## 5. Launch blockers that are not code

☐ Lawyer reviews `apps/web/content/legal.ts` (privacy policy and terms, Hindi and English) ·
☐ pharmacist reviews the curated brand list, `no_substitute.yaml` and the interaction list ·
☐ doctor/pathologist reviews `lab_tests.yaml`, `critical_values.yaml` and the Hindi lab texts ·
☐ real-model eval runs and a real-model `make demo-cache` ·
☐ Meta Business verification and display name approved ·
☐ the seven WhatsApp templates approved (`docs/whatsapp-templates.md`).
