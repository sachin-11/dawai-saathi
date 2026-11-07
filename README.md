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
apps/admin          Next.js admin dashboard
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
- Docker — only for `make docker-build` (local infra arrives in M1)
- Later modules: a Meta developer app with WhatsApp Cloud API (test number is fine) and API keys for your LLM provider(s)

### Setup (works today — M0)
```bash
git clone <repo-url> dawai-saathi && cd dawai-saathi
cp .env.example .env            # M0 needs NODE_ENV, LOG_LEVEL, SERVICE_TOKEN, AI_SERVICE_URL
make install                    # pnpm install + uv sync (also installs git hooks)
make lint                       # Prettier, ESLint, ruff
make typecheck                  # tsc (gateway), mypy --strict (ai-service)
make test                       # Jest unit + e2e, pytest
make dev                        # gateway :3000, ai-service :8000
curl localhost:3000/health/live # {"status":"ok"}
curl localhost:8000/health/live # {"status":"ok"}
```

Other targets: `make format`, `make build`, `make docker-build`, `make clean`, `make help`.

Coming later: `make up` / `make down` / `make migrate` (M1), `make seed` (M8), `make eval` (M14). For now these only print which module will implement them.

### Connect WhatsApp locally (from M2)
1. Expose the gateway: `ngrok http 3000` (or cloudflared).
2. In the Meta app dashboard set the webhook URL to `https://<tunnel>/webhook/whatsapp` and the verify token to `WA_VERIFY_TOKEN`.
3. Subscribe to the `messages` field and send "Hi" from your WhatsApp to the test number.

## Common commands

| Command | Description |
|---------|-------------|
| `make up` / `make down` | Start / stop local infrastructure |
| `make dev` | Run gateway and AI service with hot reload |
| `make test` | Unit + integration tests (both apps) |
| `make lint` | ESLint, Prettier, ruff, mypy |
| `make migrate` | Apply database migrations |
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
