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

### Connect WhatsApp locally (from M2)
1. Expose the gateway: `ngrok http 3000` (or cloudflared).
2. In the Meta app dashboard set the webhook URL to `https://<tunnel>/webhook/whatsapp` and the verify token to `WA_VERIFY_TOKEN`.
3. Subscribe to the `messages` field and send "Hi" from your WhatsApp to the test number.

## Common commands

| Command | Description |
|---------|-------------|
| `make up` / `make down` | Start / stop local infrastructure (`make up-obs` adds Langfuse) |
| `make dev` | Run gateway and AI service with hot reload |
| `make test` | Unit + e2e tests (both apps, no Docker needed) |
| `make test-integration` | Integration tests against real Postgres, Redis, MinIO |
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
