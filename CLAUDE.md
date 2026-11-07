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
| Admin panel (later) | Next.js 15 + Tailwind |
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
│   └── admin/                 # Next.js (Module M16, later)
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
│   └── whatsapp-templates.md  # template texts submitted to Meta
└── .github/workflows/
```

---

## 6. Data model (PostgreSQL)

```
users            id uuid PK, wa_phone_hash text UNIQUE, wa_phone_enc text, language enum(hi,en) default hi,
                 consent_at timestamptz null, last_inbound_at timestamptz, created_at, deleted_at null

caregivers       id, user_id FK, wa_phone_enc, wa_phone_hash, relation text, verified_at null, created_at

messages         id, user_id FK, direction enum(in,out), wa_message_id text UNIQUE, type enum(text,image,document,audio,button,template),
                 body_redacted text, media_s3_key text null, created_at

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
- [ ] **M1 — Local infra**
  `docker-compose.yml` with Postgres 16 (pg_trgm), Redis 7, MinIO (+ bucket init), optional Langfuse. Prisma schema for §6 tables + first migration. Health endpoints in both apps.
  ✅ `make up` → both apps `/health/ready` return 200.
- [ ] **M2 — WhatsApp webhook (inbound)**
  GET verification (`hub.mode`, `hub.verify_token`, `hub.challenge`), POST with signature verification, payload parsing (text, image, document, audio, interactive button reply, status updates), dedupe, persist `messages`, enqueue `inbound` job.
  ✅ Unit tests with recorded sample payloads; invalid signature → 401; duplicate message → enqueued once; response < 1 s.
- [ ] **M3 — Messaging client (outbound)**
  Send text, interactive buttons (max 3), template messages, media download (get media URL → download → S3). Retry/backoff, rate handling, i18n strings.
  ✅ Mocked Graph API tests; a real "echo" bot works with a test number.

### Phase 2 — Users & AI core
- [ ] **M4 — Onboarding, consent, commands**
  Language selection, consent flow, users table with hash+encryption, commands HELP/LANGUAGE/DELETE (with confirmation + hard delete incl. S3)/STOP REMINDERS.
  ✅ E2E test: new number → consent → DELETE wipes all rows and S3 objects.
- [ ] **M5 — AI service skeleton**
  `/v1/process` contract, service-token auth, LLM provider abstraction (primary + fallback, timeouts, cost tracking), Langfuse integration, prompt loader with versions, gateway `ai-client` module.
  ✅ Fake-LLM test mode; contract test passes; fallback triggered when primary errors.
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
- [ ] **M16 — Admin dashboard (Next.js)**
  Login (admin only), stats (users, docs/day, ack rate, cost), review queue for `needs_review` documents, prompt version view. No PHI shown except via explicit "reveal" with audit log.
- [ ] **M17 — AWS deployment**
  Terraform: VPC, ECS Fargate (gateway, workers, ai-service), RDS Postgres, ElastiCache Redis, S3, Secrets Manager, ALB + HTTPS, CloudWatch. GitHub Actions deploy on tag. Runbook in `docs/`.
  ✅ Public webhook URL connected to a real WhatsApp Business number; smoke test passes.
- [ ] **M18 — Launch hardening**
  Load test (k6) on webhook, backup/restore drill, privacy policy page, real-user pilot (family/friends), collect metrics for portfolio.

### Current status
- **Next module:** M1
- **Notes:** M0 complete. Before M1: push to GitHub and confirm CI is green; run `make docker-build` once Docker Desktop is running. Node 20 reached end-of-life in April 2026; consider moving to Node 22 LTS (needs a Decisions Log entry).

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

---

## 16. How to work in this repo (instructions for Claude Code)

1. Start every session: read this file → read §14 → open the next unchecked module.
2. Before coding a module, write a short plan (files to create/change, tests) and confirm with the user if anything in this file is ambiguous.
3. Keep changes inside the module's scope. If a design change is needed, propose it and add a Decisions Log entry after approval.
4. Never weaken §2 Safety rules or §12 Security to make a test pass.
5. Never commit secrets, real patient images or real phone numbers. Eval images must be anonymised.
6. At module end: run `make lint test`, update README if commands/setup changed, tick §14, update "Current status".
