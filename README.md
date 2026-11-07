# Dawai Saathi 💊

**WhatsApp AI health assistant for Indian families — in Hindi and English.**

Send a photo of a prescription or lab report on WhatsApp and Dawai Saathi will:

- explain the prescription in simple language (dose, timing, duration),
- suggest cheaper generic / Jan Aushadhi alternatives with the same salt,
- explain lab report values against reference ranges,
- send dose reminders and alert a family member if doses are missed,
- flag known interactions between your medicines,
- understand Hindi/English voice notes.

> ⚠️ Dawai Saathi does not diagnose or prescribe. It explains what is written and always asks users to confirm with their doctor or pharmacist. In an emergency it directs users to call 112 / 108.

---

## Architecture

```
WhatsApp ──► Meta Cloud API ──► Gateway (NestJS + BullMQ) ──► AI Service (FastAPI + LangGraph)
                                     │                               │
                                PostgreSQL · Redis · S3        LLM/Vision · Pinecone · Langfuse
```

- **Gateway** — webhook, users & consent, messaging, reminders, caregiver alerts, queues.
- **AI Service** — stateless LangGraph pipeline: emergency guard → redaction → intent → extraction → drug matching / generic finder / interaction check / lab comparison → verifier → composer.

Full design, data model, safety rules and module plan: see [`CLAUDE.md`](./CLAUDE.md).

## Tech stack

NestJS · TypeScript · BullMQ · Redis · PostgreSQL (Prisma, pg_trgm) · Python · FastAPI · LangGraph · Claude / GPT-4o vision · Whisper · Pinecone · Presidio · Langfuse · OpenTelemetry · Docker · AWS (ECS Fargate, RDS, ElastiCache, S3) · Terraform · GitHub Actions

## Repository layout

```
apps/gateway        NestJS API, webhook, workers
apps/ai-service     FastAPI + LangGraph pipeline
apps/web            Next.js landing page, web demo playground and admin dashboard
packages/contracts  Shared API contracts
data/               Medicine, interaction & lab-range datasets + ingestion scripts
evals/              Evaluation datasets, runner and reports
infra/              Terraform & Docker
docs/               ADRs, WhatsApp templates, runbooks
```

## Getting started

### Prerequisites
- Node.js 20+ (`.nvmrc`), pnpm 9 (`npm i -g pnpm@9` or `corepack enable`)
- Python 3.12 (`.python-version`), [uv](https://github.com/astral-sh/uv)
- GNU Make (on Windows, run `make` from Git Bash)
- Docker Desktop (Compose v2) — runs the local Postgres, Redis and MinIO
- Later modules: a Meta developer app with WhatsApp Cloud API (test number is fine) and API keys for your LLM provider(s)

### Setup (works today — M0 + M1)
```bash
git clone <repo-url> dawai-saathi && cd dawai-saathi
cp .env.example .env            # local-only defaults work as-is (see "Ports" below)
make install                    # pnpm install + uv sync (also installs git hooks, generates the Prisma client)
make up                         # postgres + redis + minio (+ private bucket with retention rule), waits until healthy
make migrate                    # apply Prisma migrations (creates all tables, pg_trgm index, constraints)
make dev                        # gateway :3000, ai-service :8000

curl localhost:3000/health/live   # {"status":"ok"}                       (process is up)
curl localhost:3000/health/ready  # {"status":"ok","checks":{"db":"ok","redis":"ok","s3":"ok"}}
curl localhost:8000/health/ready  # {"status":"ok","checks":{"db":"ok"}}
# /health/ready returns HTTP 503 with "fail" for the broken dependency when something is down.
```

Checks and tests:
```bash
make lint                       # Prettier, ESLint, ruff
make typecheck                  # tsc (gateway), mypy --strict (ai-service)
make test                       # unit + e2e (no Docker needed)
make test-integration           # real Postgres/Redis/MinIO on separate ports (5543/6479/9100); cleans up after itself
```

**Local URLs:** MinIO console <http://localhost:9001> (login `dawai-minio` / `dawai-minio-secret`), Prisma Studio via `make db-studio`, Langfuse <http://localhost:3002> after `make up-obs`.

**Ports.** Defaults are 5432 (Postgres), 6379 (Redis), 9000/9001 (MinIO). If one is taken on your machine (a Windows-installed Postgres often owns 5432), change `POSTGRES_PORT` / `REDIS_PORT` / `MINIO_API_PORT` in `.env` and keep `DATABASE_URL`, `AI_DATABASE_URL` and `REDIS_URL` in sync.

**Database access.** The gateway connects as `dawai` (read/write). The AI service connects as `dawai_ai_ro`, a role that can only `SELECT` from `drugs`, `interactions` and `lab_tests` (set `AI_DATABASE_URL`; it falls back to `DATABASE_URL`). To start from scratch: `make db-reset`.

Other targets: `make format`, `make build`, `make docker-build`, `make down`, `make logs`, `make migrate-dev name=<name>`, `make clean`, `make help`.

Coming later: `make seed` (M8), `make eval` (M14). For now these only print which module will implement them.

### Test the webhook locally

**Without Meta (recommended first).** `make webhook` sends a sample payload, signed with your `WA_APP_SECRET` exactly like Meta signs it. Start `make up`, `make migrate`, `make dev` first.

```bash
make webhook FIXTURE=text                 # -> HTTP 200 {"status":"received"}; a row in `messages`, a job logged by the worker
make webhook FIXTURE=text                 # again: same message id -> no new row, no new job
make webhook FIXTURE=text FRESH=1         # new sender + new message ids every time
make webhook FIXTURE=text BAD_SIGNATURE=1 # -> HTTP 401
make webhook FIXTURE=batch WEBHOOK_URL=http://localhost:3010/webhook/whatsapp   # if :3000 is taken
```

Fixtures (`apps/gateway/test/fixtures/whatsapp/`, fake numbers only): `text`, `image`, `document`, `audio`, `button`, `button-legacy`, `unsupported`, `location`, `status`, `batch`, `foreign`.

Check the handshake yourself (use your `WA_VERIFY_TOKEN`):
```bash
curl "localhost:3000/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=local-dev-verify-token&hub.challenge=123"   # -> 123
```

**Real WhatsApp round trip:** see the next section (needs a Meta test number).

### Connect a real Meta test number (echo bot)

With M3 the bot can talk back. A temporary **dev-only echo bot** proves the whole loop (webhook → queue → worker → WhatsApp reply) with a real number. It answers anyone who writes to the number and **skips consent**, so it is off by default and the app refuses to start with it on in production.

1. **Create the Meta app.** [developers.facebook.com](https://developers.facebook.com/apps) → Create app → type *Business* → add the **WhatsApp** product. WhatsApp → *API Setup* shows a free **test number** and its **Phone number ID**.
2. **Add yourself as a recipient.** On the same page, under *To*, add your own WhatsApp number and confirm the code Meta sends. A test number can only message numbers that are on this list.
3. **Get a token.** *API Setup* shows a **temporary access token** (valid 24 hours: fine for a first test, copy a fresh one each day). For anything longer-lived create a **System User** in Business Settings → Users → System users, give it the app with *Full control*, and generate a token with the `whatsapp_business_messaging` and `whatsapp_business_management` permissions (it does not expire).
4. **Fill `.env`** (never commit it):
   ```
   WA_ACCESS_TOKEN=<the token>
   WA_PHONE_NUMBER_ID=<Phone number ID from API Setup>
   WA_APP_SECRET=<App settings → Basic → App secret>
   WA_VERIFY_TOKEN=<any string you invent, e.g. dawai-verify-2026>
   DEV_ECHO_BOT=true
   ```
5. **Run the stack:** `make up && make migrate && make dev`. If another process owns port 3000 use `PORT=3010 make dev` or run the gateway yourself, and tunnel that port.
6. **Expose it:** `ngrok http 3000` (or `cloudflared tunnel --url http://localhost:3000`). Copy the `https://…` URL.
7. **Register the webhook.** WhatsApp → *Configuration* → Webhook → Edit: callback URL `https://<tunnel>/webhook/whatsapp`, verify token = your `WA_VERIFY_TOKEN`. Meta calls the GET handshake immediately: *Verify and save* succeeds only if the gateway is running and the token matches. Then **Manage → subscribe to `messages`**.
8. **Try it.** From your phone send "hello" to the test number. You should get `[dev] आपने लिखा: hello` within a couple of seconds (blue ticks first). Send a photo: you get `[dev] आपका image मिल गया (N KB) और सेव हो गया।` and the file appears in the MinIO console (<http://localhost:9001>, bucket `dawai-media`, `media/<user-id>/<yyyy>/<mm>/<message-id>.jpg`).

If nothing happens: the gateway log shows each Graph API call (`whatsapp api call`, with status and Meta error code, never the token or numbers). Common causes: `401 / code 190` = expired token; `403` on the webhook = wrong verify token; signature `401` = wrong `WA_APP_SECRET`; no reply but `131030` = your number is not on the recipient list; `131047` = more than 24 h since you last wrote (send "hello" again).

**Outside the 24 h window** only approved *template* messages can be sent; their texts are in [`docs/whatsapp-templates.md`](docs/whatsapp-templates.md).

**Without Meta at all:** the integration tests mock the Graph API (`make test-integration`), and `make webhook` simulates inbound messages.

## Common commands

| Command | Description |
|---------|-------------|
| `make up` / `make down` | Start / stop local infrastructure (`make up-obs` adds Langfuse) |
| `make dev` | Run gateway and AI service with hot reload |
| `make test` | Unit + e2e tests (both apps, no Docker needed) |
| `make test-integration` | Integration tests against real Postgres, Redis, MinIO |
| `make webhook FIXTURE=text` | Send a signed sample WhatsApp webhook to the local gateway |
| `make lint` | ESLint, Prettier, ruff, mypy |
| `make migrate` | Apply database migrations (`make migrate-dev name=…` creates one) |
| `make db-reset` | Wipe local volumes, restart infra, re-migrate (asks first) |
| `make seed` | Load catalog datasets |
| `make eval` | Run evaluation suite → `evals/reports/` |

## User commands (on WhatsApp)

`HELP` · `MEDS` · `STOP REMINDERS` · `CAREGIVER +91XXXXXXXXXX` · `LANGUAGE` · `DELETE`

## Privacy

- Explicit consent before any processing.
- Phone numbers encrypted; logs and traces contain no personal data.
- Media auto-deleted after the retention period.
- `DELETE` permanently removes all of a user's data.
- Data hosted in AWS `ap-south-1` (Mumbai).

## Roadmap

See the module plan and progress tracker in [`CLAUDE.md` §14](./CLAUDE.md#14-module-plan--progress-tracker).

## Disclaimer

This project is for informational support only and is not a medical device. It does not replace advice from a qualified doctor or pharmacist.
