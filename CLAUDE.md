# CLAUDE.md — Dawai Saathi (Project Bible)

> This file is the single source of truth for this project. Claude Code: READ THIS FULLY at the start of every session.
> Before writing code, check **§14 Progress Tracker** to see which module is next. After finishing a module, update §14 and §15 (Decisions Log).

---

## 1. What we are building

**Dawai Saathi** is a WhatsApp-based AI health assistant (Hindi + English) for Indian patients and their families.
The user does not install any app. They send a photo, a voice note or a text on WhatsApp.

### The real problems it solves
1. Patients cannot read or understand prescriptions (handwriting, medicine names, dose and timing).
2. Lab reports show High/Low flags with no plain-language explanation, which causes panic or neglect.
3. Branded medicines are expensive; cheaper generic / Jan Aushadhi alternatives with the same salt exist, but people don't know about them.
4. Elderly patients forget doses or mix medicines from different doctors (drug-interaction risk).

### Core features
| # | Feature | What it does |
|---|---------|--------------|
| F1 | Prescription Reader | Photo → extract medicines, strength, dose, frequency, timing, duration → explain in simple Hindi/English |
| F2 | Generic Finder | For each medicine, find salt composition → suggest cheaper generic / Jan Aushadhi alternative with approximate savings |
| F3 | Lab Report Explainer | Photo/PDF → extract test values → compare with reference ranges → plain-language explanation + "questions to ask your doctor". NEVER a diagnosis |
| F4 | Dose Reminders | Create schedule from prescription → WhatsApp reminders → user replies "Taken"/"Le li" → adherence tracking |
| F5 | Caregiver Alerts | Optional family member gets notified when doses are missed repeatedly |
| F6 | Interaction Checker | Check all active medicines of the user against each other → flag known interactions → advise to consult doctor/pharmacist |
| F7 | Voice Support | Hindi/English voice notes in → transcription → answer as text (+ optional voice reply) |
| F8 | Privacy Controls | Consent on first use, `DELETE` command wipes all user data, `HELP`, `STOP` commands |

### Out of scope (do NOT build)
- Diagnosis, treatment recommendations, dosage changes, or "you should stop this medicine".
- Online medicine ordering or payments.
- Doctor consultation / telemedicine.

---

## 2. Non-negotiable safety rules

These rules apply to every prompt, every response and every code path. Any PR that violates them is wrong.

1. **No diagnosis, no prescribing.** The assistant explains what is written; it never decides what the user should take. Every medical answer ends with a short disclaimer line in the user's language.
2. **Emergency short-circuit.** If a message contains emergency signals (chest pain, breathlessness, unconscious, heavy bleeding, suicide/self-harm intent, poisoning, overdose, seizures, stroke signs), skip all LLM processing and immediately reply with the emergency template: call **112 / 108**, go to the nearest hospital. For self-harm signals also include **Tele-MANAS 14416**. This check runs FIRST in the graph.
3. **Low confidence = say so.** If extraction confidence for any medicine is below threshold (`EXTRACTION_MIN_CONFIDENCE`, default 0.75), the bot must say it could not read that item clearly and ask the user to confirm with the pharmacist. Never guess silently.
4. **Generic swaps are suggestions, not instructions.** Always phrase as "same salt, ask your doctor/pharmacist before switching". Only suggest an alternative when salt AND strength AND dosage form match exactly.
5. **Grounding.** Every medicine/test the bot mentions must come from the extracted document or the catalog DB. LLM free-text facts about drugs are not allowed; the response composer only verbalises structured data.
6. **PHI protection.** Phone numbers are stored hashed (lookup) + encrypted (sending). Names/addresses/doctor details in images are redacted from logs and traces. Raw images live in a private bucket with lifecycle expiry (`MEDIA_RETENTION_DAYS`, default 30).
7. **Consent first.** No document is processed before the user has accepted the consent message.

---

## 3. Tech stack (decided — do not change without a Decisions Log entry)

| Layer | Choice |
|-------|--------|
| Monorepo | pnpm workspaces + Turborepo (Node), `uv` for Python |
| Gateway / API | **NestJS** (TypeScript, Node 20 LTS) |
| Queue / jobs | **Redis 7 + BullMQ** (workers live in the gateway app) |
| AI service | **Python 3.12 + FastAPI**, Pydantic v2 |
| Agent orchestration | **LangGraph** |
| LLM / Vision | Provider abstraction; primary: Claude (Anthropic) or GPT-4o, fallback to the other. Configured via env |
| Speech | STT: Whisper API (or Sarvam AI for Indic); TTS optional |
| Database | **PostgreSQL 16** (Prisma in gateway; SQLAlchemy 2 read access in AI service) with `pg_trgm` |
| Vector store | **Pinecone** behind a `VectorStore` interface (pgvector adapter allowed for local dev) |
| Object storage | AWS S3 (MinIO locally) |
| PII redaction | Microsoft Presidio + custom Indian recognisers (phone, Aadhaar-like numbers, PIN codes) |
| Observability | Langfuse (LLM traces), OpenTelemetry + structured JSON logs (pino / structlog), Prometheus metrics |
| Web app (later) | Next.js 15 (App Router) + Tailwind + shadcn/ui, NextAuth for admin login — landing page, web demo playground, admin dashboard |
| Infra | Docker, docker-compose (local), AWS ECS Fargate + RDS + ElastiCache + S3, Terraform |
| CI/CD | GitHub Actions |
| Tests | Jest (gateway), pytest (AI), evals in `evals/` |

---

## 4. Architecture

```
 WhatsApp user
      │  (text / image / voice / button reply)
      ▼
 Meta WhatsApp Cloud API
      │  webhook (POST, signed X-Hub-Signature-256)
      ▼
┌──────────────────────── apps/gateway (NestJS) ────────────────────────┐
│ WebhookController → verify signature → dedupe (wa_message_id)         │
│   → persist message → enqueue job (BullMQ: "inbound")                 │
│                                                                       │
│ Workers:                                                              │
│   InboundWorker   → download media → S3 → call AI service             │
│                   → save structured result → send reply               │
│   ReminderWorker  → send due reminders (template msgs outside 24h)    │
│   CaregiverWorker → missed-dose alerts                                │
│ Modules: users, consent, messaging, documents, medications,           │
│          reminders, caregivers, admin                                 │
└───────────────┬───────────────────────────────────────────────────────┘
                │ internal HTTP (service token), POST /v1/process
                ▼
┌──────────────────────── apps/ai-service (FastAPI) ────────────────────┐
│ LangGraph pipeline:                                                   │
│  emergency_guard → redact → classify_intent ─┬─ prescription branch   │
│                                              ├─ lab_report branch     │
│                                              ├─ generic_query branch  │
│                                              ├─ interaction branch    │
│                                              └─ smalltalk/help        │
│  → verifier → composer (hi/en) → output                               │
│ Tools: vision_extract, drug_matcher (Postgres trgm + Pinecone),       │
│        interaction_lookup, lab_range_lookup, stt                      │
└───────────────┬───────────────────────────────────────────────────────┘
                ▼
     PostgreSQL · Redis · S3 · Pinecone · Langfuse
```

**Ownership rule:** The gateway owns all user-facing state (users, messages, medications, reminders). The AI service is stateless per request; it only READS the catalog tables (`drugs`, `interactions`, `lab_tests`) and returns structured JSON. The AI service never sends WhatsApp messages.

---

## 5. Repository structure

```
dawai-saathi/
├── CLAUDE.md                  # this file
├── README.md
├── .env.example
├── docker-compose.yml         # postgres, redis, minio, langfuse (optional)
├── Makefile                   # make up / down / test / lint / seed / eval
├── turbo.json
├── pnpm-workspace.yaml
├── apps/
│   ├── gateway/               # NestJS
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── config/        # zod-validated env
│   │   │   ├── common/        # logger, filters, guards, crypto util
│   │   │   ├── webhook/
│   │   │   ├── messaging/     # WhatsApp send client, templates, i18n strings
│   │   │   ├── users/
│   │   │   ├── consent/
│   │   │   ├── documents/
│   │   │   ├── medications/
│   │   │   ├── reminders/
│   │   │   ├── caregivers/
│   │   │   ├── ai-client/     # typed HTTP client to ai-service
│   │   │   ├── queues/        # BullMQ queues + workers
│   │   │   └── health/
│   │   ├── prisma/schema.prisma
│   │   └── test/
│   ├── ai-service/            # FastAPI
│   │   ├── app/
│   │   │   ├── main.py
│   │   │   ├── config.py      # pydantic-settings
│   │   │   ├── api/v1/        # routes
│   │   │   ├── schemas/       # Pydantic I/O contracts
│   │   │   ├── graph/         # LangGraph state, nodes, builder
│   │   │   ├── llm/           # provider abstraction + fallback
│   │   │   ├── tools/         # vision_extract, drug_matcher, ...
│   │   │   ├── safety/        # emergency_guard, redaction, disclaimers
│   │   │   ├── prompts/       # versioned prompt files (.md / .jinja)
│   │   │   ├── db/            # SQLAlchemy read models
│   │   │   └── observability/
│   │   ├── tests/
│   │   └── pyproject.toml
│   └── web/                   # Next.js: landing page + web demo playground + admin (Module M16)
├── packages/
│   └── contracts/             # JSON Schema / OpenAPI shared between gateway & ai-service
├── data/
│   ├── raw/                   # source datasets (gitignored if large)
│   ├── seed/                  # cleaned CSVs
│   └── scripts/               # ingestion & embedding scripts
├── evals/
│   ├── datasets/              # anonymised prescriptions/lab reports + gold labels
│   ├── run_eval.py
│   └── reports/
├── infra/
│   ├── terraform/
│   └── docker/
├── docs/
│   ├── adr/                   # architecture decision records
│   ├── modules/               # one simple Hinglish explainer per module (M0.md, M1.md, ...) for interviews
│   └── whatsapp-templates.md  # template texts submitted to Meta
└── .github/workflows/
```

---

## 6. Data model (PostgreSQL)

```
users            id uuid PK, wa_phone_hash text UNIQUE, wa_phone_enc text, language enum(hi,en) default hi,
                 consent_at timestamptz null, last_inbound_at timestamptz, created_at, deleted_at null
                 onboarding_step enum(language,consent,done) default language, consent_version text null, reminders_enabled bool default true   -- M4
                 (deleted_at is only an in-flight marker set while the erasure job runs; the job then HARD-deletes the row)

caregivers       id, user_id FK, wa_phone_enc, wa_phone_hash, relation text, verified_at null, created_at

messages         id, user_id FK, direction enum(in,out), wa_message_id text UNIQUE, type enum(text,image,document,audio,button,template),
                 body_redacted text, media_s3_key text null, created_at
                 delivery_status enum(sent,delivered,read,failed) null, status_updated_at timestamptz null, error_code text null   -- M3: outbound delivery receipts
                 (M2 added the enum value `unsupported` to type; outbound button messages are stored as type `button`)

documents        id, user_id FK, message_id FK, kind enum(prescription,lab_report,unknown),
                 s3_key, status enum(queued,processing,done,failed,needs_review),
                 extraction jsonb, overall_confidence numeric, prompt_version text, model text, created_at

medications      id, user_id FK, document_id FK, raw_name text, drug_id FK null, salt text, strength text, form text,
                 dose text, frequency_per_day int, timings text[] (e.g. ["08:00","20:00"]), relation_to_food enum(before,after,with,any),
                 duration_days int null, start_date date, end_date date null, confidence numeric, active bool

reminders        id, medication_id FK, user_id FK, scheduled_at timestamptz, status enum(pending,sent,taken,missed,cancelled),
                 sent_at null, ack_at null
                 INDEX (status, scheduled_at)

drugs            id, brand_name, salt_composition (normalised, sorted, lowercase), strength, form, pack_size,
                 mrp numeric null, manufacturer, is_generic bool, janaushadhi_code text null, source text
                 INDEX gin (brand_name gin_trgm_ops), INDEX (salt_composition, strength, form)

interactions     id, salt_a, salt_b (salt_a < salt_b), severity enum(minor,moderate,major), summary text, source text

lab_tests        id, code, name, aliases text[], unit, ref_low, ref_high, sex enum(any,m,f), age_min, age_max,
                 explanation_en text, explanation_hi text, source text

audit_logs       id, actor enum(user,system,admin), user_id null, action text, metadata jsonb, created_at
```

Rules: soft-delete is NOT enough for `DELETE` — hard delete user rows, messages, documents, medications, reminders, caregivers and S3 objects; keep only an anonymous audit row (`action=user_deleted`).

---

## 7. Conversation flows

**7.1 First contact / onboarding**
1. Unknown number → language choice buttons (हिन्दी / English).
2. Consent message (what we store, retention, not a doctor, `DELETE` anytime) → buttons [I agree / Not now].
3. Until consent: only HELP and the consent flow work.

**7.2 Prescription**
1. User sends image → immediate ack "Padh raha hoon… 20–30 sec" (within 3 s).
2. AI extracts → gateway saves `documents` + `medications`.
3. Reply: per medicine — name, what it's for only if written on prescription, dose, timing, duration; flagged low-confidence items; generic alternative with savings (if exact match); interaction warnings; disclaimer.
4. Interactive buttons: [Set reminders] [Generic details] [Something is wrong].

**7.3 Lab report** → extract tests → compare against `lab_tests` range (age/sex aware if known, else general range and say so) → explanation + 3 questions for doctor + disclaimer. Critical values (configurable list) → advise contacting doctor today.

**7.4 Reminders**
- Reminder at each timing with buttons [Le li ✅] [Baad me ⏰ (snooze 30m)] [Skip].
- No ack within 60 min → `missed`. N missed (default 2 consecutive) → caregiver alert if configured.
- Outside the 24-hour customer-service window, only Meta-approved **template messages** can be sent. All reminder & caregiver messages are templates (see `docs/whatsapp-templates.md`).

**7.5 Commands:** `HELP`, `MEDS` (list active medicines), `STOP REMINDERS`, `CAREGIVER +91XXXXXXXXXX`, `LANGUAGE`, `DELETE` (confirm with button, then hard delete).

**7.6 Voice note** → STT → treated as text through the same graph.

---

## 8. AI service contract & LangGraph

### 8.1 Endpoint
`POST /v1/process` (internal; header `X-Service-Token`)
```json
{
  "request_id": "uuid",
  "user": { "language": "hi", "age": null, "sex": null },
  "input": { "type": "image|text|audio", "text": null, "media_url": "presigned-s3-url", "mime": "image/jpeg" },
  "context": { "active_medications": [ { "salt": "paracetamol", "strength": "500 mg" } ] }
}
```
Response:
```json
{
  "request_id": "uuid",
  "intent": "prescription|lab_report|generic_query|interaction_query|help|emergency|other",
  "emergency": false,
  "extraction": { "...": "intent-specific structured payload, see app/schemas" },
  "warnings": [ { "type": "low_confidence|interaction|critical_value", "detail": "..." } ],
  "reply": { "language": "hi", "text": "final WhatsApp-ready text (<= 4096 chars)", "buttons": [] },
  "meta": { "model": "...", "prompt_version": "...", "latency_ms": 0, "cost_usd": 0.0, "trace_id": "..." }
}
```

### 8.2 Graph nodes (`app/graph/`)
| Node | Responsibility |
|------|----------------|
| `emergency_guard` | Keyword + small-LLM classifier (hi/en/Hinglish). If emergency → END with emergency template |
| `transcribe` | Only for audio |
| `redact` | Presidio on text; for images, PHI is not sent to logs/traces (only structured output is logged after redaction) |
| `classify_intent` | Cheap model; image → prescription vs lab_report vs other |
| `vision_extract_rx` | Vision LLM → strict JSON (`PrescriptionExtraction` schema), per-field confidence |
| `vision_extract_lab` | Vision LLM → `LabReportExtraction` |
| `normalize_drugs` | Fuzzy match `raw_name` → `drugs` (pg_trgm), fallback Pinecone semantic search; returns salt/strength/form + match score |
| `generic_finder` | Exact salt+strength+form match, sort by price, compute savings |
| `interaction_check` | Pairwise over new + active meds against `interactions` |
| `lab_compare` | Ranges from `lab_tests`, flag high/low/critical |
| `verifier` | Deterministic checks: every mentioned item exists in structured data; low-confidence items flagged; schema valid. Retry extraction once with a stricter prompt on schema failure |
| `composer` | LLM verbalises ONLY the structured payload into hi/en WhatsApp text + disclaimer. Temperature 0 |

State is a typed `TypedDict`/Pydantic model in `app/graph/state.py`. Every node is a pure function `state -> partial state`, unit-tested in isolation.

### 8.3 Prompts
- Stored in `app/prompts/` as files with a version header (`version: rx_extract_v3`). The version is returned in `meta.prompt_version` and saved on `documents`.
- Changing a prompt = bump version + run evals (§11) + note result in Decisions Log.

---

## 9. Configuration (`.env.example`)

```
# common
NODE_ENV=development
LOG_LEVEL=info
SERVICE_TOKEN=change-me                 # gateway <-> ai-service
ENCRYPTION_KEY=base64-32-bytes          # AES-256-GCM for phone numbers
PHONE_HASH_PEPPER=change-me

# whatsapp
WA_PHONE_NUMBER_ID=
WA_BUSINESS_ACCOUNT_ID=
WA_ACCESS_TOKEN=
WA_APP_SECRET=                          # for X-Hub-Signature-256
WA_VERIFY_TOKEN=                        # webhook verification
WA_API_VERSION=v21.0

# data
DATABASE_URL=postgresql://dawai:dawai@localhost:5432/dawai
REDIS_URL=redis://localhost:6379
S3_BUCKET=dawai-media
S3_ENDPOINT=http://localhost:9000       # MinIO locally; empty on AWS
AWS_REGION=ap-south-1
MEDIA_RETENTION_DAYS=30

# ai
AI_SERVICE_URL=http://localhost:8000
LLM_PRIMARY=anthropic                   # anthropic | openai
LLM_FALLBACK=openai
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
VISION_MODEL=
TEXT_MODEL=
CHEAP_MODEL=
STT_PROVIDER=whisper                    # whisper | sarvam
EXTRACTION_MIN_CONFIDENCE=0.75
FALLBACK_VISION_MODEL=                  # model ids for LLM_FALLBACK (M5)
FALLBACK_TEXT_MODEL=
FALLBACK_CHEAP_MODEL=
LLM_MODE=fake                           # fake | real (fake refused in production)
LLM_CALL_TIMEOUT_S=20
LLM_MAX_ATTEMPTS=2                      # per provider, inside the request deadline
LLM_BREAKER_THRESHOLD=5
LLM_BREAKER_COOLDOWN_S=60
PROCESS_TIMEOUT_S=60                    # total budget of one /v1/process call
AI_CLIENT_TIMEOUT_MS=70000              # gateway -> ai-service
ALLOWED_MEDIA_HOSTS=localhost:9000      # hosts the AI service may fetch presigned URLs from
PINECONE_API_KEY=
PINECONE_INDEX=dawai-drugs
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_HOST=

# reminders
REMINDER_ACK_TIMEOUT_MIN=60
CAREGIVER_ALERT_AFTER_MISSES=2
```
Both apps validate env at boot (zod in NestJS, pydantic-settings in FastAPI) and fail fast on missing values.

---

## 10. Coding conventions

- TypeScript `strict: true`; ESLint + Prettier. Python: ruff + mypy (strict on `app/`), black-compatible formatting via ruff.
- No `any` / untyped dicts at service boundaries. Contracts live in `packages/contracts` and Pydantic schemas; keep them in sync (generate TS types from OpenAPI).
- Every external call (WhatsApp, LLM, S3, Pinecone) goes through one client class with timeout, retry with exponential backoff + jitter, and structured error.
- Idempotency: inbound messages deduped by `wa_message_id`; jobs use `jobId = wa_message_id`.
- Webhook handler must return 200 within 1 s; all heavy work in workers.
- Logs are JSON with `request_id`, `user_id` (uuid only), never phone numbers, names or raw OCR text.
- User-facing strings live in `apps/gateway/src/messaging/i18n/{hi,en}.json` — no hard-coded strings in services.
- Conventional commits (`feat(reminders): ...`). One module ≈ one feature branch + PR.
- Each module ships with tests; coverage target 80% on business logic.

---

## 11. Testing & evaluation

- **Unit:** every graph node, drug matcher, reminder scheduler, crypto utils, i18n.
- **Integration:** docker-compose test stack; webhook → queue → mocked AI → outbound message asserted.
- **Contract:** gateway client vs ai-service OpenAPI.
- **Evals (`evals/`):**
  - Dataset: 50–100 prescription images + 30 lab reports, anonymised (faces/names/phones blacked out), with gold JSON labels.
  - Metrics: medicine-name exact-match F1, dose/frequency accuracy, salt-match accuracy, generic-suggestion precision (no wrong-strength suggestions = must be 100%), lab value extraction accuracy, emergency-detection recall (must be 100% on the emergency test set), groundedness (no unmentioned drug in reply), p95 latency, cost per document.
  - `make eval` writes a markdown report to `evals/reports/<date>-<prompt_version>.md`.
  - CI fails if safety metrics regress.

---

## 12. Security & compliance

- Verify `X-Hub-Signature-256` on every webhook (HMAC SHA256 with `WA_APP_SECRET`, timing-safe compare).
- Encrypt phone numbers (AES-256-GCM), lookup via peppered SHA-256 hash.
- S3 bucket private, SSE enabled, presigned URLs (5 min) for AI service, lifecycle rule for retention.
- Rate limit per user (e.g. 20 docs/day) and global LLM spend guard (daily budget → degrade to "service busy" message).
- Audit log for consent, delete, caregiver add/remove, admin actions.
- Follow India's DPDP Act principles: explicit consent, purpose limitation, easy erasure, data stays in `ap-south-1`.
- Secrets via AWS Secrets Manager in prod; never commit `.env`.

---

## 13. Observability & ops

- Langfuse trace per AI request (node-level spans, model, tokens, cost, prompt_version), with PHI redacted.
- Metrics: inbound msgs/min, queue depth, job latency p50/p95, LLM error rate, fallback rate, extraction confidence distribution, reminder ack rate, cost/day.
- Health endpoints: `/health/live`, `/health/ready` (checks DB, Redis, S3; AI service also checks LLM config).
- Graceful shutdown for workers; dead-letter queue for failed jobs with user-facing "sorry, please resend" message.

---

## 14. Module plan & Progress Tracker

> Claude Code: work on ONE module at a time, in order. At module end: all acceptance criteria pass, tests green, lint clean, README updated if setup changed, then tick the box and add notes.

### Phase 1 — Foundation
- [x] **M0 — Repo bootstrap** _(done 2026-11-07)_
  Monorepo (pnpm + turbo), NestJS app skeleton, FastAPI app skeleton (`uv`), shared lint/format configs, `.env.example`, Makefile, pre-commit hooks, GitHub Actions (lint + test for both apps).
  ✅ `make lint` and `make test` pass on empty skeletons; CI green.
  _Notes:_ `make install/lint/typecheck/test/build` all green locally (gateway: 12 unit + 5 e2e Jest tests; ai-service: 15 pytest). Both `/health/live` verified via `make dev` on :3000 and :8000. CI workflow has not run yet because there is no GitHub remote; confirm it is green on the first push. Docker images are not built yet (Docker daemon was not running); the gateway `pnpm deploy --prod` output was verified to boot.
- [x] **M1 — Local infra** _(done 2026-11-07)_
  `docker-compose.yml` with Postgres 16 (pg_trgm), Redis 7, MinIO (+ bucket init), optional Langfuse. Prisma schema for §6 tables + first migration. Health endpoints in both apps.
  ✅ `make up` → both apps `/health/ready` return 200.
  _Notes:_ Verified locally: `make up` all healthy; `make migrate` applies `init_schema` (`pg_trgm` + `pgcrypto` installed); gateway + ai-service `/health/ready` 200; stopping Redis → gateway 503 with `redis: "fail"` (recovers to 200 on restart); stopping Postgres → both apps 503; `make lint typecheck test` green (gateway 33 unit + 6 e2e, ai-service 29); `make test-integration` green (gateway 11, ai-service 7); gateway Docker image builds and serves `/health/ready` 200. NOT verified: Langfuse profile (`make up-obs`; compose config validates but was not started), the new CI `integration` job (first run on GitHub pending; its MinIO/role bootstrap steps were simulated locally), `make dev` on :3000/:8000 (those ports were occupied by other local containers, so both apps were run on :3010/:8010 instead). Deviations from §6: `medications.salt/strength/form/dose` are nullable (unreadable/unmatched items are flagged, never guessed); `messages.body_redacted` nullable (media messages); added UNIQUE `caregivers (user_id, wa_phone_hash)`; `drugs.id` is a uuid. Details: `docs/modules/M1.md`.
- [x] **M2 — WhatsApp webhook (inbound)** _(done 2026-11-07)_
  GET verification (`hub.mode`, `hub.verify_token`, `hub.challenge`), POST with signature verification, payload parsing (text, image, document, audio, interactive button reply, status updates), dedupe, persist `messages`, enqueue `inbound` job.
  ✅ Unit tests with recorded sample payloads; invalid signature → 401; duplicate message → enqueued once; response < 1 s.
  _Notes:_ Verified: `make webhook FIXTURE=text` → 200, row in `messages`, worker logs the job; same fixture again → no new row/job; wrong signature → 401; GET handshake returns the challenge; `make lint typecheck test` green (gateway 137 unit + 24 e2e, ai-service 29); `make test-integration` green (gateway 26, ai-service 7). NOT verified: a real Meta → ngrok round trip (needs the real `WA_APP_SECRET` / `WA_PHONE_NUMBER_ID`); `make dev` on :3000 (port busy locally, used :3010). Known: Jest e2e occasionally prints "worker failed to exit gracefully" when run in parallel (tests pass; clean with `--runInBand`). Deviations from the spec: a duplicate message still attempts the enqueue (jobId makes it a no-op) so a "row saved, enqueue failed, Meta retried" message is not lost; `WA_PHONE_NUMBER_ID` is a required env var; `messages.type` gained the value `unsupported` (migration `add_unsupported_message_type`; §6 lists only text/image/document/audio/button/template); phone hash is HMAC-SHA256 keyed with the pepper. Details: `docs/modules/M2.md`.
- [x] **M3 — Messaging client (outbound)** _(done 2026-11-07, manual Meta test pending)_
  Send text, interactive buttons (max 3), template messages, media download (get media URL → download → S3). Retry/backoff, rate handling, i18n strings.
  ✅ Mocked Graph API tests; a real "echo" bot works with a test number.
  _Notes:_ Verified: `make lint typecheck test` green (gateway 332 unit + 25 e2e, ai-service 29); `make test-integration` green (gateway 45 incl. 19 messaging, ai-service 7), covering the echo loop with the exact Graph payloads (Graph API mocked with nock), media → MinIO with SSE `AES256`, status updates + out-of-order + race, retries, non-retryable failure, template fallback, presigned URL, `deletePrefix`. The built gateway image boots and refuses `NODE_ENV=production` + `DEV_ECHO_BOT=true`. A running gateway + a throwaway mock Graph server produced the read receipt and the Hindi echo. **NOT verified: the "real echo bot with a Meta test number" criterion** (needs your Meta token; steps in README "Connect a real Meta test number"). **The dev echo bot (`DEV_ECHO_BOT`, `apps/gateway/src/dev/`) no longer bypasses consent since M4: the InboundRouter runs first and only calls it for users who finished onboarding. It stays a dev tool (production refuses the flag).** Known limits: a crash between a successful send and `job.updateData` can still double-send (WhatsApp has no idempotency key); order between separate outbound jobs is not guaranteed (send one logical reply as one job); the 30 s+ rate-limit backoff is unit-tested, not end-to-end. Details: `docs/modules/M3.md`.

### Phase 2 — Users & AI core
- [x] **M4 — Onboarding, consent, commands** _(done 2026-11-07, manual Meta test pending)_
  Language selection, consent flow, users table with hash+encryption, commands HELP/LANGUAGE/DELETE (with confirmation + hard delete incl. S3)/STOP REMINDERS.
  ✅ E2E test: new number → consent → DELETE wipes all rows and S3 objects.
  _Notes:_ Verified: `make lint typecheck test` green (gateway 639 unit + 25 e2e, ai-service 29); `make test-integration` green (gateway 69 incl. 24 conversation, ai-service 7) including the acceptance E2E (new number → language → consent → photo stored in MinIO → DELETE → confirm → no row in any `user_id` table, S3 prefix empty, exactly one anonymous `user_deleted` audit row, final message once, same number → fresh onboarding), consent-no + photo (nothing downloaded), confirm after TTL (expired, nothing deleted), emergency before consent. A running gateway + mock Graph server went through language → consent → HELP → DELETE → erased, with no phone/text in the logs. NOT verified: the flow on a real Meta number (README "Connect a real Meta test number" + "Conversation flow"). Deviations / additions: message text is classified in the webhook into `signals` (emergency/command) so the router and the queue never see text; deleting a user also deletes that user's other audit rows (only the anonymous `user_deleted` row remains, per §6); the erasure job keeps the phone number ENCRYPTED in its job data (removed on completion) so the final message can still be sent after the row is gone; `users.deleted_at` is set while an erasure is in flight and the router ignores such a user for 15 minutes. Known limits: DB backups/PITR keep deleted data until their own retention expires (document in the privacy policy, decide retention in M17/M18); jobs that are `active` during an erasure cannot be removed (they contain ids only); no emergency check on voice notes until STT (M13); withdrawing consent = `DELETE` for now. Details: `docs/modules/M4.md`.
- [x] **M5 — AI service skeleton** _(done 2026-11-07, real-provider test pending)_
  `/v1/process` contract, service-token auth, LLM provider abstraction (primary + fallback, timeouts, cost tracking), Langfuse integration, prompt loader with versions, gateway `ai-client` module.
  ✅ Fake-LLM test mode; contract test passes; fallback triggered when primary errors.
  _Notes:_ Verified: `make lint typecheck test` green (gateway 691 unit + 25 e2e, ai-service 309); `make test-integration` green (gateway 70, ai-service 7) including the AI branch with the AI service mocked (reply once; AI down -> one error message); the production image builds, boots in fake mode, answers `/v1/process` and returns 401 without the token; `make contracts` is deterministic. NOT verified: the Anthropic/OpenAI adapters against the real APIs (only mocked HTTP), Langfuse against a real server (fake client only), the CI additions (contracts drift + image smoke test) on GitHub, and a WhatsApp round trip. `pricing.yaml` prices are PLACEHOLDERS: fill them before trusting `cost_usd`. Known limits: presigned URLs point at `localhost:9000`, not reachable from a containerised AI service (M7 must fix: public/internal S3 endpoint); the pipeline only classifies text, media gets a static "received" reply. Details: `docs/modules/M5.md`.
- [ ] **M6 — Emergency guard + redaction**
  Keyword lists (hi/en/Hinglish/Devanagari + transliteration), small-LLM classifier, emergency template, Presidio with Indian recognisers.
  ✅ Emergency test set recall = 100%; redaction tests for phone/Aadhaar-like/PIN.

### Phase 3 — Features
- [ ] **M7 — Prescription extraction (F1)**
  Vision prompt → `PrescriptionExtraction` schema (medicines[], per-field confidence, doctor/patient fields redacted), retry on schema failure, low-confidence handling, gateway saves `documents` + `medications`, composer reply in hi/en.
  ✅ Eval on prescription set: report generated; low-confidence items always flagged.
- [ ] **M8 — Medicine catalog + Generic Finder (F2)**
  Ingestion scripts in `data/scripts/` (Jan Aushadhi product list + a brand-medicine dataset — verify licence and record source in `drugs.source`), salt normalisation, pg_trgm matching, Pinecone embeddings fallback, exact salt+strength+form rule, savings calculation.
  ✅ Zero wrong-strength suggestions on eval; matcher unit tests with misspellings ("Dolo 650", "dolo650", "डोलो").
- [ ] **M9 — LangGraph orchestration**
  Wire all nodes per §8.2 with typed state, verifier node, conditional edges, per-node tracing. Replace ad-hoc M7/M8 flow with the graph.
  ✅ Graph unit tests per branch; groundedness check passes on eval set.
- [ ] **M10 — Reminders + caregiver alerts (F4, F5)**
  Schedule generation from medications (timings, duration, food relation), BullMQ delayed/repeatable jobs, template messages, button acks, snooze, missed detection, caregiver add/verify (caregiver must reply YES), alerts, `MEDS` and `STOP REMINDERS`.
  ✅ Time-travel tests (fake timers) for full schedule lifecycle; timezone = Asia/Kolkata.
  _M4 note:_ the reminder scheduler and every reminder/caregiver send MUST respect `users.reminders_enabled` (set by `STOP REMINDERS` / `START REMINDERS`), and `reminders` jobs must be added to `USER_JOB_QUEUES` in `apps/gateway/src/deletion/queue-cleanup.service.ts` so DELETE removes them.
- [ ] **M11 — Interaction checker (F6)**
  Interaction dataset ingestion (record source & licence), pairwise check over new + active meds, severity-based wording.
  ✅ Unit tests with known pairs; no interaction claim without a DB row.
- [ ] **M12 — Lab report explainer (F3)**
  Lab extraction schema, `lab_tests` seed with reference ranges + hi/en explanations, unit conversions, critical-value list, "questions for your doctor".
  ✅ Lab eval report; critical values always produce "contact doctor today".
- [ ] **M13 — Voice notes (F7)**
  Audio download (ogg/opus) → STT → graph; optional TTS reply.
  ✅ Hindi + Hinglish sample audio tests.

### Phase 4 — Production
- [ ] **M14 — Eval harness & CI gates**
  `evals/run_eval.py`, metrics from §11, markdown report, CI job with thresholds.
- [ ] **M15 — Observability, rate limits, cost guard**
  Metrics, dashboards, DLQ, per-user limits, daily LLM budget guard, alerting.
- [ ] **M16 — Web app (Next.js): landing + demo playground + admin**
  `apps/web`, three sections:
  1. Landing page — what Dawai Saathi does, WhatsApp number / QR "send Hi to start", privacy policy and terms pages (also needed for Meta business verification).
  2. Web demo playground (portfolio-critical) — pick or upload a SAMPLE prescription/lab report → calls the same AI service `/v1/process` → shows extracted medicines with confidence, generic alternatives + savings, warnings, final reply text, and a LangGraph trace view (nodes run, latency, cost per node). Only anonymised sample images allowed: show a clear "do not upload real patient documents" notice, rate limit per IP, never persist uploads, no PHI in logs.
  3. Admin dashboard — login (admin only), stats (users, docs/day, ack rate, cost), review queue for `needs_review` documents, prompt version + eval report view. No PHI shown except via explicit "reveal" with audit log.
  Note: the demo playground may be pulled forward right after M9 once prescription + generic finder work end-to-end.
- [ ] **M17 — AWS deployment**
  Terraform: VPC, ECS Fargate (gateway, workers, ai-service), RDS Postgres, ElastiCache Redis, S3, Secrets Manager, ALB + HTTPS, CloudWatch. GitHub Actions deploy on tag. Runbook in `docs/`.
  ✅ Public webhook URL connected to a real WhatsApp Business number; smoke test passes.
- [ ] **M18 — Launch hardening**
  Load test (k6) on webhook, backup/restore drill, privacy policy page, real-user pilot (family/friends), collect metrics for portfolio.

### Current status
- **Next module:** M6
- **Notes:** M0–M5 complete (M5 needs a real API-key test: `LLM_MODE=real`, README "AI service (M5)") (M3 and M4 still need your manual Meta test-number round trip). Before M6: check GitHub Actions is green for M1–M4 (the `integration` job, which now also needs `nock`-based tests and a MinIO with `MINIO_KMS_SECRET_KEY`, had not run on GitHub yet) and do the manual echo-bot test. The echo bot no longer bypasses consent. For real WhatsApp testing set the real `WA_APP_SECRET`, `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN` (and `WA_ACCESS_TOKEN` from M3). Node 20 reached end-of-life in April 2026; consider moving to Node 22 LTS (needs a Decisions Log entry). Local `.env` may need `POSTGRES_PORT` changed if another Postgres owns 5432 (see README "Ports").

---

## 15. Decisions Log

| Date | Decision | Reason |
|------|----------|--------|
| (start) | NestJS gateway + FastAPI AI service, BullMQ queues | Separation of user state vs stateless AI; matches team skills |
| (start) | Composer may only verbalise structured data | Prevents hallucinated medical facts |
| (start) | Generic suggestion only on exact salt+strength+form | Patient safety |
| 2026-11-07 | Gateway pinned to **NestJS 11** + nestjs-pino 4 (not NestJS 12 / nestjs-pino 5) | NestJS 12 is ESM-only (breaks Jest's CJS runtime); nestjs-pino 5 requires Node ≥ 22.12. Revisit if we move to Node 22+ |
| 2026-11-07 | **TypeScript pinned to ~6.0** (not 7.x) | typescript-eslint supports TS < 6.1 and ts-jest supports TS < 7. Revisit when they support TS 7 |
| 2026-11-07 | Gateway compiles as CommonJS (`module: nodenext`, `isolatedModules`) | Node 20 + Jest + Nest 11 compatibility; ts-jest needs `isolatedModules` with hybrid module kinds |
| 2026-11-07 | Zod 4 for env validation; validated before Nest boots | One clear fail-fast message; errors name variables but never echo values |
| 2026-11-07 | Placeholder `SERVICE_TOKEN` (`change-me`) rejected when `NODE_ENV=production` (both apps) | Prevent shipping default secrets (§12) |
| 2026-11-07 | ai-service reads the shared `NODE_ENV` (or `APP_ENV`, which wins); port is a uvicorn CLI flag (8000), not a setting | One shared `.env` for both apps; avoids a `PORT` clash with the gateway |
| 2026-11-07 | ai-service uses an app factory (`uvicorn app.main:create_app --factory`) | Import has no side effects; tests inject settings without env/.env |
| 2026-11-07 | Same error body in both apps: `{error:{status,code,message,details?,request_id}}` | Consistent client handling; internal error messages never leaked |
| 2026-11-07 | Request id: reuse a safe inbound `x-request-id` (`[A-Za-z0-9._-]{1,128}`) else UUID; echoed on the response | Gateway → ai-service correlation; prevents log injection |
| 2026-11-07 | Access logs contain method + path/url + status only (no bodies; ai-service drops query strings); auth/signature headers redacted | PHI and secret protection in logs (§2.6, §10) |
| 2026-11-07 | LOG_LEVEL uses pino names in both apps (`fatal…trace`, `silent`), mapped to stdlib levels in Python | One shared variable |
| 2026-11-07 | ai-service logging and request-id middleware live in `app/observability/` | That package's purpose per §5; Langfuse/metrics are added there later |
| 2026-11-07 | ai-service has a thin `package.json` that calls `uv run …` | Turborepo orchestrates both apps; `make dev` starts both |
| 2026-11-07 | Gateway image built with `pnpm deploy --prod` + `"files": ["dist"]`; both images run as non-root with a HEALTHCHECK | Minimal production image |
| 2026-11-07 | `.gitattributes` forces LF | Windows `core.autocrlf` would otherwise break Prettier/ruff checks |
| 2026-11-07 | pnpm installed via `npm i -g pnpm@9` locally (corepack needs admin on this Windows machine); version pinned through `packageManager` | Reproducible pnpm version |
| 2026-11-07 | `apps/admin` replaced by `apps/web` (landing + demo playground + admin) | Interviewers need a web demo without WhatsApp |
| 2026-11-07 | Every module ends with a Hinglish explainer in `docs/modules/` | Developer must explain each module in interviews |
| 2026-11-07 | **Prisma pinned to 6.19.3** (not 7.x / 8.0 RC) | npm `latest` is an 8.0 release candidate; 7.x changes the client setup (driver adapters, new generator) and was not tried with our CommonJS + Jest stack (see NestJS 11 entry). 6.x is stable and known to work. Revisit with the Node 22 / ESM move |
| 2026-11-07 | Gateway uses **ioredis 5** (not 6) | BullMQ (M2) depends on ioredis 5; one shared Redis library version |
| 2026-11-07 | MinIO images from **`cgr.dev/chainguard/minio`** (server + init, it ships `mc`) | `minio/minio` and `minio/mc` are no longer published on Docker Hub and `quay.io/minio` returns 401 |
| 2026-11-07 | AI service connects as read-only DB role **`dawai_ai_ro`** (`AI_DATABASE_URL`, falls back to `DATABASE_URL`) and every session is `default_transaction_read_only=on` | Enforce the §4 ownership rule in the database, not only in code. Role is created by `infra/docker/postgres/init/02-roles.sh`; the SELECT grants live in the Prisma init migration (guarded if the role is absent) |
| 2026-11-07 | `audit_logs.user_id` has **no FK**; `medications.drug_id` is `ON DELETE SET NULL`; every other user-owned FK cascades from `users` | `DELETE` must hard-delete a user in one statement yet keep the anonymous `user_deleted` audit row (§6); `drugs` is a shared catalog |
| 2026-11-07 | Pg enums are mapped to snake_case type names (`@@map`), Prisma model/field names are camelCase | Consistent DB naming; readable TypeScript |
| 2026-11-07 | Gateway infra clients (Prisma, ioredis, S3) connect lazily; Prisma logs go through the Nest logger as events (target only) | App boots without Docker for unit/e2e tests; query details can contain PHI (§2.6) |
| 2026-11-07 | `make up` starts long-running services with `--wait`, then runs `minio-init` separately | `docker compose up --wait` fails when a one-shot container exits |
| 2026-11-07 | Integration tests refuse to run unless the DB name ends with `_test`; they use `docker-compose.test.yml` (ports 5543/6479/9100, tmpfs) | Never touch dev data; CI uses the same env var names (`INTEGRATION_*`) |
| 2026-11-07 | Gateway Docker image ships `prisma/` (schema + migrations), installs OpenSSL, and re-runs `prisma generate` inside the deploy output | `pnpm deploy --prod` drops the generated client; Prisma's engine needs OpenSSL on bookworm-slim |
| 2026-11-07 | Webhook raw body: app is created with `rawBody: true` (`app.setup.ts`, shared by `main.ts` and tests); JSON body limit 1 MB; signature compare via `timingSafeEqual` | HMAC must be computed on the exact received bytes (§12) |
| 2026-11-07 | Idempotency on inbound: DB `UNIQUE wa_message_id` + `INSERT … ON CONFLICT DO NOTHING`, plus BullMQ `jobId = waMessageId`; a duplicate message STILL attempts the enqueue | Meta delivers at-least-once. Skipping the enqueue on duplicates would lose a message when the row was saved but Redis failed before the job was added (Meta retries after our 500) |
| 2026-11-07 | Phone hash = HMAC-SHA256(pepper, normalised E.164 digits); encryption = AES-256-GCM, format `v1:<iv>:<tag>:<ct>` (base64) | Keyed hash is stronger than hash+concatenated pepper for a small input space; version prefix allows key rotation |
| 2026-11-07 | Queue job payload carries ids, type, media id, button id only (media filename redacted); no phone number, no text | Redis is not a PHI store (§2.6) |
| 2026-11-07 | `messages.type` enum gets `unsupported`; `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN`, `WA_APP_SECRET`, `ENCRYPTION_KEY`, `PHONE_HASH_PEPPER` are required env vars (placeholders / the public dev encryption key rejected in production) | Unsupported inbound types must still be stored for a polite reply later; foreign `phone_number_id` events can only be ignored if ours is known |
| 2026-11-07 | Webhook status codes: bad/missing signature 401; DB or Redis failure 500 (Meta retries); everything else valid-signature (unsupported type, foreign number, malformed items) 200 | Meta retries on non-2xx; retrying garbage is pointless |
| 2026-11-07 | Exception filter passes through 4xx raised by Express middleware (413/400/415) with a FIXED message, and logs only stack frames for 5xx | body-parser messages can echo a body snippet (PHI); driver error messages can contain row data |
| 2026-11-07 | Loggers are injected as `PinoLogger` + `setContext()` (not `@InjectPinoLogger`) | `@InjectPinoLogger` tokens only exist for classes imported before `LoggerModule` is evaluated |
| 2026-11-07 | `prisma migrate dev` always proposes `DROP INDEX drugs_brand_name_trgm_idx` (hand-written GIN index); delete that line from every generated migration | Prisma cannot model `gin_trgm_ops` indexes |
| 2026-11-07 | `messages` gains `delivery_status` (enum sent/delivered/read/failed), `status_updated_at`, `error_code` (text); statuses only move forward (`sent` < `delivered` < `read`; `failed` never overwrites delivered/read) | Persist Meta delivery receipts (M3). Webhooks arrive out of order; a receipt that beats our own outbound insert is retried 1 s / 3 s / 10 s in-process (best effort, not a durable job) |
| 2026-11-07 | Outbound sends go through the BullMQ `outbound` queue: jobId `<sourceMessageId>_<replyIndex>`, limiter `OUTBOUND_RATE_PER_SEC`, custom backoff (30 s × attempt for rate limits), non-retryable errors → `UnrecoverableError` | One place for retry, throughput and dedupe. `:` is not allowed in BullMQ custom ids, hence `_` |
| 2026-11-07 | `WhatsAppClient` retries ONLY transport-level trouble (HTTP 429, 5xx, connect-phase errors) for sends; read-only calls retry on any failure; code-based rate limits (130429/131056) are left to the queue | The Cloud API has no idempotency key: retrying a send after an ambiguous timeout can deliver twice |
| 2026-11-07 | Message content in `outbound` jobs is stored ENCRYPTED (AES-256-GCM, same key as phone numbers); the Meta message id of every accepted part is written into the job data before the DB insert | Redis must not hold readable PHI (§2.6); a retry must not resend what Meta already accepted |
| 2026-11-07 | 24 h window: open only if `now - last_inbound_at < 24 h` (exactly 24 h = closed, null = closed); checked at enqueue and again at send time; a template fallback is used when closed | Conservative; avoids Meta error 131047 |
| 2026-11-07 | Inbound media: mime allowlist (jpeg/png/webp/pdf/ogg/mpeg/mp4/aac), `MAX_MEDIA_MB` (10) enforced on Meta's size, `Content-Length` and while streaming, S3 key `media/<userId>/<yyyy>/<mm>/<messageId>.<ext>` (no PII), S3 SSE `AES256` (`S3_SSE=none` only for a MinIO without KMS), sha256 verified when Meta sends one | Security and PHI rules (§2.6, §12). Local MinIO needs `MINIO_KMS_SECRET_KEY` (added to both compose files and CI) |
| 2026-11-07 | The WhatsApp bearer token is only sent to https hosts ending in `.fbsbx.com`, `.facebook.com`, `.whatsapp.net`, `.fbcdn.net` | Media download URLs come from a response; never send the token to an arbitrary host |
| 2026-11-07 | `DEV_ECHO_BOT` env flag (default `false`) runs a dev-only echo bot; the env schema REFUSES it when `NODE_ENV=production`; production also rejects `local-dev-*` secrets | The echo bot bypasses consent (§2.7). Must be removed before the M4 consent flow goes live |
| 2026-11-07 | Test tooling: `nock` pinned to 14 (15 is ESM-only; gateway tests are CommonJS), `@aws-sdk/lib-storage` for streaming multipart upload | Same CJS reasoning as the NestJS 11 / Prisma 6 pins |
| 2026-11-07 | `MinIO` images are `cgr.dev/chainguard/minio` and nothing in compose relies on `minio/minio` | Docker Hub no longer publishes it (see M1 entry) |
| 2026-11-07 | `users` gains `onboarding_step` (language/consent/done), `consent_version`, `reminders_enabled`; backfill: users with `consent_at` become `done` | Consent-first onboarding (§7.1, §2.7) and STOP/START REMINDERS (M4) |
| 2026-11-07 | The webhook classifies message text into `signals` (emergency / command) and only those enums go into the `inbound` job; the router never sees text; pre-consent users get `body_redacted = null` and no media download | The queue must stay PHI-free (§2.6) and nothing is stored/processed before consent, yet emergencies and DELETE/HELP must work before consent |
| 2026-11-07 | Emergency pre-check lives in the gateway (`common/safety/emergency-keywords.ts`), runs for every user before anything else, safety-first (substring phrases, accepts false positives), Devanagari nukta/candrabindu folded; replies use outbound priority 1 and are bilingual before a language is chosen | §2.2: must work without the AI service and before consent; the AI classifier (M6) will complement it |
| 2026-11-07 | Commands are whole-message exact matches on the normalised text; buttons are matched by stable ids (`lang:*`, `consent:*`, `delete:*`), never titles | "help me with my medicine" must not trigger HELP; titles are translated and editable |
| 2026-11-07 | DELETE = ask → Redis `pending:delete:{userId}` (5 min TTL) → `user-deletion` job (`jobId delete_{userId}`, 5 attempts). Steps: S3 prefix, the user's `inbound`/`outbound` jobs (also completed ones), pending keys, ONE DB transaction (user + cascade, the user's other audit rows, one anonymous `user_deleted` row with counts only), final message via `WhatsAppClient` | DPDP erasure; the transaction makes "user gone" and "audit row written" one event; every step is re-runnable |
| 2026-11-07 | The erasure job keeps the phone ENCRYPTED in its data (`removeOnComplete`, failed jobs kept 1 h); `users.deleted_at` marks an in-flight erasure and the router ignores the user for 15 min | The final message is sent after `wa_phone_enc` is gone; a stuck job must not silence a user forever |
| 2026-11-07 | Audit metadata is validated (`assertSafeAuditMetadata`): only numbers, booleans, null and short machine tokens; phone-/PIN-/email-like values rejected | Audit must never carry PII (§2.6, §12) |
| 2026-11-07 | The dev echo bot is now called by the InboundRouter only for onboarded users | It can no longer bypass consent (§2.7) |
| 2026-11-07 | Fallback models have their own env vars (`FALLBACK_VISION/TEXT/CHEAP_MODEL`); roles (vision/text/cheap) map to model ids from env only | Model ids differ per provider and are never hard-coded |
| 2026-11-07 | LLM router: up to `LLM_MAX_ATTEMPTS` (2) per provider with jitter inside one request deadline; fallback to the other provider ONLY on timeout/429/5xx/connection, never on 400/auth/schema errors; per-provider circuit breaker (5 failures, 60 s cooldown, half-open probe) | A bad request would fail on both providers and double the cost; a dead provider must not slow every request |
| 2026-11-07 | Structured output = forced tool call (Anthropic) / json_schema (OpenAI), one repair retry, then `LLMSchemaError`; the Anthropic adapter sends no `temperature` | Strict JSON per §8; the installed Anthropic SDK rejects the parameter for these models |
| 2026-11-07 | The AI service receives the REDACTED text stored by the webhook; media goes as a 5-minute presigned URL fetched through an SSRF-safe fetcher (host allowlist, no redirects, mime + size limits) | §2.6 and §12: no raw PHI to the AI service, no open fetcher |
| 2026-11-07 | Contract-first: Pydantic -> OpenAPI (`packages/contracts`) -> generated gateway types; CI fails on drift; `meta` has the extra fields `provider` and `fallback_used` | §10: keep both apps in sync automatically |
| 2026-11-07 | `LLM_MODE=fake` is the default and is refused when `NODE_ENV=production`; the gateway maps `document` to input type `image` | Tests and CI need no keys; the contract only knows image/text/audio |
| 2026-11-07 | Gateway `AiClient` retries only connection errors and 5xx (not 504, not 4xx, not timeouts); an AI failure sends ONE error message (fixed outbound reply index 99) and rethrows so BullMQ retries | `/v1/process` is idempotent by `request_id`; the user must never get two error messages |
| 2026-11-07 | Provider SDK tests mock `httpx2.MockTransport` (the SDKs run on httpx2); `respx` only for our own httpx code | respx cannot intercept the SDK clients |

---

## 16. How to work in this repo (instructions for Claude Code)

1. Start every session: read this file → read §14 → open the next unchecked module.
2. Before coding a module, write a short plan (files to create/change, tests) and confirm with the user if anything in this file is ambiguous.
3. Keep changes inside the module's scope. If a design change is needed, propose it and add a Decisions Log entry after approval.
4. Never weaken §2 Safety rules or §12 Security to make a test pass.
5. Never commit secrets, real patient images or real phone numbers. Eval images must be anonymised.
6. At module end: run `make lint test`, update README if commands/setup changed, tick §14, update "Current status".
7. Module explainer doc (mandatory): at the end of every module write `docs/modules/M<N>.md` in simple Hinglish (Hindi-English mix, Roman script), written so the developer can explain the module to an interviewer. Keep it short (1–2 pages) with these sections:
   ## Is module me kya banaya — 3–5 lines, plain language
   ## Kyun zaroori tha — the problem it solves
   ## Kaise kaam karta hai — step-by-step flow, small ASCII diagram if useful
   ## Important technical decisions — choice + reason (trade-offs)
   ## Production-ready points — security, reliability, testing done in this module
   ## Interview me kaise bolna hai — a 30–45 second spoken-style explanation
   ## Possible interview questions — 4–6 likely questions with short answers
   ## Files / folders — key files touched
   Use real names from the code (files, tables, endpoints). No marketing language.
