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
| Infra | Docker, docker-compose (local + production on EC2), AWS EC2 + RDS PostgreSQL + S3 + Secrets Manager/SSM + ECR, Terraform, Caddy (HTTPS) |
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
                 voice_replies bool default false   -- M13: VOICE ON / VOICE OFF; consent_version is 'v2' (names the speech service) since M13
                 blocked_until timestamptz null, block_reason text null   -- M15: abuse guard (`rate_limit` | `media_spam` | `operator`); a blocked user is ignored except for emergencies, DELETE and HELP
                 timezone default 'Asia/Kolkata', quiet_hours_start '22:30', quiet_hours_end '06:30', consecutive_misses int default 0   -- M10
                 (deleted_at is only an in-flight marker set while the erasure job runs; the job then HARD-deletes the row)

caregivers       id, user_id FK, wa_phone_enc, wa_phone_hash, relation text, verified_at null, created_at
                 status enum(pending,verified,declined,removed), invited_at, last_inbound_at, last_alert_at, alerts_today int, alerts_day date   -- M10
                 -- M10: `relation` holds the name the USER typed ("Papa"), the only identity an alert shows; max 2 active per user (service rule)

messages         id, user_id FK, direction enum(in,out), wa_message_id text UNIQUE, type enum(text,image,document,audio,button,template),
                 body_redacted text, media_s3_key text null, created_at
                 delivery_status enum(sent,delivered,read,failed) null, status_updated_at timestamptz null, error_code text null   -- M3: outbound delivery receipts
                 (M2 added the enum value `unsupported` to type; outbound button messages are stored as type `button`)

documents        id, user_id FK, message_id FK, kind enum(prescription,lab_report,unknown),
                 s3_key, status enum(queued,processing,done,failed,needs_review),
                 extraction jsonb, overall_confidence numeric, prompt_version text, model text, created_at
                 review_label enum(correct,extraction_wrong,unreadable,not_a_document) null, reviewed_at null, reviewed_by_hash null   -- M16: admin review queue verdict (the e-mail is only in the audit row)

medications      id, user_id FK, document_id FK, raw_name text, drug_id FK null, salt text, strength text, form text,
                 dose text, frequency_per_day int null, as_needed bool default false,  -- M7: null for SOS; documents.message_id is UNIQUE (M7)
                 timings text[] (e.g. ["08:00","20:00"]), relation_to_food enum(before,after,with,any),
                 duration_days int null, start_date date, end_date date null, confidence numeric, active bool
                 -- M8: salt_key, strength_key, form_key, release_type, match_score numeric, match_method enum(exact,trgm,vector,salt_written,none)
                 -- M11: salt_key is written ONLY from the interaction checker's report (the salt it used), never from a raw catalog match

reminder_schedules  id, user_id FK, medication_id FK UNIQUE, times text[] (local HH:MM), start_date, end_date null, timezone default 'Asia/Kolkata',
                 status enum(active,paused,completed,cancelled), renewal_notified_at null, created_at   -- M10

reminders        id, schedule_id FK, medication_id FK, user_id FK, scheduled_at timestamptz,
                 status enum(pending,sent,snoozed,taken,skipped,missed,cancelled), sent_at null, ack_at null,
                 snooze_count int, wa_message_id null (not filled yet), job_id text
                 UNIQUE (schedule_id, scheduled_at); INDEX (status, scheduled_at); INDEX (user_id, scheduled_at)   -- M10: one row per medication, ONE message per user+time

drugs            id, brand_name, salt_composition (normalised, sorted, lowercase), strength, form, pack_size,
                 mrp numeric null, manufacturer, is_generic bool, janaushadhi_code text null, source text
                 INDEX gin (brand_name gin_trgm_ops), INDEX (salt_composition, strength, form)
                 -- M8: brand_key text (lowercase alnum, 'dolo650'), salt_key ('amlodipine+telmisartan'), strength_key ('5mg+40mg'),
                 --     form_key (tablet|capsule|syrup|suspension|injection|drops|cream|gel|inhaler|other), release_type enum(ir,sr,er,xr,cr,mr,dr,na),
                 --     pack_qty, pack_unit, price_per_unit (null when unknown), price_source_date, is_janaushadhi, source_ref;
                 --     UNIQUE (source, source_ref); INDEX (salt_key, strength_key, form_key, release_type); gin trgm on brand_key and salt_key

salt_aliases     alias text PK, canonical text   -- M8: mirror of app/catalog/salt_aliases.py, written by `make seed`

interactions     id, salt_a, salt_b (salt_a < salt_b), severity enum(minor,moderate,major), summary text, source text
                 -- M11: mechanism, effect_code (key of the reviewed effect-wording table), management_en, management_hi, hi_reviewed bool,
                 --      evidence_level, source_ref, source_version; salts are canonical names = components of drugs.salt_key;
                 --      UNIQUE (salt_a, salt_b). NO class-rules table: classes are expanded to pairs at ingestion

medication_warnings  id, user_id FK cascade, type enum(interaction,duplicate_ingredient), medication_ids uuid[], salt_a, salt_b (salt_a <= salt_b),
                 severity enum null (null for a duplicate), interaction_id FK null (SET NULL), status enum(active,acknowledged,resolved), created_at
                 -- M11: partial UNIQUE (user_id, type, salt_a, salt_b) WHERE status = 'active'; the AI service has NO grant on this table

lab_tests        id, code, name, aliases text[], unit, ref_low, ref_high, sex enum(any,m,f), age_min, age_max,
                 explanation_en text, explanation_hi text, source text
                 -- M12: `unit` is the CANONICAL unit; one row per (code, sex, age band) of FALLBACK ranges. Added section, unit_conversions jsonb,
                 --      critical_low/high (copied by the seed from app/safety/critical_values.yaml, the yaml is the source of truth),
                 --      doctor_questions_en/hi text[], qualitative_normal text[], hi_reviewed bool (false until a human reviewed the Hindi)

lab_results      id, user_id FK cascade, document_id FK cascade, test_code null, value_num_canonical null, unit_canonical null, value_raw, unit_raw null,
                 status enum(normal,high,low,borderline,critical_high,critical_low,qualitative_abnormal,unknown), report_date null, created_at
                 -- M12: trends + REPORTS; holds no name/id; the AI service has NO grant on it

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

**7.5 Commands:** `HELP`, `MEDS` (list active medicines), `STOP REMINDERS`, `CAREGIVER +91XXXXXXXXXX`, `LANGUAGE`, `VOICE ON` / `VOICE OFF` (M13), `DELETE` (confirm with button, then hard delete). Aliases live in `packages/contracts/commands/aliases.json`; the same table is used for voice notes (M13), where DELETE only shows the confirm button and caregiver commands are not available.

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
  "intent": "prescription|lab_report|generic_query|interaction_query|help|greeting|out_of_scope|emergency|other",
  "emergency": false,
  "emergency_category": null,
  "extraction": { "...": "intent-specific structured payload, see app/schemas" },
  "warnings": [ { "type": "low_confidence|interaction|critical_value", "detail": "..." } ],
  "reply": { "language": "hi", "text": "final WhatsApp-ready text (<= 4096 chars)", "buttons": [] },
  "meta": { "model": "...", "prompt_version": "...", "latency_ms": 0, "cost_usd": 0.0, "trace_id": "..." },
  "detected_command": null,
  "transcript_redacted_short": null,
  "spoken_text": null
}
```
M13 additions: `detected_command` (voice notes: a command found in the transcript), `transcript_redacted_short` (<= 120 chars, redacted, for the "you asked" line) and `spoken_text` (only when `options.want_spoken`; never for emergencies). `POST /v1/synthesize` turns a `spoken_text` into one Ogg/Opus voice message.

### 8.2 Graph nodes (`app/graph/`)
| Node | Responsibility |
|------|----------------|
| `emergency_guard` | Two stages, both recall-biased. Rules (shared keyword file `packages/contracts/safety/emergency-keywords.json`, runs first on the RAW user text, no LLM) then, only if no match, a `CHEAP_MODEL` classifier on the REDACTED text (`emergency_classify_v1`, `EMERGENCY_MIN_CONFIDENCE`; fails safe to the rules). If emergency → END with the static emergency template. Runs on user-typed text and voice transcripts ONLY, never on text extracted from images |
| `transcribe` | Only for audio |
| `redact` | Presidio on text; for images, PHI is not sent to logs/traces (only structured output is logged after redaction) |
| `classify_intent` | Cheap model on the REDACTED text (`intent_text_v2`: prescription_question, lab_question, generic_query, interaction_query, help, greeting, out_of_scope); out_of_scope and greeting get static templates only. Image → prescription vs lab_report vs other |
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
STT_PRIMARY=whisper                     # M13: whisper | sarvam (STT_FALLBACK = the other one)
STT_MODEL_WHISPER=
STT_MODEL_SARVAM=
STT_MIN_CONFIDENCE=0.35                 # M13: below this a transcript is "unclear"
MAX_AUDIO_SECONDS=120                   # M13: longer voice notes are not transcribed
SARVAM_API_KEY=
TTS_ENABLED=false                       # M13: spoken replies; a user also needs VOICE ON
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
NODE_TIMEOUT_VISION_S=45                # M9 per-node limits (also capped by the request deadline)
NODE_TIMEOUT_CHEAP_S=10
NODE_TIMEOUT_COMPOSER_S=20
NODE_TIMEOUT_IO_S=20
NODE_TIMEOUT_FAST_S=5
GRAPH_RECURSION_LIMIT=25
DEMO_SERVICE_TOKEN=                     # M9/M16: optional (>= 16 chars, != SERVICE_TOKEN); only this caller may send options.include_trace
AI_CLIENT_TIMEOUT_MS=70000              # gateway -> ai-service
ALLOWED_MEDIA_HOSTS=localhost:9000      # hosts the AI service may fetch presigned URLs from
EMERGENCY_MIN_CONFIDENCE=0.5            # classifier threshold, deliberately low (M6)
EMERGENCY_CLASSIFIER_TIMEOUT_S=5        # past this the rules alone decide
REDACTION_ENABLED=true                  # must be true in production
LAB_MAX_PAGES=6                         # M12: pages of a lab-report PDF that are read (max 10)
PINECONE_API_KEY=
PINECONE_INDEX=dawai-drugs
PINECONE_INDEX_HOST=                    # M8: data-plane host, with VECTOR_BACKEND=pinecone
VECTOR_BACKEND=memory                   # M8: memory | pinecone
EMBEDDING_BASE_URL=                     # M8: OpenAI-compatible embeddings (optional; offline embedder if empty)
EMBEDDING_API_KEY=
EMBEDDING_MODEL=
DRUG_TRGM_MIN=0.45                      # M8
DRUG_MATCH_MIN=0.8                      # M8: below this a match is never used for a generic
DRUG_VECTOR_MIN=0.8                     # M8
MIN_SAVINGS_PCT=15                      # M8
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_HOST=

# observability, limits, cost guard (M15)
OTEL_EXPORTER_OTLP_ENDPOINT=            # OTLP/HTTP collector base URL; empty = tracing off
OTEL_SAMPLE_RATIO=0.2                   # share of ordinary traces kept; errors and emergencies are always kept
METRICS_TOKEN=                          # bearer token for GET /metrics on both apps; REQUIRED in production
SHUTDOWN_GRACE_S=25                     # workers get this long to finish jobs in flight on shutdown
WEBHOOK_RATE_LIMIT_PER_MIN=6000         # per IP on POST /webhook/whatsapp (the old fixed 300 throttled the k6 smoke test)
RL_MSG_PER_MIN=10                       # per user; emergencies, DELETE and HELP bypass every limit
RL_MSG_PER_DAY=200
RL_DOCS_PER_DAY=20
RL_VOICE_PER_DAY=30
RL_CAREGIVER_INVITES_PER_DAY=3
RL_BLOCK_AFTER_WINDOWS=5                # limited windows in one day before an automatic block
RL_BLOCK_HOURS=24
LLM_DAILY_BUDGET_USD=                   # Asia/Kolkata day; unset = guard off locally, REQUIRED in production
USER_DAILY_COST_USD=                    # one user's share of the day
BUDGET_ECONOMY_PCT=70                   # economy: cheap model for text calls, no spoken replies
BUDGET_ESSENTIAL_PCT=90                 # essential: prescription reading + emergency + templates only; 100% = exhausted
MAX_COST_PER_REQUEST_USD=               # ai-service: stop a request that would pass this
COST_ESTIMATE_VISION_USD=0.03           # ai-service: projected cost of the next vision call

# web app + demo + admin (M16). Gateway side
DEMO_API_KEY=                           # X-Demo-Key that only the Next.js server knows (>= 16 chars, != SERVICE_TOKEN); unset = /demo/* is 404
DEMO_SERVICE_TOKEN=                     # (above, in the ai block) the demo's own AI token; REQUIRED when DEMO_API_KEY is set
DEMO_DAILY_BUDGET_USD=                  # the demo's own daily budget; REQUIRED in production when the demo is on
DEMO_RL_PER_HOUR=10                     # uploads per IP
DEMO_RL_PER_DAY=30
DEMO_MAX_UPLOAD_MB=5
TURNSTILE_SECRET_KEY=                   # without it uploads are refused in production (samples still work)
TURNSTILE_SKIP=false                    # test only, refused in production
ADMIN_EMAILS=                           # comma separated operator e-mails; unset = /admin/* is 404
ADMIN_JWT_SECRET=                       # >= 32 chars; HS256, 5-minute tokens, shared with apps/web only
ADMIN_DATA_DIR=                         # default ./admin-data (made by `make admin-data`)
# web app (apps/web/.env.local). Server-only values never start with NEXT_PUBLIC_ (a test enforces it)
NEXT_PUBLIC_WA_NUMBER=                  # digits with country code: the wa.me link and the QR code (build time)
NEXT_PUBLIC_SITE_URL=
NEXT_PUBLIC_GITHUB_URL=
NEXT_PUBLIC_CONTACT_EMAIL=
NEXT_PUBLIC_TURNSTILE_SITE_KEY=         # public by design
GATEWAY_URL=                            # server-only
NEXTAUTH_SECRET=  NEXTAUTH_URL=  AUTH_GITHUB_ID=  AUTH_GITHUB_SECRET=
GRAFANA_URL=  LANGFUSE_URL=             # links on the admin Operations page
ADMIN_TEST_LOGIN=false                  # Playwright only; refused in production

# reminders
REMINDER_ACK_TIMEOUT_MIN=60
CAREGIVER_ALERT_AFTER_MISSES=2

# evals (M14)
EVAL_MAX_USD=                           # cost cap for `make eval MODE=real`; a real run refuses to start without it
EVAL_VOICE_PROVIDERS=whisper,sarvam     # real voice eval: providers to measure
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
- **Migrations are backward compatible (expand → migrate → contract).** Never drop/rename a column or table in the same release that stops using it; add first, deploy, backfill, remove in a later release. Production rollback (M17) restarts the previous image on the already-migrated database.
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
- [x] **M6 — Emergency guard + redaction + scope guard** _(done 2026-11-07, real-model eval and manual WhatsApp test pending)_
  Keyword lists (hi/en/Hinglish/Devanagari + transliteration), small-LLM classifier, emergency template, Presidio with Indian recognisers, scope guard.
  ✅ Emergency test set recall = 100%; redaction tests for phone/Aadhaar-like/PIN.
  _Notes:_ Verified: emergency eval (152 synthetic rows, 92 positives): rules mode 86/86 recall on keyword rows and 0/40 clear negatives flagged; fake-classifier mode 92/92 recall (reports in `evals/reports/`); `pytest` runs the same gate; redaction positives and medical-content negatives (doses, schedules, lab values, dates untouched); gateway AiProcessor sends the AI emergency reply at priority 1 and audits the category only; production image builds (841 MB, was 412 MB), boots, and answers the four manual sentences correctly in fake mode with no phone number in its logs. NOT verified: the real-model run (`make eval-emergency MODE=real`, needs your keys: overall recall must be 100%), a real WhatsApp round trip ("seene me bahut dard ho raha hai", "mujhe jeena nahi hai", "cricket score batao", "hi"), the new CI steps on GitHub. Known limits: near-miss messages ("no chest pain now", "doctor ne chest pain ke liye ye dawai di thi") ARE flagged on purpose (no negation handling); person names without a context word (Hindi or Roman) are not redacted and spaCy's English model knows few Indian names; addresses only through PIN codes and context words; voice notes are still unguarded until M13; the gateway pre-check does not audit (only the AI path does). Details: `docs/modules/M6.md`.

### Phase 3 — Features
- [x] **M7 — Prescription extraction (F1)** _(done 2026-11-08, real-model eval and manual WhatsApp test pending)_
  Vision prompt → `PrescriptionExtraction` schema (medicines[], per-field confidence, doctor/patient fields redacted), retry on schema failure, low-confidence handling, gateway saves `documents` + `medications`, composer reply in hi/en.
  ✅ Eval on prescription set: report generated; low-confidence items always flagged.
  _Notes:_ Verified: `make lint typecheck test` green (gateway 773 unit + 25 e2e, ai-service 753); `make test-integration` green (gateway 81 incl. 10 prescription, ai-service 7), covering a signed image webhook from an active user -> presigned URL to the (mocked) AI service -> `documents` + `medications` rows -> reply with the three buttons carrying the document id, idempotent re-save, `rx:wrong:<id>` (own and foreign document, malformed id), MEDS, cascade delete; `make contracts` regenerated; `make eval-rx` (fake) and `MODE=fake-noisy` pass the safety gate on 24 synthetic prescriptions (flag recall 6/6, PHI leakage 0, hallucination 0, groundedness 100%); the same gate runs inside pytest on 8 generated cases; a live `uvicorn` in fake mode answered a real image over HTTP. **NOT verified:** any REAL model (the prompts `image_classify_v1`, `rx_extract_v1`, `rx_compose_v1` have never seen a real model: run `make eval-rx MODE=real` with keys, `CHEAP_MODEL` must accept images; the fake modes replay the gold labels and do NOT measure reading accuracy), a WhatsApp round trip with a synthetic image, real phone photos for the blur/dark thresholds (calibrated on synthetic pages only), real encrypted/long PDFs end to end (unit-tested with generated PDFs and a mocked password error), the containerised-AI `S3_AI_ENDPOINT` path (presign unit-tested only). Deviations / additions: the composer LLM writes ONE LINE per readable medicine (header, unreadable-medicine lines, warnings, disclaimer, buttons are templates), stricter than the spec's `{text, buttons}`; the same line is checked by a deterministic grounding verifier, else the j2 template; a medicine whose name, dose or frequency is below threshold (or missing, e.g. a cream with no written dose) is flagged; an impossible duration/strength is dropped (value null), an implausible dose/frequency only lowers confidence; migration `20261108100000_rx_persistence` (`medications.frequency_per_day` nullable, `medications.as_needed`, `documents.message_id` UNIQUE); `end_date` is inclusive; `S3_AI_ENDPOINT`, `MED_TIME_*`, `VISION_MAX_PX`, `IMAGE_MIN_SHARPNESS` env vars; the M5 placeholder extraction is gone (`extraction` is the prescription payload until M12 makes it a union); fixed an M2 integration test that broke once its recorded timestamp was >24 h old. Known limits: a retried inbound job re-calls the AI service (cost) before the idempotent save; a failed schema repair loses that call's cost from `meta`; OD/BD/TDS leave `timings` empty on purpose (M10 must derive reminder times from `frequency_per_day`); no catalog match yet so `salt`/`drug_id` are null; instructions free text can still carry something the redactor does not know (names without a context word). Details: `docs/modules/M7.md`.
- [x] **M8 — Medicine catalog + Generic Finder (F2)** _(done 2026-11-08, real Jan Aushadhi list, real model run and manual WhatsApp test pending)_
  Ingestion scripts in `data/scripts/` (Jan Aushadhi product list + a brand-medicine dataset — verify licence and record source in `drugs.source`), salt normalisation, pg_trgm matching, Pinecone embeddings fallback, exact salt+strength+form rule, savings calculation.
  ✅ Zero wrong-strength suggestions on eval; matcher unit tests with misspellings ("Dolo 650", "dolo650", "डोलो").
  _Notes:_ Verified: `make lint typecheck test` green (gateway 785 unit + 25 e2e, ai-service 1067 unit, 12 integration deselected); `make test-integration` green (gateway 85 incl. 14 prescription with the generic button, persistence of the match fields and the foreign-document check; ai-service 12 incl. a parity test that runs the SAME 279 cases and the four hard gates against real Postgres/pg_trgm and compares every repository query with the in-memory one); `make contracts` regenerated; `make seed` + `make embed` on a clean throwaway database (idempotent: 101 rows after two runs); `make eval-matcher`: 279 synthetic cases, **all four hard gates 0** (wrong-strength, wrong-form/release, wrong-salt, forbidden suggestion), 0 wrong products, 97.6% correct, 2.4% abstained, 100% of unknown names left unmatched, 100% of unsafe-to-compare inputs got no suggestion; `make eval-rx` (+ `fake-noisy`) now also gates unsafe suggestions end to end (0 of 32 / 25). **NOT verified:** the real Jan Aushadhi list (**no file was available: no generic alternatives exist until you export it to `data/raw/pmbjp/` and run `make seed PMBJP_DATE=...`; the loader and parser are tested on generated samples only and the real column layout/names may need adjusting**), the NPPA price check (not built), any licence (none verified, see `data/SOURCES.md`), Pinecone and the embeddings API (mocked HTTP only), a real model on `generic_query_extract_v1` (fake heuristic only), a WhatsApp round trip, and the curated brand list (73 brands written from general knowledge: **a pharmacist must review it and `no_substitute.yaml` before launch**). All prices in the eval/demo fixture are FICTIONAL. Deviations / additions: matching order is exact -> salt-written -> trigram(+prefix) -> vector (salt before trigram so a generic name is not fuzzy-matched to a brand); delayed-release (`dr`) is excluded like the other modified-release types (configurable in the yaml); `brand_key` and `source_ref` columns added; `medications.drug_id` and the keys are stored only when nothing contradicts the product, the salt is kept for an ambiguous match when all candidates share it; new endpoint `POST /v1/generic-details` renders the stored suggestions (no LLM); a prescription written before M8 gets an honest "no suggestions saved" reply. Known limits: Devanagari brand names match only about half of the 9 test names (the transliteration is approximate: k/c, j/z); savings need a brand price, which the curated list does not have (without it the bot says "a generic with the same salt is available" and shows the Jan Aushadhi price); combination products with several written strengths stay unverified (no generic) because the pairing of strength to salt is not written; prices go stale (`price_source_date` is shown, refresh is manual); suggestions are stored at read time, so the details button shows the prices of that day. Details: `docs/modules/M8.md`.
- [x] **M9 — LangGraph orchestration** _(done 2026-11-08, Langfuse/real-model/WhatsApp checks and lock update pending)_
  Wire all nodes per §8.2 with typed state, verifier node, conditional edges, per-node tracing. Replace ad-hoc M7/M8 flow with the graph.
  ✅ Graph unit tests per branch; groundedness check passes on eval set.
  _Notes:_ Verified: `ruff check`/`format --check`, `mypy` (strict) and the full ai-service pytest suite green; gateway `tsc --noEmit` clean; `make contracts` output committed (drift test green); `evals/run_pipeline_comparison.py` through `minimal` and `graph`: PASS, no metric worse, all hard gates 0 (emergency recall 100%, rx safety gates 0, typed-generic gates 0), 34 parity scenarios identical. The comparison found an M8 bug (typed "Dolo 650 syrup ka generic batao" lost the form word and suggested a tablet generic, 3 forbidden suggestions in BOTH pipelines): fixed with `explicit_form()` + `_form_conflict`, 5 `form_in_name` cases added to the matcher dataset (284 cases). **NOT verified:** `make test-integration` and the Docker image with langgraph (not re-run), Langfuse span nesting on a real server (fake client only), the manual WhatsApp tests (prescription photo, "Dolo 650 ka generic batao", "hi", an emergency), the strict retry prompt `rx_extract_strict_v1` on a real model, per-node cost (fake models; `pricing.yaml` is placeholders). **`langgraph` is declared in `pyproject.toml` but `uv.lock` is NOT updated (GitHub 504 on the spaCy wheel): run `uv lock` before CI or the Docker build.** Details: `docs/modules/M9.md`.
- [x] **M10 — Reminders + caregiver alerts (F4, F5)** _(done 2026-11-08, manual WhatsApp test pending)_
  Schedule generation from medications (timings, duration, food relation), BullMQ delayed/repeatable jobs, template messages, button acks, snooze, missed detection, caregiver add/verify (caregiver must reply YES), alerts, `MEDS` and `STOP REMINDERS`.
  ✅ Time-travel tests (fake timers) for full schedule lifecycle; timezone = Asia/Kolkata.
  _Notes:_ Verified: `pnpm lint`, `tsc --noEmit` and `nest build` clean; gateway 994 unit + 25 e2e; gateway integration 121 (against the docker test stack) including `reminders.int-spec.ts` (REAL services + Postgres, in-memory queue, fake Asia/Kolkata clock: a 5-day, 2-doses/day, 2-medicine prescription ends with the scripted statuses taken/snoozed-then-taken/missed/missed/taken/skipped/late-taken/missed/missed/missed, exactly one grouped message per slot (+1 snooze re-send), 3 caregiver alerts with label+time only, both schedules `completed`, queue empty) and `reminders-flow.int-spec.ts` (signed webhook -> router -> real BullMQ workers -> mocked Graph API: summary, "Time badlo" free text, confirm, reminder with the three buttons, Le li, caregiver add/label/invite/YES/alert/STOP ALERTS, own and foreign number rejected, DELETE cascade). Unit tests cover the time parser (Hindi, English, Hinglish table), ack aliases, clock and quiet hours, job ids, message builder, flows, router and webhook. The integration run found and fixed one real bug: the planner did not revive rows cancelled by STOP/pause when the user resumed (`reminders` rows are now revived for the schedule's current slots only). Also fixed a stale M9 expectation in `contract.spec.ts` (`options` field). **NOT verified:** the manual WhatsApp test (set reminders 2-3 minutes ahead with `REMINDER_TEST_OFFSET_MIN`, Le li / Baad me, second number as caregiver with YES, two missed doses -> alert; steps in README "Reminders and caregiver (M10)"), the five templates with Meta (texts in `docs/whatsapp-templates.md`, none submitted), the real 15-minute BullMQ scheduler over hours (the repeatable planner job was seen firing on app boot in the e2e run, but not over a real day; delayed slot/missed/snooze jobs are driven by the fake clock, only the caregiver alert runs through the real queue and worker), the CI integration job on GitHub. Deviations / additions: slot ids use `_` (BullMQ forbids `:`); button ids carry the slot as epoch seconds (`rem:taken:<epoch>`) and the user is always the sender; `reminders.wa_message_id` exists but is not filled (the outbound worker does not call back); `CAREGIVER` takes the number from Redis (the webhook keeps it encrypted, 10 min) and the label comes through a generic "pending input" (Redis `pending:input` + encrypted `pending:input_text`, 10 min) so no text enters a queue; caregiver messages go through the same outbound queue with `recipient.caregiverId` (own 24 h window `caregivers.last_inbound_at`, not stored in `messages`); caregiver replies are recognised by phone hash in the webhook BEFORE onboarding (YES/NO only while an invite is pending; a bare STOP means STOP ALERTS only when the number is not also a user); "Time badlo" applies the typed times to every medicine of the prescription (a medicine needing more doses a day than times given is rejected); REMINDERS uses reply buttons with pagination (2 + "More", or 3 on the last page) because the WhatsApp client has no list messages; the optional daily summary is implemented (21:30-21:45 planner run, one per user and day through the job id, all users on Asia/Kolkata); open-ended prescriptions get `REMINDER_OPEN_ENDED_DAYS` and a renewal question the day before the end. Known limits: quiet hours are stored but not editable by command; `users.timezone` exists but the daily summary and the default times assume Asia/Kolkata; the consecutive-miss counter is one column (concurrent slots could race by one); a user who deletes the chat window and never writes again gets only templates (needs the Meta templates approved); no per-medicine "Time badlo" or per-slot reminder edit. Details: `docs/modules/M10.md`.
- [x] **M11 — Interaction checker (F6)** _(done 2026-11-08, pharmacist review, real-model run and manual WhatsApp test pending)_
  Interaction dataset ingestion (record source & licence), pairwise check over new + active meds, severity-based wording.
  ✅ Unit tests with known pairs; no interaction claim without a DB row.
  _Notes:_ Verified: `make lint`, `make typecheck`, `make test` green (gateway 1049 unit/e2e, ai-service 1392; new: checker, wording + blocklist, verifier, graph branches, endpoints, gateway warnings/flow/router, eval gate); `make test-integration` green (gateway 129 incl. `interactions.int-spec.ts`: two prescriptions on different days with paracetamol -> stored duplicate warning, details button, MEDS marker, CHECK, resolve, DELETE; ai-service 17 incl. Postgres repository = in-memory parity and read-only role); `make contracts` regenerated; `prisma migrate diff` shows only the known pg_trgm index lines; `make seed` loads 846 pairs idempotently into a clean test DB; `make eval-interactions`: 135 hand-gold cases, pair recall 94/94, duplicate recall 15/15, **all hard gates 0** (hallucinated, stop-advice, unchecked-called-safe, severity wording, wrong severity). The eval found and we fixed: a Hindi effect phrase that was a substring of another, catalog salt names that differ from the interaction names (`levothyroxine sodium`, `metoprolol succinate`, `calcium`), norfloxacin missing from its class. **NOT verified:** the manual WhatsApp test (two prescriptions with duplicate paracetamol; `Dolo aur Combiflam saath le sakte hain?`; `CHECK`), `interaction_query_extract_v1` on a real model (fake only; Devanagari questions untested), and any clinical correctness: **the 89-row core list is written from general knowledge, its citations are general ("FDA/DailyMed <drug> label") and were NOT checked against label text; a pharmacist or doctor must review it, `data/review/*.csv` (Hindi wording) and `app/interactions/effects.py` before launch.** Licences in `data/SOURCES.md` are unverified. Deviations / additions: only the curated list is ingested (DDInter/DrugBank not used); no `interaction_class_rules` table (classes expand at ingestion; 89 rows -> 846 pairs); `effect_code` column; `aspirin x clopidogrel` is `minor`; extra endpoints `POST /v1/interaction-check` (CHECK) and `/v1/interaction-details`; the details button is a follow-up message because the prescription reply already uses 3 buttons; `ActiveMedication` gained `medication_id`, `name`, `salt_key`, `strength_key` and `salt`/`strength` are nullable. Known limits: only 73 curated brands, so many brands are "could not be checked" (a medicine written as a known salt is checked by name); re-sending the same photo can show the same brand as a duplicate; medications saved before M11 have no `salt_key` until a new prescription; `uv.lock` was updated by `uv run` (langgraph, from M9): commit it. Details: `docs/modules/M11.md`.
- [x] **M12 — Lab report explainer (F3)** _(done 2026-11-09, doctor review, real-model run and manual WhatsApp test pending)_
  Lab extraction schema, `lab_tests` seed with reference ranges + hi/en explanations, unit conversions, critical-value list, "questions for your doctor".
  ✅ Lab eval report; critical values always produce "contact doctor today".
  _Notes:_ Verified: `ruff`, `mypy` (strict), `eslint`, `prettier` and `tsc --noEmit` clean; ai-service pytest green (8 new lab test files); gateway 1082 unit tests; integration against the docker test stack: gateway 139 (incl. `lab-reports.int-spec.ts`: webhook -> `documents` + `lab_results`, trends context on the second report, `See all tests`, `Something wrong` leaves the trends, REPORTS, foreign/malformed id, cascade) and ai-service 22 (incl. the REAL `seed_lab_tests.py` on a clean DB twice, Postgres = in-memory repository, read-only AI role, no grant on `lab_results`); `prisma migrate diff` shows only the known pg_trgm index lines; `make contracts` and `make graph` regenerated; `make eval-lab`: 36 synthetic reports (multi-page PDFs, category ranges, mixed units, blur/rotation), `fake` and `fake-noisy`, en and hi: **all hard gates 0** (critical recall 12/12, critical line first, diagnosis wording, values not on the page, PHI leakage). Noisy mode found a real bug (a low-confidence value of an invented test was echoed in the "unclear" list): fixed, such values are never repeated. **NOT verified:** `lab_extract_v1` / `lab_extract_strict_v1` / `lab_question_extract_v1` on a REAL model (the fake replays the gold and does NOT measure reading accuracy: run `make eval-lab MODE=real`), real phone photos and real lab PDFs, the manual WhatsApp test (two synthetic reports -> trend line, `REPORTS`, `See all tests`, `TSH 6.2 matlab kya?`), Langfuse, the new CI steps on GitHub. **Launch blockers: a doctor / pathologist must review `data/seed/lab_tests.yaml` (65 tests, ranges, explanations) and `app/safety/critical_values.yaml` (conservative project thresholds, no external citation), and the Hindi texts in `data/review/lab_tests_hi_review.csv`; no licence was verified (`data/SOURCES.md`).** Deviations / additions: the reply is rendered entirely by templates (no TEXT_MODEL composer, stricter than the spec; the verifier still checks it); until Hindi is reviewed the Hindi reply shows no per-test explanation (English does); `borderline` margin = min(5% of the limit, 10% of the range width) (5% of the limit alone made sodium 139 "borderline"); `lab_tests.unit` is the canonical unit (no separate `canonical_unit` column); `POST /v1/lab-render` (summary / all, no LLM) serves the buttons and REPORTS; `extraction` in the contract is now a union by `kind`; template set bumped to `reply_templates_v6`; PDFs are rendered up to `LAB_MAX_PAGES` (prescriptions still read 3). Known limits: a number inside a printed category list is never turned into normal/abnormal by us (flag or fallback decide); one fallback range per sex/age band and no paediatric ranges (a child's value is `unknown` unless the lab's range is readable); qualitative rules only for the urine tests in the seed; a report without a readable date does not join trends; `REPORTS` lists 2 reports per page with a More button; voice is untouched. Details: `docs/modules/M12.md`.
- [x] **M13 — Voice notes (F7)** _(done 2026-11-09, real-provider run, real-audio eval and manual WhatsApp test pending)_
  Audio download (ogg/opus) → STT → graph; optional TTS reply.
  ✅ Hindi + Hinglish sample audio tests.
  _Notes:_ Verified: `make lint`, `make typecheck`, `make test` green (gateway 1126 unit + 25 e2e, ai-service 1687 incl. 126 new voice tests); `make test-integration`: gateway 138 of 139 passed and ai-service 22 passed; the one failure was the old "consent v1" expectation in `conversation.int-spec.ts`, now corrected to v2, and after that fix `voice.int-spec.ts` (10 new) + `conversation.int-spec.ts` (24) were re-run together: 34 pass (the other gateway integration files were not re-run after the correction). Covered: voice note → MinIO → mocked AI → reply, consent-v1 notice (nothing downloaded or sent), consent v2 audit, spoken MEDS, DELETE by voice = confirm buttons only, emergency voice reply plain text and never spoken, `VOICE ON` → text first then upload + audio message; `make contracts`, `make graph`, `make safety-data` committed; `make eval-voice` (100 synthetic prompts: 44 emergency over all 9 categories in en/hi/hinglish, 22 commands, 22 medicine/interaction, 12 chatter): `fake` and `fake-noisy` **all hard gates 0** (emergency recall on voice 44/44 also with low-confidence and damaged transcripts, 0 commands inside sentences, DELETE side effects 0, 0 answers about 5 misheard medicines). The eval found a real bug: a Devanagari "ले ली" counted as too short because vowel signs are combining marks (fixed). **NOT verified:** any REAL Whisper / Sarvam / TTS call (adapters tested against mocked HTTP only; the Whisper-vs-Sarvam table in `make eval-voice MODE=real` has NO numbers yet, run it with your keys after `make_synthetic_voice.py` builds the audio), a real ffmpeg run (not installed on this machine: command lines, pipes and the no-temp-file rule are unit-tested with a fake runner; the Docker image installs ffmpeg but was not rebuilt), real audio, Meta's rendering of the audio message as a voice note (we send mono Ogg/Opus by media id), the manual WhatsApp test (README "Voice notes (M13)"), `OPENAI_BASE_URL`/file-format/size limits of OpenAI transcription (its reference page returned 403; fields taken from the public OpenAPI spec), provider retention terms (only web-searched, see `docs/modules/M13.md`). `pricing.yaml` STT/TTS prices are PLACEHOLDERS. Deviations / additions: the gateway does not read `MAX_AUDIO_SECONDS` (Meta gives no duration; the AI service measures it), the "listening" message is sent when the file is larger than ~20 KB (about 10 s); `reply_templates_v7`; the voice eval has 100 prompts (spec said ~120) because the M6 emergency set has only 44 usable rules-tier phrases per spread; users on consent v1 must agree once and resend their first voice note (it is not processed retroactively); `spoken_text` is a summary for prescriptions and lab reports; `users.voice_replies` migration `20261109130000_m13_voice`. Known limits: Sarvam gives no ASR confidence (only Whisper results can be "low confidence"); Sarvam REST is skipped for notes over `STT_SARVAM_MAX_S` (30 s); a note under ~10 s of file size gets no "listening" message; voice is only as safe as the AI service is up (no gateway emergency pre-check on audio, so an AI outage shows the generic error, not the 112 text); transliteration is approximate (original script is matched too); the spoken reply is best effort and sent through direct upload then the outbound queue (order against the text is by enqueue time); the unit "reminder ack by voice" window is the same 2 hours as text. Details: `docs/modules/M13.md`.

### Phase 4 — Production
- [x] **M14 — Eval harness & CI gates** _(done 2026-11-09, real-mode runs, the first GitHub CI run and an `eval-real.yml` dry run pending)_
  `evals/harness/` + `evals/suites/` (the old `run_*_eval.py` scripts were moved into suites), `evals/thresholds.yaml`, baselines, markdown + JSON report, red-team suite, end-to-end conversation tests, CI with gates, prompt/eval workflow.
  ✅ `make eval` runs every suite and fails on a hard gate or a regression; red-team and e2e suites pass; a deliberately relaxed generic rule and an unversioned prompt edit are caught.
  _Notes:_ Verified: `make eval` (fake modes; 13 suite runs: emergency rules+fake, matcher, interactions, rx fake+noisy, lab fake+noisy, voice fake+noisy, redteam, readability, e2e_conversations): every hard gate passes, no regression against the first baselines (reason "M14 harness consolidation"), about 4.5 min locally of which the conversations take 150 s; report `evals/reports/<date>-<sha>.md` + `.json`; `make test-evals` (gates, baselines, planning, cost cap, manifests, `check-prompts` and `check-evidence` in a throw-away git repo); ai-service pytest 1666 passed, ruff and mypy clean (`evals/` has its own `ruff.toml`); gateway lint, `tsc`, unit 1126, integration 151 (incl. the new `ai-context-isolation.int-spec.ts`) and the 14 conversation scenarios (`make e2e`) on the docker test stack; deliberate breaks: relaxing the generic 4-key rule made `wrong_strength` 20 and the matcher gate fail, editing `rx_extract_v1.md` in place failed `check-prompts`, switching off the injection guard or the emergency rules turns the red-team gate red (pytest). The red team found and we fixed four real gaps: overdose framing was not an emergency, an injected sentence in a medicine NAME or DOSE (rx) or a test name / range text (lab) was printed in the reply (new `app/safety/injection.py`), and dose-change questions got no doctor/pharmacist line (`reply_templates_v8`). **NOT verified:** any REAL model run (`make eval SUITE=<x> MODE=real EVAL_MAX_USD=...`): there are no real-mode baselines and the red-team suite does not yet show whether a real model resists an injection (fake mode plays an `obedient` model to test the deterministic layers); `ci.yml` (matrix, `pr-checks`) and `eval-real.yml` on GitHub (never ran; the YAML was not executed; the weekly run needs repo secrets `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` and variables `LLM_PRIMARY`, `VISION_MODEL`, `TEXT_MODEL`, `CHEAP_MODEL`...), CI timings (estimates), `make contracts` drift on GitHub, `check-evidence` on a real pull request (tested only in a temporary repository; with no base ref it warns and passes). The judge labels (`evals/datasets/judge/validation.jsonl`) were written by the developer / the assistant: have a Hindi-speaking reader relabel them. Deviations / additions: a ninth suite `readability` (soft only); real mode is sequential (retries live in the LLM router); the conversations run in their own database `dawai_e2e_test` (seeded once); the fake AI classifier recognises a lab report by a blue corner marker; `yaml` is a gateway devDependency; every prompt already said "the input is DATA" (a test now enforces it) so no prompt version was bumped; `MinimalPipeline` / `PIPELINE` / `run_pipeline_comparison.py` are gone. Known limits: the lab-trend scenario asserts rows and the REPORTS command, not the trend sentence (the fake reports share one date); a 4001-4096 character message passes WhatsApp but is refused by the AI schema (4000): the gateway behaviour for it is not tested; red-team text cases in fake mode use the fake keyword classifier for intent, so only the deterministic outcomes (static template, emergency, no advice) are asserted; the stub judge scores every pipeline reply 5; a prompt-version check needs the base branch (`origin/<base>`) to be fetched. Details: `docs/modules/M14.md`, process: `docs/eval-process.md`.
- [x] **M15 — Observability, rate limits, cost guard** _(done 2026-11-09, real-model costs, real Meta quality/template payloads, a Linux SIGTERM run and the first GitHub CI run pending)_
  Metrics, dashboards, DLQ, per-user limits, daily LLM budget guard, alerting.
  ✅ One trace per WhatsApp message across both apps, PHI-safe telemetry, six dashboards, SLO burn-rate alerts with runbooks, dead-letter queues, rate limits that never stop an emergency, and a budget state machine.
  _Notes:_ Verified: `make lint`-equivalent (ruff, mypy strict, eslint, prettier, tsc) clean; ai-service pytest green (new `test_m15_observability.py`); gateway 1193 unit, integration 163 (incl. `observability.int-spec.ts` on REAL Redis/BullMQ/Postgres: the Lua sliding window, 50 parallel hits against a limit of 10 let exactly 10 through, abuse block written to `users.blocked_until`, the budget walking normal -> economy -> essential -> exhausted, a job that runs out of attempts landing in `<queue>-dlq` WITHOUT its payload, the inbound user told exactly once, the stuck-erasure alert line, operator retry with an audit row, graceful shutdown with a job in flight, one trace id from a producer span through a real BullMQ job), ai-service integration 22, e2e 44 (the conversation scenarios now also capture the logs of BOTH services and assert no scenario phone number, Aadhaar-like number, e-mail or typed/spoken text appears); `promtool check rules` (42 rules), `amtool check-config`, `infra/observability/check.py` (every metric named in an alert or dashboard is exported by an app, every alert has an existing runbook, dashboards equal their generator). LIVE on this machine (`make up-obs` stack, gateway + AI service with fake models, mock Graph API, test Redis/Postgres): Tempo shows ONE trace id with gateway and ai-service spans (webhook -> inbound process -> ai.process -> AI service -> graph nodes -> outbound process) and only allowlisted attribute keys; Loki has both services' logs with `trace_id`; Prometheus scrapes both apps; six Grafana dashboards provisioned and populated (screenshots in `docs/images/`); a Meta token fault (error 190) fired `WhatsAppTokenError` and `EmergencyReplyFailing` through Prometheus -> Alertmanager -> alert sink; injected spend moved the budget through all four states, the AI service answered busy in essential/exhausted and the emergency message went out in every state; 14 rapid messages from one user gave 10 answers, one notice, 3 silent drops, and a following emergency was still answered; `cli dlq:list|purge` ran against real Redis. k6 smoke (20 msg/s for 2 min, 2400 messages, 200 seeded users, fake providers): 0 failed requests, http p95 45 ms, webhook handler p95 45 ms, reply latency p50 about 0.67 s / p95 about 2.2 s (bucket-interpolated; Meta timestamps have 1 s resolution), inbound queue wait p95 about 11 ms, 0 job failures, 0 dead letters (fake models and mock Graph: real model latency is NOT in these numbers). The live run found and we fixed: the webhook throttle of 300/min answered 429 to 75% of 20 msg/s (now `WEBHOOK_RATE_LIMIT_PER_MIN`, default 6000), counters that first appear non-zero make `increase()` return 0 so the first failure never alerted (alert series are pre-created at 0), the SLO2 recording rule was empty until the first dead letter (`or vector(0)`), a retried inbound job used up the user's quota (the window hit is idempotent per message id), a user could be blocked twice, a forced worker close waited for the whole job (`FORCE_CLOSE_CAP_MS`), Alertmanager crashed in Docker without a private IP (`--cluster.listen-address=`), and the log-leak regex fired on an all-digit UUID segment. **NOT verified:** a real Meta `phone_number_quality_update` / `message_template_status_update` payload (the parser follows Meta's docs, tolerant, unit-tested only); real model costs (the fake provider costs 0, so the budget states were driven by injecting spend into Redis; `pricing.yaml` is still placeholders); an OS `SIGTERM` (this is Windows: `WorkerFactory.close` is tested with a real in-flight BullMQ job, the signal wiring `enableShutdownHooks` from M2 is not); a live LLM provider outage (breaker/fallback from M5 only; the live alert demo used the WhatsApp token error; `LlmErrorRateHigh` and `AllLlmProvidersDown` are checked for syntax and metric names only); the container-log path of the Collector (`filelog/docker`; only host-run logs in `./logs` were shipped); Langfuse in the new stack and the `otel_trace_id` link in a real Langfuse trace (fake client only); the CI `observability` job on GitHub (new, never ran) and the weekly eval workflow. Deviations / additions: the limiter runs AFTER the emergency pre-check and DELETE/HELP and BEFORE onboarding (a pre-consent user is limited from the first job, there is no separate pre-user limiter by phone hash: the webhook per-IP throttle covers floods of unknown numbers); the red-team auto-block signal is not implemented (the gateway cannot see injection-guard hits; they are counted in the AI service as `injection_dropped_total` and shown on the Safety dashboard); the budget state travels in the request (`options.budget_state`, contract regenerated) and the gateway owns the Redis counters; `reply_latency_ms` is recorded only for answers that came from the AI service; no Prisma/DB spans (HTTP, Express, ioredis, manual BullMQ and AI-client spans exist); the Express middleware-layer spans are switched off; templates `reply_templates_v9` (budget.busy, budget.busy_voice, budget.too_big); migration `20261109170000_m15_blocking`; failed `user-deletion` jobs are kept 7 days (was 1 h) so an operator can retry them from the DLQ; `llm_calls_total{role}` can only be derived from the model id, so in fake mode (one id for all roles) it always says `vision`; host ports of Loki/Tempo/Prometheus/Alertmanager/Grafana are configurable (`LOKI_PORT` ...) because 3100/9090/9093 were taken on this machine. Known limits: Redis down = limits and budget fail open; a user already past `USER_DAILY_COST_USD` or `RL_*` limits who writes an emergency in words only the AI classifier (not the keyword pre-check) recognises is not answered as an emergency (every limit notice names 112/108); the daily report job and the planner share the BullMQ worker infrastructure but not a dedicated alert; the dashboards' cost panels show no data in fake mode. Details: `docs/modules/M15.md`, `docs/slo.md`, `docs/runbooks/`.
- [x] **M16 — Web app (Next.js): landing + demo playground + admin** _(done 2026-11-09, real-model cache, GitHub CI, GitHub OAuth, Turnstile and Meta checks pending)_
  `apps/web`, three sections:
  1. Landing page — what Dawai Saathi does, WhatsApp number / QR "send Hi to start", privacy policy and terms pages (also needed for Meta business verification).
  2. Web demo playground (portfolio-critical) — pick or upload a SAMPLE prescription/lab report → calls the same AI service `/v1/process` → shows extracted medicines with confidence, generic alternatives + savings, warnings, final reply text, and a LangGraph trace view (nodes run, latency, cost per node). Only anonymised sample images allowed: show a clear "do not upload real patient documents" notice, rate limit per IP, never persist uploads, no PHI in logs.
  3. Admin dashboard — login (admin only), stats (users, docs/day, ack rate, cost), review queue for `needs_review` documents, prompt version + eval report view. No PHI shown except via explicit "reveal" with audit log.
  _Notes:_ Verified: gateway `tsc`, eslint, prettier clean, 1239 unit tests (new: demo guard/sanitizer/Turnstile/service, admin JWT in every failure mode, admin service, audit `logAdmin`, env rules), 1 e2e file for the demo HTTP API, integration against the docker test stack (`admin-demo.int-spec.ts`: the stats SQL on real data, review queue + cursor paging, reveal writes the audit row BEFORE the 60 s link and shows nothing when the audit write fails, resolve, no phone number in any response, demo upload leaves `documents`/`messages`/`medications`/`users` untouched and deletes the S3 object, demo budget counted apart from the users', exhausted demo budget refuses uploads but serves samples); web `tsc`, eslint, prettier, 30 Vitest tests (reply preview incl. no-markup-injection, confidence bars, extraction table with low-confidence rows, trace timeline + graph highlight, hi/en key parity, legal draft marker, CSP builder, no secret-looking `NEXT_PUBLIC_*`, no server module in a client component), `next build` (landing First Load JS 104 kB, demo 164 kB); Playwright on the REAL stack with fake providers (AI service + gateway + production web build, docker test stack): landing hi/en, wa.me link, QR, CSP/headers, sitemap/robots/OG image, privacy+terms, demo samples with trace, language toggle, live upload, unsupported file, demo key never in the page, admin login/allowlist/overview/review queue/**reveal + audit row in Postgres**/resolve/evals/prompts/operations/sign out, axe (wcag2a/aa) on landing, privacy, demo with results and admin overview, no horizontal scroll at phone width; `scan-bundle` (negative test proves it catches a leak). The e2e found and we fixed: three colour-contrast failures (primary-on-soft, a disabled dropzone with `opacity`, an avatar with alpha), a scrollable region without keyboard focus, an invalid `<dl>`, an audit rule that would have rejected a random uuid whose last 12 characters are digits (the redactor read it as an Aadhaar-like number), and `/admin` being matched by the `[locale]` route. **NOT verified:** a REAL model behind the demo (the 16 cached sample answers were made with `LLM_MODE=fake`: the fake model returns the same canned prescription for every photo and does not read pixels, so `make demo-cache` must be re-run with real keys before the demo is shown), GitHub OAuth (only the test credentials provider ran), Cloudflare Turnstile (verify call mocked; the widget was never rendered), `ci.yml` jobs `web` and `web-e2e` (new, never ran on GitHub), the MinIO `demo/` 24-hour lifecycle rule (script changed, the already running test MinIO was not re-initialised), Hindi legal text and Hindi UI copy by a native reader, **a lawyer's review of the privacy policy and terms (launch blocker)**, real phone widths other than the Playwright Pixel 7 profile, **Lighthouse scores were NOT measured**: `lhci autorun` failed on this Windows machine with `NO_NAVSTART` (trace not recorded), so the 90/95/95/95 targets are only enforced by the new CI job `web`, which has not run. Deviations / additions: Auth.js v4 (stable) instead of v5 beta; locale routing is a small middleware (Hindi at `/`, `/hi/...` redirects) with next-intl only for messages; the architecture diagram is generated from `docs/architecture/graph.mmd` at build time, not a committed SVG; the revealed document picture is fetched by the Next.js server and inlined as a `data:` URL, the presigned link never reaches the browser; the review detail is a dialog on the list row, there is no per-document GET endpoint; `lib/gateway.ts` / `admin-token.ts` use `node:crypto` JWT (HS256 only); the demo needs `DEMO_SERVICE_TOKEN` set on BOTH the gateway and the AI service; web `output: 'standalone'` only with `NEXT_STANDALONE=1` (Windows cannot create the symlinks; the M17 Dockerfile sets it). Known limits: sample answers are cached per language only (an upload re-run needs a fresh captcha); the demo's per-IP key trusts `X-Forwarded-For` from the Next.js server (behind the M17 load balancer the first entry must be the real client); the admin DLQ page shows 25 entries per queue; stats `ackRate` is taken / (taken + missed + skipped); the admin pages are English only; charts have text summaries, not data tables. Details: `docs/modules/M16.md`.
- [ ] **M17 — AWS deployment on EC2**
  AWS deployment on EC2 — Terraform (VPC, EC2, RDS, S3, ECR, IAM, Secrets), Docker Compose prod stack behind Caddy with auto-HTTPS, GitHub Actions build → ECR → deploy via SSM, backups, monitoring, runbook.
  ✅ Public HTTPS webhook connected to a real WhatsApp Business number; smoke test passes.
  _Update 2026-11-10 (evening): infra APPLIED and the stack is DEPLOYED on a `t3.medium` (x86; Mumbai had no `t4g` capacity) with images built locally and pushed to ECR (not via GitHub Actions); `scripts/smoke-prod.sh` all PASS on https://dawai.rasuonline.in and https://api.dawai.rasuonline.in (HTTPS certificate issued, webhook handshake, signed POST, bad signature 401, demo sample). Found and fixed while deploying: Redis `cap_drop` permission error (now `user: 999:1000`), `app/labs/catalog.py` `parents[4]` crash inside the image, `put-secrets.sh` Windows temp path. Still open: Meta credentials are `pending-meta-*` placeholders (WhatsApp does not work until real ones), seed of the catalog, GitHub Actions deploy path, alarm test, rollback test, restore drill, arm64._
  _Notes (code done 2026-11-10, earlier note, superseded above):_ written and statically checked: `infra/terraform/` (72 resources in `terraform plan`, `validate` and checkov clean with the documented skips), `infra/docker/docker-compose.prod.yml` + `Caddyfile`, `infra/deploy/` (deploy / render-env / backup / boot units), `.github/workflows/deploy.yml`, CI job `infra`, `scripts/{smoke-prod,put-secrets,aws-*}.sh`, gateway production guards, docs (`docs/runbooks/{go-live,deploy-rollback,restore,rds-upgrade}.md`, `docs/production-checklist.md`, `docs/security.md`, `docs/modules/M17.md`). Gateway, migrate and web images build locally (x86; the instance is arm64). **Still open (acceptance):** terraform apply, GoDaddy NS records, secrets, first deploy, public smoke test, Meta webhook + templates, manual WhatsApp E2E, alarm test-fire, rollback test, restore drill timing. Never verified: arm64 builds, `deploy.sh`/`render-env.sh` on a real instance (bash syntax only), `deploy.yml` on GitHub, the Budget Action, awslogs driver, Caddy certificate issuance. Demo mode (about $10/month): no RDS, no Elastic IP, instance started with `make start`.
- [ ] **M18 — Launch hardening**
  Load test (k6) on webhook, backup/restore drill, privacy policy page, real-user pilot (family/friends), collect metrics for portfolio.

### Current status
- **Next module:** M17 (AWS deployment: code done on branch `feat/aws-deploy-m17`, apply and verification pending; then M18 launch hardening)
- **Notes:** M0–M16 complete (M16: apply `make migrate` for `m16_review`; set `DEMO_API_KEY`, `DEMO_SERVICE_TOKEN` (gateway AND AI service), `DEMO_DAILY_BUDGET_USD`, `ADMIN_EMAILS`, `ADMIN_JWT_SECRET` in the gateway and the same `DEMO_API_KEY` / `ADMIN_*` + `NEXTAUTH_SECRET` / `AUTH_GITHUB_*` in `apps/web/.env.local`; `make dev` starts the web app on :3001 (port 3001 may be taken locally, use `-p 3011`); re-run `make demo-cache` with REAL keys before showing the demo; a lawyer must review `apps/web/content/legal.ts` (privacy + terms, Hindi and English) before launch; M17 must set `NEXT_STANDALONE=1`, serve the web app behind the ALB with `X-Forwarded-For`, add the `demo/` S3 lifecycle rule in Terraform and run `make admin-data` at image build) · M0–M15 complete (M15: apply `make migrate` for `m15_blocking`; set `METRICS_TOKEN` and `LLM_DAILY_BUDGET_USD` (both REQUIRED in production) and the `RL_*` / `OTEL_*` variables in `.env.example`; `make up-obs` then Grafana :3003; `make check-obs`; the new CI `observability` job has not run on GitHub; put real prices into `apps/ai-service/app/llm/pricing.yaml` before trusting any cost or budget number; confirm a real Meta quality / template webhook against the parser; run a real SIGTERM test on Linux; M16's demo endpoint can reuse `RateLimitService` / `SlidingWindowStore` by IP) · M0–M14 complete (M14: `make test-infra-up` then `make eval` (fake) and `make e2e`; before launch run the real-mode suites with keys, `make eval SUITE=<x> MODE=real EVAL_MAX_USD=<n>` (see `docs/eval-process.md`), commit the reports and write real-mode baselines; set the repo secrets/variables listed in `.github/workflows/eval-real.yml`; have someone relabel `evals/datasets/judge/validation.jsonl`; the new emergency phrases are already copied into both apps by `make safety-data`, and `reply_templates_v8` is in place) · M0–M13 complete (M13: apply `make migrate` for `m13_voice`; set `STT_PRIMARY`/`STT_FALLBACK`, `STT_MODEL_WHISPER`/`STT_MODEL_SARVAM`, `SARVAM_API_KEY`, optionally `TTS_ENABLED` + `TTS_*`; install ffmpeg locally or rebuild the AI image; build the audio with `evals/scripts/make_synthetic_voice.py` and run `make eval-voice MODE=real`; confirm the providers' retention / no-training terms in writing; manual WhatsApp test, README "Voice notes (M13)"; an old `STT_PROVIDER` line in `.env` is ignored) · M0–M12 complete (M12: apply `make migrate` for `m12_lab_reports` and `make seed`; get a doctor / pathologist to review `data/seed/lab_tests.yaml`, `app/safety/critical_values.yaml` and `data/review/lab_tests_hi_review.csv`; run `make eval-lab MODE=real` and the manual WhatsApp test, README "Lab reports (M12)") · M0–M11 complete (M11: apply `make migrate` for `m11_interactions` and `make seed`; get a pharmacist/doctor to review `data/seed/interactions_core.csv`, `data/review/*.csv` and `app/interactions/effects.py`; manual WhatsApp test, README "Interaction checks (M11)") · M0–M10 complete (M10: run the manual WhatsApp reminder test, README "Reminders and caregiver (M10)", and submit the five templates in `docs/whatsapp-templates.md`; apply `make migrate` for `m10_reminders`) · M0–M7 complete (M5, M6 and M7 need a real API-key test: `LLM_MODE=real`, README "AI service (M5)", "Safety layer (M6)" and "Prescriptions (M7)"; for M7 run `make eval-rx MODE=real` and send a synthetic prescription on WhatsApp) (M3 and M4 still need your manual Meta test-number round trip). Apply the new migrations with `make migrate` (M7 `rx_persistence`, M8 `m8_catalog`), then `make seed` (the Jan Aushadhi CSV in `data/raw/pmbjp/` first, see `data/SOURCES.md`; M8 also needs a pharmacist review of `data/seed/brands_curated.csv` and `apps/ai-service/app/safety/no_substitute.yaml`). Before M9: check GitHub Actions is green for M1–M4 (the `integration` job, which now also needs `nock`-based tests and a MinIO with `MINIO_KMS_SECRET_KEY`, had not run on GitHub yet) and do the manual echo-bot test. The echo bot no longer bypasses consent. For real WhatsApp testing set the real `WA_APP_SECRET`, `WA_PHONE_NUMBER_ID`, `WA_VERIFY_TOKEN` (and `WA_ACCESS_TOKEN` from M3). Node 20 reached end-of-life in April 2026; consider moving to Node 22 LTS (needs a Decisions Log entry). Local `.env` may need `POSTGRES_PORT` changed if another Postgres owns 5432 (see README "Ports").

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
| 2026-11-07 | Emergency keywords live in ONE file, `packages/contracts/safety/emergency-keywords.json` (nine categories x en/hi/hinglish/misspellings, JSON schema); each app ships a copy made by `make safety-data` (images stay self-contained) and a test fails when a copy is stale; shared normalisation vectors keep the TypeScript and Python normalisers identical | No duplicated lists (§2.2) without making the Docker builds depend on files outside the app |
| 2026-11-07 | Emergency rules match whole words with up to 2 filler words inside a phrase, repeated Latin letters squeezed, fuzzy matching (edit distance 1, words of 5+ letters, with a blocklist such as "painted") only in the AI service; the gateway pre-check is exact | "seene me bahut dard" did not match "seene me dard"; typing mistakes are common; the gateway stays simple as the first net |
| 2026-11-07 | Emergency stage 2 is a CHEAP_MODEL classifier (`emergency_classify_v1`), `EMERGENCY_MIN_CONFIDENCE` 0.5, trivially short text skipped, ANY classifier error or timeout falls back to the rules and is logged as `emergency_classifier_unavailable` | Recall over precision; the guard must never block a request |
| 2026-11-07 | No negation or history handling in the emergency rules: "no chest pain now" is flagged. Overdose questions ("paracetamol ka overdose kitne mg") are treated as safety-relevant: emergency guidance only, never a dose | A missed emergency costs far more than a needless "call 112"; negation parsing risks missed emergencies. Near misses are reported separately in the eval, not gated |
| 2026-11-07 | The emergency guard takes `UserText` only (typed message, voice transcript from M13) and never text extracted from images | A report saying "chest pain" is history, not an emergency; enforced by the type system and tests |
| 2026-11-07 | Pipeline order: emergency rules on RAW text, then redaction, then the emergency classifier and the intent classifier on REDACTED text only; the response gets `emergency_category` and intents `greeting` / `out_of_scope` | Only redacted text reaches a model, a log or a trace (§2.6); contract changed, regenerated with `make contracts` |
| 2026-11-07 | PHI redaction = Presidio with an explicit allow-list of entities (own Indian recognisers: mobile, Aadhaar-like with Verhoeff, PAN, ABHA, PIN only with a context word, e-mail, URLs with query strings, hospital ids, names after a context word) + spaCy `en_core_web_sm`; spaCy PERSON is trusted only next to a context word; fail closed to a regex layer; engines built once in the lifespan; `REDACTION_ENABLED=false` refused in production | Presidio's generic recognisers would redact doses, dates and lab values; the small model tags drug names like "Metformin" as people; the sm model keeps the image about 430 MB smaller than lg |
| 2026-11-07 | structlog processor redacts fields named `text`, `body`, `prompt`, `output`; Langfuse masks use the same redactor; the gateway keeps its own lighter regex and a shared fixture (`redaction-samples.json`) checks both remove the same samples | Defence in depth (§2.6); the two apps cannot drift unnoticed |
| 2026-11-07 | Scope guard: intent prompt `intent_text_v2` (prescription_question, lab_question, generic_query, interaction_query, help, greeting, out_of_scope); out_of_scope and greeting are static templates; an unclear message shows the help text. Reason: WhatsApp Business policy restricts general-purpose AI chatbots and the product is a focused, use-case-specific health assistant | The model never free-writes an answer to an off-topic question (§2.5) |
| 2026-11-07 | CI gate: `evals/run_emergency_eval.py` (rules: 100% recall on rows with a listed keyword and 0 clear-negative false positives; fake classifier: 100% on all positives; real: 100% on all positives, run manually); the same gate runs inside pytest | CLAUDE.md §11: safety metrics must not regress |
| 2026-11-08 | Prescription flow (M7): `RxPipeline` wraps `MinimalPipeline` (images go through classify -> extract -> validate -> gate -> compose; text and audio unchanged); image classification runs on `CHEAP_MODEL` (must accept images) and a low-confidence or broken answer is treated as "other"; provider outages are NOT disguised as "other" (the gateway retries) | The cheap check protects the expensive extraction; hiding an outage as a user error would lose the message |
| 2026-11-08 | Schema `PrescriptionExtraction`: every value is `{value, confidence}`; NO patient/doctor/phone/address/hospital field and `extra="forbid"`; concrete field classes (`TextField`, `IntField`, ...) instead of a bare generic so the OpenAPI/TypeScript names are readable; `low_confidence`, `validation_notes`, `status` are set by OUR code (a model-supplied value is overwritten) | PHI minimisation (§2.6) enforced by the type, not only by the prompt |
| 2026-11-08 | Deterministic validators beat the model: a written frequency code (`1-0-1`, `TDS`, `SOS`, `q6h`, "twice daily") fixes `frequency_per_day`/timings, written food words (`AC`, `PC`, "khane ke baad") fix `relation_to_food`; the contradicted field's confidence drops below the threshold. Out of range: duration (1-365) and malformed strength -> value removed; dose (tablet > 4, liquid > 50 ml) and frequency (> 6/day) -> confidence lowered. OD/BD/TDS/QID leave `timings` empty (no time is written, none is invented) | "Null better than a guess" (§2.3); the gate only reads name, dose and frequency |
| 2026-11-08 | Confidence gate: a medicine is `low_confidence` when name, dose or frequency is missing or < `EXTRACTION_MIN_CONFIDENCE` (SOS needs only a readable code); its name is never shown when unclear; status `done` / `needs_review` / `failed`; a failed read still saves a `failed` document but no medicines; `overall_confidence` = minimum of the critical fields | §2.3 and the M7 acceptance criterion "low-confidence items always flagged" |
| 2026-11-08 | Composer: the LLM writes ONE line per READABLE medicine only (`rx_compose_v1`, structured `{items}`); header, unreadable lines, warnings, disclaimer and buttons are templates; a deterministic verifier (name present, numbers and Latin words only from that medicine's data, no advice phrases, exact indexes) gates every line, otherwise `rx_reply.{hi,en}.j2` renders the same data; a composer error also falls back | §2.5 grounding with a guarantee the LLM cannot drop a warning; trade-off: less natural phrasing, some fallbacks |
| 2026-11-08 | Image prep: EXIF orientation, RGB, `VISION_MAX_PX` 2000, a brand-new JPEG built from raw pixels (no EXIF/GPS/ICC), 80 MP decompression-bomb guard, in memory only; quality signals via Pillow only (Laplacian variance without the 1-px border, mean brightness, contrast); only a clearly hopeless photo (dark, flat, variance < `IMAGE_MIN_SHARPNESS` 12) skips the model; PDF: first 3 pages via `pypdfium2`, encrypted or > 10 pages rejected | Cost and PHI; no OpenCV/numpy dependency; thresholds calibrated on synthetic pages only (real phone photos still to be tried) |
| 2026-11-08 | Persistence: one transaction per document; `documents.message_id` UNIQUE (`message` -> one `document`); `medications.frequency_per_day` nullable + `as_needed`; low-confidence medicines saved with `active=false`; `salt`/`drug_id` stay null until M8; `end_date` = start + duration - 1 (inclusive); default clock times from `MED_TIME_*` (08:00/14:00/18:00/21:00, Asia/Kolkata); button ids carry `{document_id}` which the gateway fills in after saving; `rx:wrong:<id>` checks ownership, audits counts only | Idempotent retries (§10), consent and DPDP erasure still cascade from `users` |
| 2026-11-08 | `S3_AI_ENDPOINT` (optional): hostname used ONLY to presign URLs for the AI service when it reaches S3 under another name than the gateway | A presigned URL is bound to its host; fixes the M5 "M7 must fix" note for containers |
| 2026-11-08 | Replies longer than 1024 characters that have buttons: the text goes as plain text and the buttons follow in a short second message (`common.next_step`) instead of being dropped | WhatsApp button bodies hold 1024 characters; a 3-medicine reply with disclaimer can exceed it |
| 2026-11-08 | Eval (`evals/run_rx_eval.py`): `fake` replays the gold labels, `fake-noisy` injects model mistakes, `real` calls your provider; gated safety metrics = flag recall 100%, PHI leakage 0, groundedness 100%, hallucination 0 (fake modes); accuracy/cost/latency are reported, not gated; synthetic images are generated (gitignored), labels committed, the same gate runs in pytest on 8 cases | CI must catch safety regressions without keys, and must never claim model accuracy it did not measure |
| 2026-11-08 | Catalog keys (M8): `salt_key` (sorted INN names joined by `+`), `strength_key` (aligned with the salt order, units mcg/mg/iu/ml/%, grams folded to mg, per-volume `250mg/5ml`), `form_key`, `release_type`; ONE normaliser module (`app/catalog/normalise.py`) is used by ingestion and by the matcher; anything that cannot be parsed with certainty is rejected (counted in the ingestion report) or `other`, never guessed | A catalog row and a prescription line must produce the same keys; the generic rule is only as good as the keys |
| 2026-11-08 | Salt-form stripping is conservative and explicit: counter-ion suffixes (hydrochloride, besylate, maleate, mesylate, ...) and a named list (pantoprazole sodium, atorvastatin calcium, ...); sodium/potassium in general, succinate/tartrate etc. are NOT stripped | A wrong merge creates a wrong suggestion; a missing merge only loses one |
| 2026-11-08 | Generic suggestion rules: all four keys equal, confident match (>= `DRUG_MATCH_MIN` 0.8), strength confirmed (written, or the brand-name number equals a catalog amount), no conflict/ambiguity, readable line, not in `no_substitute.yaml` (NTI, insulin/biologics, every modified AND delayed release type, inhaler, `other` forms); cheapest first with Jan Aushadhi first when within 10%; max 2; `MIN_SAVINGS_PCT` 15%; the finder re-checks the four keys itself so a faulty repository cannot leak a wrong row | CLAUDE.md §2.4; the eval gates these at zero |
| 2026-11-08 | A saving is stated only when BOTH prices are known and comparable (same unit); an unknown brand price becomes "a generic with the same salt is available" (no "cheaper"), a prescription naming a salt has no brand price at all | Never claim what the data does not show (§2.5); the curated brand list has no prices |
| 2026-11-08 | Matching order exact -> salt-written -> trigram (+ prefix >= 4 chars, score 0.5-0.8) -> vector -> none; the written strength always wins; a fuzzy match whose modified-release status differs from what is written is a conflict; ambiguity states only what all candidates share; the matcher never raises (catalog failure = unmatched, reply unchanged) | See M8.md; each rule exists because the eval or a test showed a concrete failure |
| 2026-11-08 | Vector fallback behind `VectorStore`: in-memory + deterministic hashing embedder for local/tests/eval, Pinecone (REST) + OpenAI-compatible embeddings for production; no pgvector (the local Postgres image has no extension) | §3 allows an adapter for local dev; real services only tested with mocked HTTP |
| 2026-11-08 | Data sources: Jan Aushadhi list is the only generic/price source (CSV exported by the user into gitignored `data/raw/pmbjp/`), our own unreviewed curated brand list (no prices) is committed, brand datasets from Kaggle/GitHub are local-only, a fixture with FICTIONAL prices is for tests/demo and refused in production; no licence is verified; NPPA not built | No brand dataset with a usable licence was found; honest gaps are documented in `data/SOURCES.md` |
| 2026-11-08 | Button flow: the AI service computes and the gateway stores the suggestions with the document (`documents.extraction`); `rx:generic:<id>` sends that snapshot to `POST /v1/generic-details`, which renders `generic_details/generic_none` templates (no LLM) and verifies every rupee amount and brand against the data; `generic_query` text uses a cheap model only to copy the medicine name out of the message | Prices shown are those of read time (with the date); rendering stays grounded (§2.5) |
| 2026-11-08 | `medications` stores the match (`drug_id`, keys, score, method) only for what is certain: a strength/form conflict or an ambiguity drops the product keys and `drug_id` (the salt is kept when stated), a non-uuid id is never sent to the database | Needed by M11; what is written wins over the catalog |
| 2026-11-08 | CI runs the rx eval (fake modes) and `run_matcher_eval.py`; the matcher eval also runs inside pytest and, against real Postgres, in the integration suite | Safety metrics must not regress (§11) |
| 2026-11-08 | M9: LangGraph state machine (`app/graph/`) is the default pipeline, `PIPELINE=minimal` keeps the old one as rollback; NO checkpointer | The service is stateless (§4); persisting graph state would store PHI-adjacent data (§2.6); retries happen inside one request |
| 2026-11-08 | Routing decisions are pure functions (`graph/routing.py`); reducers: list/cost `operator.add`, `retries` dict-merge; images are excluded from state serialisation; an image can never reach the emergency nodes (structural test) | Unit-testable branches; emergency guard runs on user-typed text and transcripts only (§8.2) |
| 2026-11-08 | `@traced_node` gives every node a timeout class (`NODE_TIMEOUT_*_S`, capped by the request deadline), a Langfuse span, a log line and metrics; timeout = `on_timeout` fallback or 504 `NODE_TIMEOUT`; `GRAPH_RECURSION_LIMIT` 25. No `functools.wraps` on node wrappers | LangGraph reads `__wrapped__`'s signature and would not pass `runtime` |
| 2026-11-08 | Extraction retry: one retry with a stricter prompt file `rx_extract_strict_v1`, then `needs_review`; worst case 4 vision calls (2 providers x 2 attempts). Not tested on a real model | Bounded cost; the strict prompt is new and unevaluated: run `make eval-rx MODE=real` |
| 2026-11-08 | One verifier node (`collect_failures`) owns reply checks and a defence-in-depth re-check of generic suggestions (4 keys, safe match, no-substitute); a failure renders the deterministic template `rx_fallback` | Safety does not depend on the composer LLM |
| 2026-11-08 | `DEMO_SERVICE_TOKEN` (>= 16 chars, != `SERVICE_TOKEN`) is accepted only on `/v1/process`; `debug_trace` goes only to that caller with `options.include_trace` and holds names/numbers only; vision call output (raw OCR JSON) is omitted from Langfuse traces | Web demo (M16) needs a trace without opening PHI paths |
| 2026-11-08 | Typed generic questions keep an explicit form word from the name ("syrup", "injection", "eye drops"): `explicit_form()` feeds a form conflict in the matcher. Diagram `docs/architecture/graph.mmd` via `make graph`, drift-tested, embedded in README and M9.md | Regression eval showed a tablet generic suggested for "Dolo 650 syrup" (§2.4) |
| 2026-11-08 | CI also runs `evals/run_pipeline_comparison.py` (graph vs minimal, fake models): a worse metric or non-zero hard gate fails | Migration must not change behaviour or weaken safety (§11) |
| 2026-11-08 | Modules built in numeric order M10 → M18; demo playground stays in M16 | Simpler tracking; supersedes the earlier "playground right after M9" note |
| 2026-11-08 | M10 reminders use a rolling-window planner: a repeatable `reminder-planner` job (every 15 min) materialises `reminders` rows + delayed BullMQ jobs for the next `REMINDER_HORIZON_HOURS` (36); job ids are deterministic (`rem_<user>_<epoch>`, `miss_`, `snz_`, `alr_`) | Never create jobs for a whole course; edits, pauses and Redis loss only touch/repair 36 hours; running the planner twice is a no-op |
| 2026-11-08 | Every reminder handler re-reads the DB (user, schedule, row status); the job payload is only ids + ISO times. Outbound is enqueued BEFORE rows are marked `sent`. A slot job more than 10 min late marks its rows `missed` silently (no counter, no alert, no late message) | DB is the source of truth (STOP/pause/DELETE leave stale jobs harmless); a crash between enqueue and update re-enqueues the same outbound job id |
| 2026-11-08 | One WhatsApp message per user and time slot (all medicines due), one `reminders` row per medication; button ids `rem:taken|snooze|skip:<slot epoch seconds>` with the sender as the user; interactive message inside the 24 h window, `dose_reminder` template (same three payloads) outside | Notification fatigue; Meta's 128-char payload limit; nobody can answer for another user |
| 2026-11-08 | Statuses: `skipped` is not `missed` (no counter, no alert, does not reset); `snoozed` rows are left alone by the missed-checker; a snooze applies only to `sent` rows (double tap = one snooze), max 2, +`SNOOZE_MINUTES`, never into quiet hours; a late "Le li" within 6 h turns `missed` into `taken`; text answers ("le li") count only for the latest reminder sent within 2 h | Adherence data stays honest; conditional UPDATEs make every ack idempotent |
| 2026-11-08 | `users.consecutive_misses` counts missed SLOTS (not medicines), reset by any taken dose; the alert job is queued at `CAREGIVER_ALERT_AFTER_MISSES` and every miss beyond it; throttled to 1 alert per caregiver per 6 h and 3 per local day (conditional UPDATE claim) | A slot with 3 medicines is one miss; throttling lives at the sender so repeated jobs cannot spam |
| 2026-11-08 | Caregiver consent from both sides: user adds number + a label (`caregivers.relation`, the only identity an alert shows), invite is the `caregiver_invite` template, caregiver replies YES within 48 h (else `declined`); alert template `caregiver_missed_dose_alert` has only `user_label` and `time` params: no medicine, dose or condition (test serialises the request and searches for medicine names) | DPDP minimum necessary information; both parties opt in |
| 2026-11-08 | Caregiver replies are recognised by phone hash in the webhook BEFORE `findOrCreateByPhone` (not stored as user messages); a caregiver message to a number that is also a user falls through unless it is YES/NO for a pending invite or STOP ALERTS | A caregiver is not automatically a user; onboarding for themselves stays separate |
| 2026-11-08 | Free-text answers (caregiver label, "Time badlo" times) and the `CAREGIVER` number are kept ENCRYPTED in Redis (`pending:input`, `pending:input_text`, `pending:cg_phone`, `pending:rem_plan`, 5-10 min TTL) and signalled to the router with the `input` / `ack` / `command` enums; the queue still carries no text | Extends the M4 rule "queue payloads contain no text/phone" to multi-step flows; DELETE clears every `pending:*:<user>` key |
| 2026-11-08 | Outbound can address a caregiver: `OutboundRequest.recipient.caregiverId` (job `userId` = the patient, so erasure finds the job); the caregiver's own 24 h window is `caregivers.last_inbound_at`; caregiver messages are not stored in `messages`; `reminders` joins `USER_JOB_QUEUES` | One send path with retries/limiter; patient's message history stays the patient's |
| 2026-11-08 | Time math with luxon (`Asia/Kolkata`, UTC in the DB, no fixed-offset assumption, tested with a DST zone); "Time badlo" uses a deterministic parser (no LLM): a bare hour up to 12 without a day-part is rejected as ambiguous | India has no DST today, code must not rely on it; never guess AM/PM |
| 2026-11-08 | The planner revives `cancelled` rows for slots the schedule currently produces (START REMINDERS, Resume) but never rows of old times after a time change; `reminder_schedules.medication_id` is UNIQUE (re-confirming updates the schedule) | Found by the integration test: skipDuplicates alone left today's slots cancelled after START |
| 2026-11-08 | Dev helper `REMINDER_TEST_OFFSET_MIN` shifts newly created schedules to now+N minutes (2 min apart); `env.schema` refuses it when `NODE_ENV=production`; `DAILY_SUMMARY_ENABLED` (default false) sends "N of M doses taken" once per user and day from the 21:30-21:45 planner run (job id `sum_<user>_<date>`) | Manual testing without waiting for 08:00; idempotent optional feature |

| 2026-11-08 | Interaction data (M11): the ONLY ingested source is our curated core list (`data/seed/interactions_core.csv` + `interaction_classes.csv`, source `core-v1`, citation per row, partial coverage, pharmacist review pending). DDInter (non-commercial terms unverified), DrugBank (licence) and openFDA (free text) are NOT ingested; classes (`@nsaid`...) expand to explicit pairs at ingestion, so there is no `interaction_class_rules` table; a conflict keeps the higher severity and records both refs | Licences of open datasets were unclear; a small, cited, reviewable list is safer than a large unvetted one |
| 2026-11-08 | No interaction claim without a row, and 'not found' is never 'safe': every interaction sentence is a template filled from a finding (effect text from the reviewed `effects.py` table keyed by `effect_code`); the verifier requires the exact block built from the findings, rejects any effect phrase / 'nothing found' line / severity marker the findings do not justify, and a hi/en blocklist rejects stop/skip advice; a database failure is reported (`database_ok=false`), a medicine without a certain salt is listed as 'could not be checked' | CLAUDE.md §2.5 and the F6 safety wording; found by the eval (a Hindi phrase that was a substring of another) |
| 2026-11-08 | The checker works on the active moiety (`warfarin sodium` -> `warfarin`), checks only medicines whose salt is certain (confident match, brand-family prefix, or a name that is exactly a known salt) and, for a new prescription, announces only findings that involve a NEW medicine; duplicate ingredient ranks between major and moderate; paracetamol/NSAID duplicates get the firmer wording; `aspirin x clopidogrel` is minor | Interactions are a property of the ingredient; old pairs must not be repeated; DAPT is prescribed on purpose |
| 2026-11-08 | `medications.salt_key` is written only from the interaction report's `resolved` list; `medication_warnings` is gateway-owned, written in the same transaction as the document, deduplicated by a partial unique index, merged when a new product joins an active warning, resolved when its medicines are switched off or CHECK no longer finds it; the AI service has no grant on it. The 'Interaction details' button is a follow-up message (`ix:details:<document id>` / `all`), `CHECK`/`jaanch karo` re-checks all active medicines via `/v1/interaction-check` | A weak catalog match must never feed a later safety check; WhatsApp allows 3 buttons and the prescription reply uses them |
| 2026-11-08 | Hindi interaction text: a fixed table of effect sentences plus one generic safe management line until a human reviews a row (`hi_reviewed`, review CSVs in `data/review/`); no machine-translated specifics | Medical wording in Hindi must be human-reviewed |
| 2026-11-08 | Prompt `interaction_query_extract_v1` (CHEAP_MODEL, names only) and `reply_templates_v5` (two new keys); CI also runs `evals/run_interaction_eval.py` (135 cases, hard gates), which also runs inside pytest | Prompt/template changes bump the version; safety metrics must not regress (§11) |
| 2026-11-09 | Lab reply (M12) is rendered ONLY from structured data by templates (names, values, units, ranges, dates from the extraction; explanations and doctor questions from `lab_tests`; everything else fixed sentences); no LLM composer | Stricter than "an LLM verbalises the payload": the model cannot add a fact, and `lab_verify` can prove every number, every test name and the absence of diagnosis wording. Cost: less natural phrasing |
| 2026-11-09 | Range priority: the lab's PRINTED range (confidence >= `EXTRACTION_MIN_CONFIDENCE`) > the printed H/L flag > the `lab_tests` fallback range for the age / sex on the report (else the user's, else a general adult range which the reply states). A printed list of CATEGORIES is shown verbatim and never turned into normal / abnormal by us | Reference ranges depend on the lab's method and machine; categories do not say which label is "normal" |
| 2026-11-09 | Critical values (`app/safety/critical_values.yaml`, canonical unit) override every other status, also for a value read with low confidence (the reply then asks to confirm) and against the lab's own "N" flag; the list is a conservative project threshold without an external citation and is a launch blocker until a doctor reviews it. It is separate from the emergency guard, which never sees report text | A missed critical value is the worst error; no free authoritative list exists (CLSI GP47 is paid, NABL publishes none) |
| 2026-11-09 | Normalisation is deterministic: values (`1,25,000`, `<0.5`, `1.2 x 10^3`, qualitative words), one spelling per unit, test name by exact alias then trigram similarity (>= 0.6, margin 0.1 over the runner-up, unit compatibility, words of 5+ letters only); an unmappable test stays "other" and is never explained; the reply shows values as printed, canonical values are only for comparison, critical and trends | The model must not convert units or interpret; a wrong merge of two tests is worse than an unexplained one |
| 2026-11-09 | `borderline` = inside the range and within min(5% of the limit, 10% of the range width) of a limit | The literal "5% of the limit" made sodium 139 (range 135-145) borderline |
| 2026-11-09 | Lab verifier (`lab_verify.py`): every number must come from the data, every bullet must start with a test name of the report, every out-of-range / critical result is listed or counted ("+N more"), critical line first, disclaimer present, and a hi / en / Hinglish blocklist (whole words, our own fixed sentences removed first) finds no diagnosis, verdict, medicine, diet or dose wording; failure -> the same data without explanations, trends and questions. The seed texts are linted against the same blocklist in a test | The first run of the verifier caught a diet-related doctor question in our own seed data |
| 2026-11-09 | Trends: the gateway sends `context.previous_lab_results` (canonical code, value, unit, date; last 12 months; reports with status `done` only, so "Something wrong" and weakly read reports are left out); the reply shows at most 3 changes by relative size, no improved / worse wording, only "now within / outside the range" when the effective range makes it unambiguous | Judging a direction is the doctor's job; the gateway owns history |
| 2026-11-09 | Age and sex printed on a report are used for that report's comparison and stay in `documents.extraction` only; nothing is written to `users` | Data minimisation (DPDP) |
| 2026-11-09 | `lab_tests`: `unit` is the canonical unit, one row per (code, sex, age band) of fallback ranges, the YAML is the source of truth and `make seed` rewrites the table in one transaction; the Hindi explanation is a generic safe line with `hi_reviewed = false` until `data/review/lab_tests_hi_reviewed.csv` is filled; while unreviewed the Hindi reply shows no per-test explanation | Medical Hindi must be human-reviewed (same rule as M11) |
| 2026-11-09 | `lab_results` (gateway-owned, cascade from `users` and `documents`, no AI grant) holds one row per result without any name or id; `REPORTS` lists the last 5 reports (2 per page + More); `POST /v1/lab-render` renders a stored extraction for "See all tests" and REPORTS (no LLM); the contract's `extraction` is a union by `kind` | Trends and history need rows; rendering stays in the AI service with the same verifier |
| 2026-11-09 | CI also runs `evals/run_lab_eval.py` in `fake` and `fake-noisy` (36 synthetic reports): critical recall 100%, critical line first, zero diagnosis wording, zero values not on the page (checked against the GOLD page, not the model output), zero PHI leakage; the same gate runs in pytest on 12 reports | Safety metrics must not regress (§11); the fake modes prove the plumbing, not reading accuracy |
| 2026-11-09 | Voice notes (M13) reuse the SAME graph: `transcribe` -> emergency guard on the transcript -> redact -> classifier -> the existing branches; no separate voice pipeline | Every safety rule (emergency first, redaction, scope guard, verifier, grounding) applies to voice for free |
| 2026-11-09 | The emergency guard takes a voice transcript only through `transcript_user_texts(raw, roman)` and checks BOTH the original script and its Roman copy; a partial / empty / low-confidence transcript is guarded too, and the "please repeat" reply is sent only after both emergency stages found nothing. If the speech service is down the reply names 112/108 | The recall-first rule (§2.2) must hold for audio; a missed emergency costs far more than a needless "call 112" |
| 2026-11-09 | STT: `STTProvider` protocol, `WhisperProvider` (OpenAI), `SarvamProvider`, `FakeSTTProvider`; `STTRouter` = the M5 router rules (jitter retry, breaker, fallback only on timeout/429/5xx/connection, never on bad credentials or undecodable audio); a short-clip provider (Sarvam REST, `STT_SARVAM_MAX_S`) is skipped for long notes. Model ids, endpoints and prices are configuration; Sarvam gives no ASR confidence (`language_probability` is not one), Whisper confidence = exp(mean avg_logprob) x (1 - mean no_speech_prob) | Providers differ in what they report; never present a language-ID probability as speech confidence |
| 2026-11-09 | ffmpeg only through pipes (`pipe:0` -> `pipe:1`): voice -> 16 kHz mono raw PCM + WAV header written by us (exact duration for any container), spoken reply -> mono Ogg/Opus; `tempfile` is never used (asserted in a test); ffmpeg stderr is never logged; the AI image installs ffmpeg | Audio is PHI: no disk, no logs; a pipe cannot be seeked so the header sizes are written in Python |
| 2026-11-09 | Script policy: the transcript is kept as returned; a rule-based Devanagari->Roman copy (`app/safety/translit.py`) exists only for keyword matching (emergency rules, commands, intent/drug models); the user sees the ORIGINAL script, redacted, <= 120 chars, in a "you asked" line on replies to medical questions (not for emergencies, commands or chat). Devanagari digits become ASCII before redaction | Both scripts matter for matching; the user must be able to catch STT mistakes, especially drug names |
| 2026-11-09 | One shared command alias table (`packages/contracts/commands/aliases.json`, copies by `make safety-data`, stale-copy test in both apps) used for typed text and for voice. Voice matches the WHOLE utterance after dropping polite fillers; caregiver commands and bare yes/no words ("haan", "nahi") are never voice commands; `reminder_taken/snooze/skip` reuse the 2-hour open-slot rule | One place to maintain aliases; a sentence that contains a command word is not a command; a stray "haan" must not mark a dose as taken |
| 2026-11-09 | DELETE by voice is only DETECTED (`detected_command=delete`); the gateway runs the normal request step that sends the confirm BUTTON. Nothing is ever erased on a transcript alone | A mis-transcribed word must not be able to wipe a user's data |
| 2026-11-09 | A drug name heard by STT is answered only when the catalog matches it confidently (generic question: score >= `DRUG_MATCH_MIN`; interaction question: every name matches a product or is a known salt); otherwise "type the name or send a photo" | STT errors land on drug names first (§2.5); a confident answer about a misheard medicine is the worst voice failure |
| 2026-11-09 | Consent v2 (`CONSENT_VERSION='v2'`) names the speech service and says spoken replies are optional. Users with an older version get ONE notice with `[agree]` / `[I will type]` before their first voice note; nothing is downloaded or sent to a provider until they agree; the first note is not processed retroactively; audit action `consent_updated` | Health-related voice now reaches a third party (DPDP purpose limitation, §2.7); explicit consent, not a silent change |
| 2026-11-09 | Spoken replies (TTS) are opt-in twice: operator `TTS_ENABLED` (default false) and per user `users.voice_replies` (`VOICE ON/OFF`). The AI service decides what may be spoken (`app/tools/spoken.py`): interaction answers and lab-test answers in full (<= 600 chars), a short template summary for prescriptions and lab reports, NEVER emergencies, generic price lists, help, command replies or anything that failed the verifier; the text reply is always sent first and the audio is best effort; vendor audio is converted to Ogg/Opus, > 45 s refused; the gateway uploads the audio to WhatsApp and queues only the media id (new `audio` outbound kind), audio is never stored in S3 | Voice is an addition for low-literacy users, not a second source of medical text; Redis must not hold PHI |
| 2026-11-09 | Voice eval (`evals/run_voice_eval.py`): `fake` replays the prompt text, `fake-noisy` injects low confidence, typing-style damage and misheard drug names, `real` measures each configured provider (WER/CER per language, drug-name and command accuracy, latency, cost per minute, fallback rate) in one table; hard gates: emergency recall on voice 100%, no command inside a sentence, no DELETE side effect, no answer about a misheard medicine. CI runs both fake modes; synthetic TTS audio is easier than real elderly speech and the docs say so | Safety must not regress (§11); the plumbing is gated offline, accuracy is measured manually with keys and later on a small consented real-voice set |
| 2026-11-09 | `reply_templates_v7` (voice templates) and a new AI endpoint `POST /v1/synthesize` (service token only, not the demo token); new response fields `detected_command`, `transcript_redacted_short`, `spoken_text`; metrics `stt_latency_ms`, `stt_fallback_total`, `stt_low_confidence_total`, `tts_sent_total` | Contract-first (§10); template changes bump the version |
| 2026-11-09 | **One eval harness (M14)**: `evals/harness/` (registry, runner, metrics, gates, baseline, report, checks, tap, judge, cli) + `evals/suites/*` (emergency, matcher, interactions, rx, lab, voice, redteam, e2e_conversations, readability). The old `evals/run_*_eval.py` scripts were MOVED into suites (no wrappers); every suite runs the real `GraphPipeline` in-process; `make eval [SUITE= MODE= EVAL_MAX_USD=]` is the only entry point (CI, Makefile and docs use it) | One code path, one report format, one place for thresholds. Fake modes prove the plumbing and the deterministic safety layers, never model accuracy |
| 2026-11-09 | Thresholds live ONLY in `evals/thresholds.yaml`. Hard gates (eq/max/min, optional per-mode) fail the run always; a hard-gate metric a suite does not produce FAILS; soft thresholds fail only on regression vs `evals/baselines/<suite>.json` beyond a tolerance (abs or relative); baselines need `--reason` (min. a sentence), are refused when a hard gate fails, and are written by `make eval-baseline`. Lowering a hard gate needs a Decisions Log row. First baselines: reason "M14 harness consolidation" | Safety is exact; quality is compared, not absolute. Typos must not read as passes |
| 2026-11-09 | PHI leakage is now checked in extraction, reply, **logs** (root-logger tap with the service's JSON formatter) and **traces** (the real `LangfuseTracer` into a recording client) for rx, lab and redteam | The M14 gate says "extraction/logs/traces"; the tap shows exactly what would be uploaded after the service's own masking |
| 2026-11-09 | Prompt workflow: a prompt file is NEVER edited in place (a changed `files/*.md` fails `check-prompts`; the next `*_vN.md` is created and the `*_PROMPT_ID` constant moved); a changed prompt, model env default (`*_MODEL`), `pricing.yaml`, `thresholds.yaml`, `no_substitute.yaml`, `critical_values.yaml`, emergency keywords or reply templates needs a passing eval report for the affected suites under `evals/reports/` in the PR (`check-evidence`; real mode where a model is involved). The only override is a Decisions Log row containing `eval-waiver`. PR template added | "Prompt change = eval" must be enforced, not remembered |
| 2026-11-09 | Real-mode runs: refuse to start without a cost cap (`--max-usd` / `EVAL_MAX_USD`), abort when it is passed (aborted = failed), and only run on datasets whose `manifest.json` says `contains_real_phi: false`; sequential (concurrency 1), retries/backoff/fallback stay in the LLM router; `eval-real.yml` runs weekly + on demand, uploads the report, updates the "Weekly eval report" issue, never prints secrets | Cost and privacy are properties of the tooling, not of discipline |
| 2026-11-09 | Red-team suite (65 synthetic cases) with deterministic assertions only (expected intent / fixed template, forbidden phrases, no echo of the attacker's words via 4-word windows, no prompt text via 8-word windows, no dose numbers for overdose framing, canary medicine never echoed, emergency flag, extraction holds only medicines from the page). In fake mode image cases run an `honest` and an `obedient` model (one that FOLLOWS the injection) so the deterministic layers are what is measured; a real model's resistance is only measured with `MODE=real` | The honest limit is written into the report. Tests prove the gates can fail: switching off the injection guard or the emergency rules turns them red |
| 2026-11-09 | **Safety fixes found by the red team**: (1) overdose / self-harm framing ("kitni goliyan khane se neend nahi khulegi", "is lethal", "pills to die") added to `emergency-keywords.json` (self_harm / poisoning_overdose); (2) `app/safety/injection.py`: a medicine name, dose or instruction (rx) and a test name, unit, value, section or range text (lab) that is too long / too wordy or reads like an order to the assistant is DROPPED, so the line becomes "unreadable, confirm with your pharmacist" instead of printing the attacker's words; (3) reply templates v8: `coming_soon` and `out_of_scope` now end with "ask your doctor or pharmacist before changing a dose or stopping a medicine" (dose-change questions that the intent classifier sends there) | CLAUDE.md §2.1 / §2.2 / §2.5; found by evals, not by users. Strict on purpose: a false positive costs one "please confirm this line" |
| 2026-11-09 | E2E conversation tests (`evals/datasets/e2e/scenarios/*.yaml`, 14 scenarios): TypeScript runner in `apps/gateway/test/e2e-conversations/` drives the real NestJS app + BullMQ workers on the docker test stack and a real AI service process (`uvicorn`, `LLM_MODE=fake`, read-only DB role); only the WhatsApp Graph API is mocked; time travel calls `ReminderDispatchService.sendSlot/checkMissed` with explicit times; the Python suite `e2e_conversations` runs it and applies the same gates; `make e2e` = only this. The fake AI classifier recognises a lab report by a blue 32x32 corner marker (`image_kind_hint`) | Both document types must reach the AI service over HTTP; the fake model never reads pixels |
| 2026-11-09 | LLM-as-judge for readability / tone only (`judge_readability_v1`, TEXT_MODEL, soft metrics): run twice (repeat agreement), validated on 30 labelled examples (judge-human exact / within 1 / MAE). The labels were written by the developer / the assistant, NOT an independent panel. Fake mode uses a deterministic stub judge. The judge never gates safety or correctness | A model judge is noisy, steerable and shares blind spots; rules decide safety |
| 2026-11-09 | `MinimalPipeline`, `RxPipeline`, `PIPELINE=minimal`, `evals/run_pipeline_comparison.py` and their tests removed (planned in M9); parity tests became branch-coverage tests on the graph; `GraphPipeline` is the only pipeline | One path to maintain; the rollback window of M9 is over |
| 2026-11-09 | The eval-harness gateway side: `ai-context-isolation.int-spec.ts` proves the context sent to the AI service (active medicines, previous lab results) contains only the requesting user's rows | "Show me other users' medicines" can only ever return what the AI service was given |

| 2026-11-09 | **Smallest.ai added as a TTS provider (M13 follow-up)**: `SmallestTTS` (`POST https://api.smallest.ai/waves/v1/<model>/get_speech`, model `lightning-v3.1`, Hindi/English voices by id), `TTS_PRIMARY` accepts `smallest`, `TTS_FALLBACK` is now a comma separated chain (`sarvam,openai`); a provider without its settings is skipped. Endpoint checked by one live call (HTTP 200, WAV); the character limit is unknown (`SMALLEST_MAX_CHARS` 1000 is a guess), `pricing.yaml` has NO entry yet (cost counts as 0 with a warning). STT stays Whisper/Sarvam. Smallest.ai is a new third party for spoken replies: consent text (v2) names only the speech service generally, a lawyer/consent review is still needed; no eval run yet (`make eval-voice` has no Smallest TTS metric) | The user wants Smallest.ai first with the existing providers as fallback; it is off by default (`TTS_ENABLED=false`) |
| 2026-11-09 | **M15 telemetry**: OpenTelemetry in both apps, one trace per inbound message; trace context travels through BullMQ as `_tp` (W3C `traceparent`) in the job data and over HTTP as a header; `bootstrap.ts` is imported first in `main.ts` (auto-instrumentation patches modules at require time); OTel is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set | A queue is not HTTP, so the trace must be carried in the job; a trace per message is the unit people debug |
| 2026-11-09 | **PHI-safe spans by allowlist**: a `ScrubbingExporter` (last step before export, both apps) keeps an attribute only when its key is allowlisted or starts with `dawai.` and its value is a short primitive with no phone-/e-mail-like content; URLs, DB statements, events (exception messages) and status text are dropped. Metric label names are allowlisted too (a test fails on any other). Same rules and tests in TypeScript and Python | A blocklist forgets the next attribute; an allowlist fails closed (§2.6, §13) |
| 2026-11-09 | **Sampling**: record every trace, decide at the end in the app (`TailSamplingProcessor`): any trace with an error or `dawai.emergency` is kept, the rest by `OTEL_SAMPLE_RATIO` (default 0.2) as a pure function of the trace id, so both services agree without talking; the Collector's `tail_sampling` is the documented production alternative | Head sampling cannot know a trace will fail; emergencies must always be traceable |
| 2026-11-09 | **Metrics**: Prometheus on both apps (`prom-client`, `prometheus_client`), `/metrics` behind `METRICS_TOKEN` (required in production); the M9 in-process counters became a facade over the registry (same calls, tests unchanged); series that alerts watch for failures are pre-created at 0 | `increase()` shows 0 for a series whose first sample is non-zero, so the first failure would never alert (found live) |
| 2026-11-09 | **SLOs**: (1) 95% documents within 30 s and 99% text within 10 s, (2) 99.5% of inbound messages served (a dead-lettered job counts as not served), (3) 99% of reminders within 2 min; alerts are multi-window burn rates (1h and 5m >= 14.4 pages, 6h and 30m >= 6 tickets) written as plain PromQL (`infra/observability/alerts.yml`, checked by `promtool` in CI) so M17 can port them; every alert has a runbook and `runbook_url` that must point at an existing file | Latency, silence and lateness are what users feel; two windows make alerts both real and short-lived |
| 2026-11-09 | **Dead letters**: `WorkerFactory` creates every worker (trace continuation, wait/duration metrics, failure reasons, DLQ move on the last attempt, graceful close); an exhausted job in `inbound`, `outbound`, `reminders` or `user-deletion` is copied to `<queue>-dlq` with uuids, error code, attempts and trace id but NO payload (the original stays in its failed set and the operator CLI retries it from there); the inbound user is told once (same outbound job id `<messageId>_99` as the AI-failure message); a stuck erasure alerts at once; failed deletion jobs are kept 7 days | Nothing may be lost silently; Redis must not hold readable PHI (§2.6); erasure is a legal duty |
| 2026-11-09 | **Rate limits**: Redis sliding window by Lua script (atomic), idempotent per message id (a retried job does not use quota), one notice per window then silence; scopes msg/min, msg/day, docs/day, voice/day, caregiver invites/day; placed after the emergency pre-check and DELETE/HELP and before onboarding, so those never wait; `RL_BLOCK_AFTER_WINDOWS` limited windows in a local day set `users.blocked_until` (audited, one notice, CLI unblock); the limiter fails open | Emergencies and the right to erasure must never be limited (§2.2); a broken limiter must not take the product down |
| 2026-11-09 | **Webhook throttle** is `WEBHOOK_RATE_LIMIT_PER_MIN` (default 6000, was a fixed 300) | The k6 smoke test (20 msg/s) was answered 429 for 75% of requests; Meta calls from few IPs |
| 2026-11-09 | **Cost guard**: the gateway keeps the day's spend in Redis in micro-dollars (`INCRBY` from `meta.cost_usd`, Asia/Kolkata day) and sends `options.budget_state` with every request; states normal < 70% economy < 90% essential < 100% exhausted: economy = CHEAP model for text roles and no spoken reply, essential = only prescription extraction + emergency classifier + templates (lab, voice and text questions get a busy template), exhausted = templates + emergency RULES only; the emergency rules, templates and the gateway pre-check never read the state and every busy text names 112/108; plus `USER_DAILY_COST_USD`, `MAX_COST_PER_REQUEST_USD` (checked before a vision node, projected with `COST_ESTIMATE_VISION_USD`) and a 23:55 IST aggregate cost report; the guard fails open | A cost bug or one abusive user must have a ceiling; emergency handling never depends on budget (§2.2) |
| 2026-11-09 | Logs carry the same fields in both apps (`service`, `env`, `level`, `request_id`, `trace_id`, `span_id`, `user_id`, `event`); the e2e conversation run now captures the logs of both services and asserts no phone number, Aadhaar-like number (not inside an identifier), e-mail or typed / spoken text appears | §2.6 / §10 enforced by a test over real conversations, not by discipline |
| 2026-11-09 | Local stack (`observability` compose profile): OTel Collector (traces to Tempo, JSON log files to Loki, no Promtail), Prometheus, Alertmanager (clustering off) with a console alert sink, Grafana with dashboards generated from `build_dashboards.py` and provisioned from code; host ports configurable; templates `reply_templates_v9`; WhatsApp number-health events (`phone_number_quality_update`, `account_update`, `message_template_status_update`) are parsed to metrics and a warn log | M17 only has to point the same config at AWS |

| 2026-11-09 | **Web app (M16) is a BFF**: browser -> Next.js route handler (`/api/demo`, `/api/admin/[action]`) -> gateway (`/demo/*` with `X-Demo-Key`, `/admin/*` with a 5-minute JWT) -> AI service (`DEMO_SERVICE_TOKEN`). The browser holds no token and does not know the gateway URL. Server-only env names never carry `NEXT_PUBLIC_` (Vitest), client components never import server modules (Vitest), the built bundle is scanned for secret values (`scan-bundle`, in CI) | Public site: a leaked token would be a leaked back end (§12) |
| 2026-11-09 | **Demo safety**: samples are answered from a committed cache and never call a model (so they work with the budget spent); uploads need a tick-box, Turnstile (fail closed in production), an IP limit (keyed hash of the address, 1 day), the demo's own `budget:demo:<day>` counter (apart from users' spend), magic-byte sniffing and a `sharp` re-encode (EXIF stripped); the file lives under `demo/` and is deleted right after processing (24 h MinIO/S3 lifecycle as backstop), is never linked to a user and nothing is written to `documents`/`medications`/`messages`. The demo token is accepted by the AI service on `/v1/process` only | Cost and privacy are properties of the endpoint, not of visitors' good behaviour |
| 2026-11-09 | **Admin**: Auth.js v4 (GitHub OAuth, `ADMIN_EMAILS` allowlist, 30-minute JWT session); every gateway call carries a fresh HS256 JWT (`aud=dawai-admin`, 5 min, `node:crypto`, algorithm fixed) that the gateway verifies again (signature, expiry, not-before, audience, lifetime cap, allowlist); routes do not exist (404) when unconfigured; per-operator 120/min limit. Admin POST routes accept only same-origin JSON | Defence in depth; nothing to mis-configure in a JWT library |
| 2026-11-09 | **Admin PHI rules**: no phone number in any response (test); the review list has metadata and counts only; `Reveal` needs a 10+ character reason, writes `audit_logs` (`admin_reveal`: operator e-mail, document id, redacted reason) **before** anything is returned, and the 60 s picture link is fetched by the Next.js server and inlined as a `data:` URL. `AuditService.logAdmin` may carry the operator's e-mail (the operator is not a patient and the log must say who looked); all other audit metadata stays machine tokens only. A canonical uuid is accepted as an opaque id (the redactor mistook a uuid ending in 12 digits for an Aadhaar-like number) | Amends the M4 audit rule narrowly; found by the integration test |
| 2026-11-09 | Review verdicts live on `documents` (`review_label`, `reviewed_at`, `reviewed_by_hash`; migration `m16_review`); labels are for future eval datasets and may only be used after anonymisation (document the process in `docs/eval-process.md` before the first export). Eval reports and the prompt list are copied into `apps/gateway/admin-data` by `make admin-data` (the image cannot see `evals/`); "current prompt" = highest `_vN` of a family (files are never edited) | Gateway owns user-facing state (§4) |
| 2026-11-09 | **Privacy policy and terms are DRAFTS** written from what the system does (processors: Meta, Anthropic/OpenAI, Whisper/Sarvam, Smallest.ai/Sarvam/OpenAI TTS, AWS Mumbai; DPDP rights; `DELETE`). The page shows a draft banner and a last-updated date, `content/legal.ts` carries a DRAFT comment, a test checks both. **Launch blocker: legal review.** `PRIVACY_POLICY_URL` points to `/privacy` | We cannot give legal advice; we can make the draft accurate |
| 2026-11-09 | Landing: no analytics or third-party trackers (fonts via `next/font`, self-hosted at build). If analytics is ever added it must be privacy-friendly and consent-based and needs a Decisions Log row. Eval numbers on the landing come from the newest full `evals/reports/*.json` at build time and the page says they are fake-model runs | Marketing numbers must be real and honest |
| 2026-11-09 | Web stack pins: Next 15.5.29, React 19.1, Tailwind 4, next-intl 4, **next-auth 4.24 (not the v5 beta)**, Recharts 3, TypeScript ~6.0 (as the gateway), Vitest 5, Playwright 1.65; ESLint 9 for the web app only (`eslint-config-next` 15 does not support ESLint 10). `next build` does not use `output: 'standalone'` unless `NEXT_STANDALONE=1` | Stable releases; consistent with earlier pins |
| 2026-11-09 | CI: `web` (lint, typecheck, Vitest, build, `scan-bundle`, Lighthouse mobile with the four score gates) and `web-e2e` (Playwright + axe on the real stack with fake providers); `make e2e-web`, `make lighthouse`, `make scan-bundle`, `make demo-cache`, `make demo-samples`, `make admin-data` | Same gate-everything approach as M14/M15 |
| 2026-11-10 | Deploy on single EC2 + managed RDS instead of ECS Fargate (supersedes the §3 ECS/ElastiCache plan) | Lower cost and simpler ops for current scale; containers + Terraform keep the path to ECS/EKS open |
| 2026-11-10 | Production migrations must be backward compatible (expand → migrate → contract) | Deploy rollback re-runs the previous app image against the already-migrated database |
| 2026-11-10 | **M17 runs in "demo mode"** (target <= $10/month on a personal account): Postgres in a container (no RDS), no Elastic IP (the instance writes its IP into Route 53 at every boot), instance started on demand (`make start`), auto-stop after `MAX_UPTIME_MIN` (180), Budget Action stops it at $8, `make start` refuses when the month's spend reached the cap | RDS, an EIP and an always-on instance each exceed the budget alone; trade-off: the WhatsApp bot is off while stopped, no PITR. Upgrade path in `docs/runbooks/rds-upgrade.md` |
| 2026-11-10 | Secrets and config in **SSM Parameter Store** (`/dawai/prod/secrets/*` SecureString, `/dawai/prod/config/*` String) instead of Secrets Manager; Terraform never writes secret values (state stays free of them) | Secrets Manager costs $0.40/secret/month, SSM standard is free; same IAM-role access, no keys |
| 2026-11-10 | Only the subdomain `dawai.rasuonline.in` is delegated to Route 53 (4 NS records at GoDaddy); the apex domain and its existing site/e-mail are untouched | The domain already hosts something else |
| 2026-11-10 | Deploy = release bundle (compose, Caddyfile, scripts) uploaded to S3 `deploy/<sha>/` + images in ECR with immutable SHA tags + `DESIRED_SHA` in SSM; SSM Run Command runs `run-release.sh`; a stopped instance deploys `DESIRED_SHA` at its next boot; failed SHA is recorded in `FAILED_SHA` | No SSH, no file copy tooling, rollback uses the exact old bundle; works with an instance that is off most of the time |
| 2026-11-10 | Terraform state locking via the S3 lock file (`use_lockfile`, Terraform >= 1.10), no DynamoDB table; ECR keeps 5 images (not 20); containers log through the Docker `awslogs` driver (no CloudWatch agent, no memory/disk metrics); OTel collector only under compose profile `obs` | Fewer resources and less cost; the M15 Prometheus alerts are NOT deployed on this instance (known gap) |
| 2026-11-10 | `docker build` of `ai-service.Dockerfile` must pass `--target runtime` (a `seed` stage follows it); the gateway Dockerfile gained a slim `migrate` target and bakes `admin-data` into the image | The Prisma CLI is a devDependency; the image cannot see `evals/` at run time |

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
