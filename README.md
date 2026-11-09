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

Evaluations: `make eval` (see [Quality and evals](#quality-and-evals-m14)).

### Test the webhook locally

**Without Meta (recommended first).** `make webhook` sends a sample payload, signed with your `WA_APP_SECRET` exactly like Meta signs it. Start `make up`, `make migrate`, `make dev` first.

```bash
make webhook FIXTURE=text                 # -> HTTP 200 {"status":"received"}; a row in `messages`, a job logged by the worker
make webhook FIXTURE=text                 # again: same message id -> no new row, no new job
make webhook FIXTURE=text FRESH=1         # new sender + new message ids every time
make webhook FIXTURE=text BAD_SIGNATURE=1 # -> HTTP 401
make webhook FIXTURE=batch WEBHOOK_URL=http://localhost:3010/webhook/whatsapp   # if :3000 is taken
```

Fixtures (`apps/gateway/test/fixtures/whatsapp/`, fake numbers only): `text`, `image`, `document`, `audio`, `button`, `button-legacy`, `unsupported`, `location`, `status`, `batch`, `foreign`, and for the conversation flow `help`, `delete`, `emergency`, `lang-hi`, `lang-en`, `consent-yes`, `consent-no`, `delete-confirm`, `delete-cancel`.

To act as ONE user through onboarding, consent, commands and DELETE without Meta, keep the sender and change only the message ids:
```bash
export PHONE=919888800001 NEW_IDS=1
make webhook FIXTURE=text            # first message -> language buttons
make webhook FIXTURE=lang-en         # tap "English"  -> consent message
make webhook FIXTURE=consent-yes     # tap "I agree"  -> welcome
make webhook FIXTURE=help
make webhook FIXTURE=delete          # -> "Delete everything?" buttons
make webhook FIXTURE=delete-confirm  # -> user erased, final message
```
(Replies are sent to the Graph API, so with a fake `WA_ACCESS_TOKEN` you will see the sends fail in the gateway log; use a real Meta test number, or point `WA_API_BASE_URL` at a mock.)

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

## AI service (M5)

The gateway sends every ordinary message of a consented user to the AI service (`POST /v1/process`, header `X-Service-Token`) and forwards the reply. Text is classified and answered with a fixed template (M5, M6); photos and PDFs of prescriptions are read since M7 (next section).

**Fake mode (default, no API keys, used by tests and CI):** `LLM_MODE=fake`. Start with `make dev`; send "help" from WhatsApp (or call the endpoint with curl). `LLM_MODE=fake` is refused when `NODE_ENV=production`.

**Real mode:** set `LLM_MODE=real`, `LLM_PRIMARY` / `LLM_FALLBACK` (`anthropic` | `openai`), the matching `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, and the model ids for both providers: `VISION_MODEL`, `TEXT_MODEL`, `CHEAP_MODEL` and `FALLBACK_VISION_MODEL`, `FALLBACK_TEXT_MODEL`, `FALLBACK_CHEAP_MODEL`. Model ids are never hard-coded. Fill in the real prices in `apps/ai-service/app/llm/pricing.yaml` (the shipped values are placeholders). Optional tracing: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`. `/health/ready` reports `llm_config` and returns 503 when the configuration is invalid.

**Contract:** the OpenAPI file `packages/contracts/openapi/ai-service.json` and the gateway types in `apps/gateway/src/ai-client/generated/` are generated from the Pydantic schemas. After changing a schema run `make contracts` and commit the result; CI fails on any drift.

## Safety layer (M6)

Three guards run before any medical work (CLAUDE.md §2):

1. **Emergency guard.** The gateway keeps a keyword pre-check (works even when the AI service is down). The AI service adds the same rules with fuzzy matching, plus a cheap-model classifier for messages the rules miss. A match answers at once with 112 / 108 (self-harm adds Tele-MANAS 14416), makes no further model call, and the gateway sends it at top queue priority and writes an `emergency_detected` audit row (category only). If the classifier is down the rules still decide.
2. **PHI redaction.** Presidio + spaCy (`en_core_web_sm`) with Indian recognisers (mobile, Aadhaar-like, PAN, ABHA, PIN, hospital ids, names after Mr / Dr / "mera naam"). Applied to the text sent to models, to log fields named `text|body|prompt|output` and to Langfuse. Doses, schedules and lab values are never redacted. `REDACTION_ENABLED=false` is refused in production.
3. **Scope guard.** Only medicines, prescriptions and lab reports. Everything else (cricket, coding, diet advice ...) gets a fixed polite reply; the model never writes it.

The emergency phrases live in ONE file, `packages/contracts/safety/emergency-keywords.json`. After editing it run `make safety-data` (or `make contracts`); a test in each app fails if its copy is stale. `make eval SUITE=emergency` runs the emergency eval set (`evals/datasets/emergency/`), writes a report to `evals/reports/` and fails when recall drops below 100%; `make eval SUITE=emergency MODE=real EVAL_MAX_USD=1` does the manual run with your real model keys.

## LangGraph pipeline (M9)

The AI service runs a LangGraph state machine (`apps/ai-service/app/graph/`). `make graph` regenerates the diagram below (`docs/architecture/graph.mmd`; `GRAPH_PNG=1` also renders a PNG through mermaid.ink, which receives node names only). Per-node limits: `NODE_TIMEOUT_*_S`, `GRAPH_RECURSION_LIMIT`. `DEMO_SERVICE_TOKEN` (optional, at least 16 characters, different from `SERVICE_TOKEN`) lets the web demo send `options.include_trace` to `/v1/process` and receive a `debug_trace`; no other caller gets it. Regression check against the minimal pipeline: `uv run --project apps/ai-service python evals/run_pipeline_comparison.py`.

```mermaid
---
config:
  flowchart:
    curve: linear
---
graph TD;
	__start__([<p>__start__</p>]):::first
	emergency_guard(emergency_guard)
	redact(redact)
	emergency_classifier(emergency_classifier)
	transcribe(transcribe)
	prepare_image(prepare_image)
	classify(classify)
	vision_extract_rx(vision_extract_rx)
	validate_rx(validate_rx)
	normalize_drugs(normalize_drugs)
	generic_finder(generic_finder)
	confidence_gate(confidence_gate)
	extract_query(extract_query)
	extract_interaction_query(extract_interaction_query)
	match_query_medicines(match_query_medicines)
	interaction_check(interaction_check)
	composer(composer)
	verifier(verifier)
	templates(templates)
	rx_fallback(rx_fallback)
	vision_extract_lab(vision_extract_lab)
	lab_normalize(lab_normalize)
	lab_compare(lab_compare)
	lab_gate(lab_gate)
	lab_question(lab_question)
	__end__([<p>__end__</p>]):::last
	__start__ -.-> emergency_guard;
	__start__ -.-> prepare_image;
	__start__ -.-> transcribe;
	classify -.-> extract_interaction_query;
	classify -.-> extract_query;
	classify -.-> lab_question;
	classify -.-> templates;
	classify -.-> vision_extract_lab;
	classify -.-> vision_extract_rx;
	composer --> verifier;
	confidence_gate -.-> composer;
	confidence_gate -.-> templates;
	emergency_classifier -.-> classify;
	emergency_classifier -.-> templates;
	emergency_guard -.-> redact;
	emergency_guard -.-> templates;
	extract_interaction_query -.-> match_query_medicines;
	extract_interaction_query -.-> templates;
	extract_query -.-> normalize_drugs;
	extract_query -.-> templates;
	generic_finder -.-> composer;
	generic_finder -.-> interaction_check;
	generic_finder -.-> templates;
	interaction_check -.-> composer;
	interaction_check -.-> confidence_gate;
	interaction_check -.-> templates;
	lab_compare -.-> lab_gate;
	lab_compare -.-> templates;
	lab_gate -.-> composer;
	lab_gate -.-> templates;
	lab_normalize -.-> lab_compare;
	lab_normalize -.-> templates;
	lab_question -.-> composer;
	lab_question -.-> templates;
	match_query_medicines -.-> interaction_check;
	match_query_medicines -.-> templates;
	normalize_drugs -.-> generic_finder;
	normalize_drugs -.-> templates;
	prepare_image -.-> classify;
	prepare_image -.-> templates;
	redact --> emergency_classifier;
	transcribe -.-> emergency_guard;
	transcribe -.-> templates;
	validate_rx --> normalize_drugs;
	verifier -.-> __end__;
	verifier -.-> rx_fallback;
	vision_extract_lab -.-> lab_normalize;
	vision_extract_lab -.-> templates;
	vision_extract_rx -.-> templates;
	vision_extract_rx -.-> validate_rx;
	rx_fallback --> __end__;
	templates --> __end__;
	vision_extract_lab -.-> vision_extract_lab;
	vision_extract_rx -.-> vision_extract_rx;
	classDef default fill:#f2f0ff,line-height:1.2
	classDef first fill-opacity:0
	classDef last fill:#bfb6fc
```

## Prescriptions (M7): try it

Send a photo (or PDF) of a prescription to the bot after you have finished onboarding. The reply lists every medicine with dose, timing, food relation and duration, flags anything it could not read clearly (and asks you to confirm it with your pharmacist), and shows three buttons: **Set reminders** ("coming soon": M10) and **Generic medicines** (M8) and **Something is wrong** (marks the document for review and switches its medicines off). `MEDS` lists the saved medicines.

```
photo / PDF ─► pre-process (EXIF stripped, resized, blur/dark check) ─► classify (prescription? lab report? strip?)
            ─► vision extract (strict JSON, per-field confidence) ─► validate (written codes beat the model) ─► confidence gate
            ─► compose (LLM phrases ONE line per readable medicine) ─► grounding check (else template) ─► reply + save
```

- **Locally without API keys:** `make dev` (fake LLM). Any photo returns a fixed sample prescription (two clear medicines and one unreadable line), enough to see the reply, the buttons and the saved rows. The fake never looks at pixels.
- **With a real model:** set `LLM_MODE=real` and the model ids (see "AI service"). `VISION_MODEL` reads the prescription, `TEXT_MODEL` phrases the lines, and **`CHEAP_MODEL` must accept images** (it classifies the photo). `EXTRACTION_MIN_CONFIDENCE` (default 0.75) is the "say so, do not guess" threshold; `VISION_MAX_PX` and `IMAGE_MIN_SHARPNESS` tune the image check.
- **Containerised AI service:** presigned S3 URLs are bound to the hostname they were signed for. If the AI service reaches S3 under another name than the gateway (for example `http://minio:9000`), set `S3_AI_ENDPOINT` for the gateway and add that host to `ALLOWED_MEDIA_HOSTS` of the AI service.
- **Reminder clock times:** a written "morning / afternoon / evening / night" is saved as `MED_TIME_MORNING` (08:00), `MED_TIME_AFTERNOON` (14:00), `MED_TIME_EVENING` (18:00), `MED_TIME_NIGHT` (21:00), Asia/Kolkata.
- **Prescription eval:** `make eval SUITE=rx` generates 24 synthetic prescription images (`evals/datasets/prescriptions/`, see its README), replays them through the pipeline with a fake model and writes a report to `evals/reports/`. The fake modes check the safety rules around the model (flag recall, no PHI leakage, no invented medicine, grounded replies), not model accuracy. `make eval SUITE=rx MODE=fake-noisy` injects model mistakes; **`make eval SUITE=rx MODE=real EVAL_MAX_USD=2`** runs your real provider on the images (needs keys, costs money) and is the only mode that measures reading quality.
- Migration `20261108100000_rx_persistence` (run `make migrate`) makes `medications.frequency_per_day` nullable (as-needed medicines), adds `medications.as_needed` and a unique `documents.message_id`.

## Medicine catalog and generic finder (M8)

For every medicine read from a prescription the AI service looks it up in the catalog (`drugs`), and
suggests a cheaper generic only when the salt, strength, form AND release type (plain / SR / ER ...)
are exactly the same. Details and the open gaps: [`data/SOURCES.md`](./data/SOURCES.md).

**Seed the catalog (once, and again whenever the price list changes):**

```bash
make migrate                      # applies the M8 migration (new drugs columns, salt_aliases, match fields)
make seed                         # 73 curated brands (no prices) + Jan Aushadhi if data/raw/pmbjp/*.csv exists
make seed FIXTURE=1               # ... plus FICTIONAL generics and prices, for a local demo only
make seed PMBJP_DATE=2026-01-31   # needed when Jan Aushadhi CSV files are present (the list's own date)
make seed BRANDS_CSV=data/raw/brands.csv   # a brand list you supply (local only, never committed)
make embed                        # vector fallback: uploads to Pinecone if VECTOR_BACKEND=pinecone, else a check
```

`make seed` is idempotent and writes an ingestion report to `data/reports/` (rows read / accepted /
rejected by reason). The Jan Aushadhi list must be exported to CSV with the columns `Drug Code,
Generic Name, Unit Size, MRP` first; strength and form are parsed from the name, and a row that cannot
be parsed safely is rejected, never guessed. `FIXTURE=1` is refused when `NODE_ENV=production`.

**Try it:** with the fixture seeded, send a prescription photo (the fake LLM returns Dolo 650, Pantop 40
and one unreadable line): the reply shows "A cheaper option with the same salt is available" under
Dolo 650, and the **Generic medicines** button sends the details (name, "Jan Aushadhi" tag, approximate
price and saving, price date, and "Same salt, same strength. Please ask your doctor or pharmacist before
switching"). Typing `Dolo 650 ka generic batao` does the same for one medicine.

**What is never suggested:** narrow-therapeutic-index drugs (levothyroxine, warfarin, phenytoin ...),
insulins and biologics, every modified-release product, inhalers and forms we could not classify, a
medicine whose written strength or form contradicts the catalog product, and anything unreadable. The
list lives in `apps/ai-service/app/safety/no_substitute.yaml` and **must be reviewed by a pharmacist
before launch**. A saving is only stated when both the brand price and the alternative price are known.

**Evals (offline, no keys):** `make eval SUITE=matcher` runs 279 synthetic cases and fails on any wrong-strength,
wrong-form/release, wrong-salt or forbidden suggestion (all four must be 0); `make eval SUITE=rx` now also checks
suggestions end to end on the synthetic prescriptions. Both run in CI.

Settings: `DRUG_TRGM_MIN`, `DRUG_MATCH_MIN`, `DRUG_VECTOR_MIN`, `MIN_SAVINGS_PCT`, `VECTOR_BACKEND`,
`PINECONE_INDEX_HOST`, `EMBEDDING_*` (see `.env.example`). The Pinecone and embedding-API code is tested
against mocked HTTP only.

## Interaction checks (M11)

When you send a prescription, the AI service checks the new medicines against each other AND against
every medicine you already have stored from **earlier prescriptions and other doctors**, and warns about:

* **the same ingredient twice** (two brands of paracetamol from two doctors): a real overdose risk. It
  never gives a dose; it says "both contain paracetamol, ask your doctor or pharmacist";
* **known interactions** from the `interactions` table, worded by severity (major: "talk to your doctor
  today", moderate: "some caution is needed", minor: only in the details view).

The bot never says "stop this medicine". It says what is known and sends you to a doctor or pharmacist.
**No row, no claim:** a language model never states an interaction. "Nothing found" is worded as "not in
my list, which does not mean there is none", and a medicine that could not be looked up is named, never
called safe. Source, licence reasoning and the partial coverage: [`data/SOURCES.md`](./data/SOURCES.md).

```bash
make migrate                # m11_interactions: new interactions columns + medication_warnings
make seed                   # also loads data/seed/interactions_core.csv (idempotent)
make eval SUITE=interactions   # 135 offline cases; every safety gate must be 0
```

**On WhatsApp**

| What | Result |
|---|---|
| Send a prescription | Reply with the usual 3 buttons + the interaction notes; if there are any, a short follow-up message with the **Interaction details** button (`ix:details:<document id>`) |
| `Dolo aur Combiflam saath le sakte hain?` | A typed question: names are matched in the catalog, then checked; nothing is saved |
| `CHECK` / `jaanch karo` | Re-checks all your active medicines and keeps the stored warnings up to date |
| `MEDS` | A warning sign marks medicines that are part of an active warning |
| **Something is wrong** on a prescription | Its medicines are switched off and their warnings are resolved |

**Try it:** send two prescriptions that both contain paracetamol (with the fake LLM the second reply shows
the duplicate-ingredient warning), then type `Dolo aur Combiflam saath le sakte hain?` and `CHECK`.
Hindi wording is unreviewed: see `data/review/` (CSV files for a pharmacist to approve; put approved
lines in `data/review/interactions_hi_reviewed.csv`, columns `salt_a,salt_b,management_hi`).

Endpoints (internal, service token): `POST /v1/interaction-check` (CHECK) and `POST /v1/interaction-details`
(the details button). Neither calls a model.

## Lab reports (M12)

Send a photo or PDF (up to `LAB_MAX_PAGES` = 6 pages) of a lab report. The bot reads the tests, compares each value
with the range **printed on your report** (fallback: the flag the lab printed, then a general range for your
age / sex, and says so), and explains in plain Hindi / English what is inside or outside the range and what the
test measures. It never diagnoses. A critical value always puts `🚨 ... contact your doctor today` on the first line.

```
photo/PDF -> classify -> vision_extract_lab -> lab_normalize -> lab_compare -> lab_gate -> composer -> verifier
text      -> classify -> lab_question ("TSH 6.2 matlab kya?") -> composer -> verifier
```

* Everything after the vision call is deterministic (units, `lakhs/cumm`, `mmol/L`, ranges, critical values, trends).
  The reply is rendered from the structured data (no model words); the verifier blocks any number that is not in the
  data and any diagnosis / treatment wording (`app/tools/lab_verify.py`).
* Buttons: `[See all tests]` (grouped by section) and `[Something wrong]` (the report leaves the trends).
  Commands: `REPORTS` / `reports dikhao` (last 5 reports; tap one to see its summary again).
* Trends: the gateway sends the canonical code / value / unit / date of earlier results (12 months, never a name).
  The reply states the change without judgement ("HbA1c: 7.8 % (Mar 2026) -> 7.2 % (Nov 2026)").
* Age and sex printed on a report stay on that document only; they are never copied to the user profile.

Setup: `make migrate` (migration `m12_lab_reports`), then `make seed` (loads `data/seed/lab_tests.yaml`; check it with
`uv run --project apps/ai-service python data/scripts/seed_lab_tests.py --check`).
Evals: `make eval SUITE=lab` (fake replay, offline, CI gate); with keys `make eval SUITE=lab MODE=real EVAL_MAX_USD=2`. Hard gates: critical-value
recall 100%, critical line first, zero diagnosis wording, zero values that are not on the page, zero PHI leakage.
Reference data is **not clinically reviewed**: see `data/SOURCES.md` before any launch.

Manual WhatsApp test: send two synthetic lab reports (`evals/datasets/lab_reports/images/`; the second one with a
repeated test shows a "Since your last report" line), then `reports`, tap `See all tests`, and send `TSH 6.2 matlab kya?`.

## Voice notes (M13)

A voice note (Hindi, English or Hinglish) is turned into text by a speech service and then goes through the **same
graph as typed text**: emergency guard first (on the transcript in both scripts, also when it is low-confidence), then
redaction, intent and the usual branches. Replies are text; with `VOICE ON` short answers are also read aloud.

| Piece | Where |
|---|---|
| Speech-to-text providers | `STT_PRIMARY` / `STT_FALLBACK` = `whisper` (OpenAI) or `sarvam`; models in `STT_MODEL_WHISPER`, `STT_MODEL_SARVAM` (never hard-coded); keys `OPENAI_API_KEY`, `SARVAM_API_KEY`; prices in `apps/ai-service/app/llm/pricing.yaml` (placeholders) |
| Limits | `MAX_AUDIO_SECONDS` (120, longer notes are not transcribed), `MAX_MEDIA_MB`, `STT_MIN_CONFIDENCE`, `STT_SARVAM_MAX_S` (Sarvam REST is for short clips; longer notes use the other provider) |
| ffmpeg | converts formats a provider does not take (and the spoken reply to Ogg/Opus) through pipes, never a temp file; installed in the AI service image. Locally install ffmpeg or set `FFMPEG_PATH` for real mode |
| Spoken replies | `TTS_ENABLED=true` (gateway and AI service) + `TTS_PRIMARY` (`smallest` / `sarvam` / `openai`) + `TTS_FALLBACK` (comma separated, tried in order, e.g. `sarvam,openai`) + `TTS_MODEL_*` (Smallest.ai also needs `SMALLEST_API_KEY`, `TTS_VOICE_SMALLEST_HI/EN`; a provider without its settings is skipped); each user turns it on with `VOICE ON` and off with `VOICE OFF` (or "awaaz me jawab do"). The text reply always comes too; never spoken: emergencies, generic price lists, help |
| Commands by voice | "meds dikhao", "reminder band karo", "le li" (only while a reminder is open), "voice off" ... The alias table is shared with typed commands (`packages/contracts/commands/aliases.json`). **DELETE by voice only shows the confirm button** |
| Consent | `consent v2` names the speech service. Users who agreed to v1 get a one-time notice with two buttons before their first voice note; nothing is sent to a speech service until they agree |

Fake mode (`LLM_MODE=fake`) uses a fake speech provider: no keys, no ffmpeg, no audio needed.

Evals: `make eval SUITE=voice` (fake replay of 100 synthetic prompts, CI gate; hard gate: emergency recall on voice 100%).
Real providers: build the audio (`uv run --project apps/ai-service python evals/scripts/make_synthetic_voice.py`,
needs a TTS provider and ffmpeg), then `make eval SUITE=voice MODE=real EVAL_MAX_USD=2` writes the Whisper vs Sarvam table to
`evals/reports/`. Synthetic TTS speech is easier than real elderly speakers: see `docs/modules/M13.md`.

Manual WhatsApp test: send the voice notes "Dolo 650 ka generic batao" (reply starts with `🎧 Aapne poocha: ...`),
"meds dikhao", "le li" right after a reminder, and an emergency phrase ("seene me bahut dard ho raha hai": instant
112/108 text); then `VOICE ON` and one more voice question (text first, then a short voice message).

## Conversation flow (M4)

Every first-time number goes through the same short path, and **nothing is processed before consent**:

```
first message ──► choose language (हिन्दी / English) ──► consent message ──► "I agree" ──► active
                                                              │ "Not now": nothing is read or saved
```
- **Before consent** only metadata is stored (no message text) and media is never downloaded; a photo just brings the consent reminder back.
- **Emergency words** (chest pain, "saans nahi", suicide, ...) are answered with 112 / 108 (and Tele-MANAS 14416 for self-harm) at any step, even before consent.
- **Commands** (whole-message match, any case): `HELP`, `LANGUAGE`, `MEDS`, `STOP REMINDERS` / `START REMINDERS`, `DELETE`. `HELP` and `DELETE` work at every step.
- **`DELETE`** asks "Delete everything?" (valid for 5 minutes). On "Yes" a background job removes the photos from storage, the user's queued jobs and **all database rows**, leaves one anonymous `user_deleted` audit record, and sends a final confirmation. The same number writing again starts fresh.
- Set `PRIVACY_POLICY_URL` for the link shown in the consent message (the real page arrives with M16).

## Reminders and caregiver (M10)

After a prescription is read, tap **Set reminders** under the reply:

```
[Set reminders] -> summary built from the saved medicines: Dolo 650 - 08:00, 21:00 (5 days)
                   [Yes, set them] [Change times] [Cancel]
[Change times]  -> "subah 7, raat 10" / "7am 10pm" / "07:00 22:00" (a fixed parser, no LLM) -> summary again
[Yes, set them] -> reminders at each time; ONE message per time even if 3 medicines are due
every reminder: [Le li] [Baad me] [Skip]   (text "le li", "baad me", "skip" works for 2 hours too)
```

- Medicines that are as-needed (SOS), not read clearly, or without a daily frequency get **no** reminder, and the summary says why.
- A prescription without a written duration is scheduled for `REMINDER_OPEN_ENDED_DAYS` (30) and the bot asks the day before it ends whether to continue.
- **Snooze** adds `SNOOZE_MINUTES` (30), at most twice per reminder, and never into quiet hours (22:30-06:30).
- No answer for `REMINDER_ACK_TIMEOUT_MIN` (60) = **missed**. `Skip` is *skipped*, not missed. A late "Le li" within 6 hours still counts.
- Inside the 24-hour WhatsApp window the reminder is an interactive message, outside it the approved `dose_reminder` template (texts in `docs/whatsapp-templates.md`).
- `REMINDERS` lists the reminders with Pause / Resume buttons. `STOP REMINDERS` / `START REMINDERS` pause / resume everything. **Something is wrong** on a prescription cancels its reminders.

**Caregiver (family contact):** `CAREGIVER +91XXXXXXXXXX` -> "what does this person call you?" (for example *Papa*) -> the caregiver gets an invite template and must reply **YES** within 48 hours. After `CAREGIVER_ALERT_AFTER_MISSES` (2) missed times in a row they get a short alert with the name and the time, **never a medicine name**. At most one alert per 6 hours and three per day. The caregiver can send `STOP ALERTS`, the user `CAREGIVER REMOVE`. Maximum 2 caregivers. `DELETE` removes everything.

Run the planner by hand: the `reminders` worker registers a repeatable job every 15 minutes; `WORKERS_ENABLED=true` is enough.

### Try it on a real number (dev helper)

Set `REMINDER_TEST_OFFSET_MIN=3` in `.env` (refused when `NODE_ENV=production`) and restart. Then **Set reminders** -> **Yes, set them** schedules the first reminder 3 minutes from now (the next ones 2 minutes apart) instead of 08:00 / 21:00:

1. Tap **Le li** on the first reminder, **Baad me** on the second (it comes back after `SNOOZE_MINUTES`).
2. Add a second number: `CAREGIVER +91...` -> label -> reply **YES** from that number.
3. Ignore two reminders in a row: after `REMINDER_ACK_TIMEOUT_MIN` minutes each is missed and the second miss sends the alert. For a faster test also set `REMINDER_ACK_TIMEOUT_MIN=5`.
4. Remove the variable again afterwards.

Tests: `make test` (unit, fake clock) and `make test-integration` (`reminders.int-spec.ts` walks a 5-day prescription through taken / snooze / skipped / missed / late / caregiver alert on a fake Asia/Kolkata clock; `reminders-flow.int-spec.ts` goes webhook -> router -> workers -> mocked Graph API).

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
| `make safety-data` | Copy the shared emergency keywords into both apps |
| `make seed` / `make embed` | Load the medicine catalog / embed it for the vector fallback (see M8 section) |
| `make seed` | Load catalog datasets |
| `make eval` | All eval suites in fake mode with gates → `evals/reports/<date>-<sha>.md`. `SUITE=rx`, `MODE=real EVAL_MAX_USD=2` |
| `make eval-baseline SUITE=rx REASON="…"` | Store the current metrics as the baseline (a reason is required) |
| `make eval-summary` / `make eval-list` / `make eval-checks` | README table / list suites / PR checks (prompt versions, eval evidence) |
| `make e2e` | Conversation scenarios through the real gateway + AI service (needs `make test-infra-up`) |

## Quality and evals (M14)

One harness runs every check that is not a unit test: **8 suites** (emergency, matcher, interactions, rx, lab,
voice, redteam, e2e_conversations) plus a soft readability judge. Each suite calls the real pipeline, produces
metrics, and is judged against `evals/thresholds.yaml`: **hard gates** (zero hallucinated medicines, 100% emergency
recall, zero wrong-strength generics, zero PHI leakage, all red-team assertions...) fail the run always, **soft
thresholds** fail only when a metric gets worse than its stored baseline (`evals/baselines/`) by more than a tolerance.

```bash
make eval                           # everything, fake models, with gates  -> evals/reports/<date>-<sha>.md + .json
make eval SUITE=redteam             # one suite
make eval SUITE=rx MODE=real EVAL_MAX_USD=2   # real provider, aborts when the cost cap is passed
make eval-baseline SUITE=rx REASON="why the numbers moved"   # then add a Decisions Log row
make e2e                            # only the conversation scenarios (needs make test-infra-up)
make eval-checks BASE=origin/main   # prompt versions + eval evidence for the current branch
```

How to change a prompt or a model safely: [docs/eval-process.md](docs/eval-process.md). **Fake modes prove the plumbing
and the safety layers, not how well a model reads or resists an attack**; real-mode numbers come from
`make eval ... MODE=real` and the weekly `eval-real.yml` workflow, and are not in the table below.

<!-- eval-summary:start -->
_Latest full offline run: 2026-11-09 at `f401ec7`. Fake modes check the plumbing and the safety layers, not model reading accuracy; real-mode numbers are not in this table._

| Suite | Mode | Cases | Hard gates | Result | Key metric |
|---|---|---|---|---|---|
| emergency | rules | 152 | 2/2 | PASS | recall_rules_tier 100.0% |
| emergency | fake | 152 | 2/2 | PASS | recall_rules_tier 100.0% |
| matcher | fake | 284 | 7/7 | PASS | correct_product_rate 97.6% |
| interactions | fake | 135 | 8/8 | PASS | pair_recall 100.0% |
| rx | fake | 24 | 8/8 | PASS | field_name_exact 100.0% |
| rx | fake-noisy | 24 | 8/8 | PASS | field_name_exact 100.0% |
| lab | fake | 36 | 8/8 | PASS | critical_recall 100.0% |
| lab | fake-noisy | 36 | 8/8 | PASS | critical_recall 100.0% |
| voice | fake | 100 | 4/4 | PASS | emergency_recall_voice 100.0% |
| voice | fake-noisy | 100 | 4/4 | PASS | emergency_recall_voice 100.0% |
| redteam | fake | 65 | 11/11 | PASS | assertion_pass_rate 100.0% |
| readability | fake | 40 | 2/2 | PASS | readability_mean 5.00 |
| e2e_conversations | fake | 14 | 3/3 | PASS | scenario_pass_rate 100.0% |
<!-- eval-summary:end -->

## Observability, limits and cost guard (M15)

One WhatsApp message is **one trace**: webhook → queue → worker → AI service → every graph node → outbound send. Metrics are Prometheus, logs are JSON with the same `trace_id`. All of it is PHI-safe by construction (an attribute allowlist, low-cardinality labels, redacted logs).

```bash
make up-obs        # + Grafana :3003, Prometheus, Tempo (traces), Loki (logs), Alertmanager, OTel Collector, Langfuse :3002
# point the apps at it (apps/gateway and apps/ai-service read the same variables):
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318  OTEL_SAMPLE_RATIO=1  METRICS_TOKEN=local-dev-metrics-token
make check-obs     # alert rules + dashboards + runbooks are consistent with the metrics the apps really export
```

| What | Where |
|------|-------|
| Six dashboards (overview/SLOs, queues, AI and cost, WhatsApp, reminders, safety) | Grafana → folder **Dawai Saathi** (provisioned from `infra/observability/grafana/`) |
| One message, end to end | Grafana → Explore → **Tempo**, search `service.name=gateway`; the span attribute `dawai.langfuse_trace_id` jumps to Langfuse, and Langfuse's trace output carries `otel_trace_id` |
| Metrics | `GET /metrics` on both apps, `Authorization: Bearer $METRICS_TOKEN` (required in production, never public) |
| SLOs, burn-rate alerts | [`docs/slo.md`](docs/slo.md), [`infra/observability/alerts.yml`](infra/observability/alerts.yml) |
| What to do when an alert fires | [`docs/runbooks/`](docs/runbooks/README.md) (one per alert) |
| Alerts locally | `docker logs -f dawai-alert-sink` |

**Dead letters.** A job that runs out of attempts is moved to `<queue>-dlq` (`inbound`, `outbound`, `reminders`, `user-deletion`) without its payload. The user of an inbound job is told to try again exactly once. A stuck erasure alerts at once. Operator commands (each is written to `audit_logs`):

```bash
pnpm --filter @dawai/gateway cli dlq:list --queue inbound
pnpm --filter @dawai/gateway cli dlq:retry --queue user-deletion
pnpm --filter @dawai/gateway cli dlq:purge --queue outbound
pnpm --filter @dawai/gateway cli user:unblock --user <uuid>
```

**Rate limits** (per user, Redis sliding window): `RL_MSG_PER_MIN` 10, `RL_MSG_PER_DAY` 200, `RL_DOCS_PER_DAY` 20, `RL_VOICE_PER_DAY` 30, 3 caregiver invitations a day. One friendly notice, then silence. **Emergencies, `DELETE` and `HELP` bypass every limit and every block.** Repeated limited windows block a user for `RL_BLOCK_HOURS` (migration `m15_blocking`).

**Cost guard.** `LLM_DAILY_BUDGET_USD` (Asia/Kolkata day) → state `normal` < 70% < `economy` < 90% < `essential` < 100% = `exhausted`; `USER_DAILY_COST_USD` caps one person; `MAX_COST_PER_REQUEST_USD` stops one oversized request. Emergencies are answered in every state: the emergency rules and templates never read the budget. Details: [`docs/modules/M15.md`](docs/modules/M15.md).

**Load smoke test** (k6, fake providers, mock Graph API): `node infra/loadtest/mock-graph.js`, seed users (`apps/gateway/scripts/seed-loadtest-users.ts`), `make load-smoke`.

## Web app (M16): landing, live demo, admin

`apps/web` is a Next.js 15 app (App Router, Server Components by default, Tailwind, next-intl). It has three parts:

| Part | Where | What |
|------|-------|------|
| Landing | `/` (Hindi), `/en` | What Dawai Saathi does, the `wa.me` button and QR code, safety block, the real LangGraph graph, the latest eval numbers, FAQ |
| Privacy and terms | `/privacy`, `/terms` (+ `/en/...`) | Plain-language DPDP-style policy written from what the system really does. **A draft: it needs legal review before launch** (banner on the page). `PRIVACY_POLICY_URL` points here |
| Live demo | `/demo`, `/en/demo` | Pick one of 8 synthetic samples (or upload an anonymised image) and see the WhatsApp reply, the extraction with per-field confidence, generics, warnings and the LangGraph trace (nodes, latency, tokens, cost, prompt versions) |
| Admin | `/admin` | Operators only (GitHub OAuth + allowlist): KPIs and charts, review queue (patient data masked until "Reveal" with a reason, audited), eval reports, prompt versions, dead letters, budget |

**The browser never talks to the AI service and never holds a token.** Browser → Next.js route handler (`/api/demo`, `/api/admin/*`) → gateway (`/demo/*` with `X-Demo-Key`, `/admin/*` with a 5-minute signed JWT) → AI service (`DEMO_SERVICE_TOKEN`, the only caller that may ask for `debug_trace`).

```bash
cp apps/web/.env.example apps/web/.env.local     # then edit; server-only values must never start with NEXT_PUBLIC_
# gateway .env: DEMO_API_KEY, DEMO_SERVICE_TOKEN (also on the AI service), DEMO_DAILY_BUDGET_USD,
#               ADMIN_EMAILS, ADMIN_JWT_SECRET  (the same DEMO_API_KEY / ADMIN_* values go in apps/web/.env.local)
make up && make migrate     # new migration: m16_review (documents.review_label)
make dev                    # gateway :3000, ai-service :8000, web :3001
make demo-cache             # pre-compute the sample answers (needs the stack up; fake models unless you set real keys)
```

On this repo's machine port 3001 may be taken by another container; run `pnpm --filter @dawai/web exec next dev -p 3011`.

**Demo safety.** A visible notice and a tick-box before any upload; samples are served from a cache (no model call, always works, even when the budget is spent); uploads are limited per IP (`DEMO_RL_PER_HOUR` / `_PER_DAY`), checked by Cloudflare Turnstile (`TURNSTILE_SECRET_KEY`; without it uploads stay off in production), type-sniffed and re-encoded (EXIF stripped), stored under `demo/` (deleted right after processing, 24-hour lifecycle rule as backstop), never linked to a user and never written to `documents` or `medications`. The demo has its own budget (`DEMO_DAILY_BUDGET_USD`) that cannot eat into real users' budget.

**Admin safety.** No phone number is ever returned. The review list shows metadata and counts only. `Reveal` needs a reason (10+ characters), writes `audit_logs` (`admin_reveal`: operator e-mail, document id, reason) **before** anything is shown, and the picture link lives 60 seconds and never reaches the browser. The gateway re-checks the JWT's signature, expiry, audience and the `ADMIN_EMAILS` allowlist on every call.

| Command | What |
|---------|------|
| `make web-test` | Vitest: reply preview, confidence bars, trace timeline, hi/en key parity, secrets never in client code |
| `make e2e-web` | Playwright on the real stack with fake providers (landing hi/en, demo, admin reveal + audit row, axe) |
| `make scan-bundle` | Fails if a secret value is found in `.next/static` |
| `make lighthouse` | Lighthouse (mobile) on the landing page: performance ≥ 90, accessibility / best practices / SEO ≥ 95 |
| `make demo-samples` | Rebuild `apps/web/public/samples/` from the synthetic eval datasets |
| `make admin-data` | Copy eval reports and the prompt list for the admin pages |

Details and interview notes: [`docs/modules/M16.md`](docs/modules/M16.md).

## User commands (on WhatsApp)

`HELP` · `MEDS` · `CHECK` (or `jaanch karo`) · `REPORTS` (or `reports dikhao`) · `REMINDERS` · `STOP REMINDERS` / `START REMINDERS` · `CAREGIVER +91XXXXXXXXXX` / `CAREGIVER REMOVE` · `LANGUAGE` · `VOICE ON` / `VOICE OFF` · `DELETE` (the same commands also work as voice notes)

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
