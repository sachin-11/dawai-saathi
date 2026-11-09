# Dawai Saathi — developer entry point.
# Requires: Node 20+, pnpm 9, Python 3.12, uv, (Docker for docker-build).
# On Windows run from Git Bash (recipes are POSIX sh).

SHELL := sh
.DEFAULT_GOAL := help

AI_DIR := apps/ai-service
GATEWAY_DIR := apps/gateway

# Run a command with the repo-root .env exported (sh handles inline comments in .env).
# Real environment variables already set in your shell are overridden by .env, so unset them if needed.
WITH_ENV = set -a; [ -f .env ] && . ./.env; set +a;

.PHONY: help install dev lint format typecheck test build docker-build clean contracts safety-data eval eval-data eval-baseline eval-summary eval-list eval-checks test-evals e2e embed graph \
        up down migrate seed eval

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install Node (pnpm) and Python (uv) dependencies
	pnpm install --frozen-lockfile
	cd $(AI_DIR) && uv sync --frozen

dev: ## Run gateway (:3000) and ai-service (:8000) with hot reload
	pnpm dev

lint: ## ESLint + Prettier (TS), ruff lint + format check (Python)
	pnpm format:check
	pnpm lint

format: ## Auto-format TS (Prettier) and Python (ruff)
	pnpm format

typecheck: ## tsc --noEmit (gateway) and mypy --strict (ai-service)
	pnpm typecheck

test: ## Jest unit + e2e (gateway) and pytest (ai-service)
	pnpm test

build: ## Compile the gateway
	pnpm build

docker-build: ## Build production images for both apps
	docker build -f infra/docker/gateway.Dockerfile -t dawai/gateway:local .
	docker build -f infra/docker/ai-service.Dockerfile -t dawai/ai-service:local .

clean: ## Remove build artefacts, caches and installed deps
	rm -rf node_modules apps/*/node_modules packages/*/node_modules \
	       apps/gateway/dist apps/gateway/coverage apps/gateway/tsconfig.tsbuildinfo .turbo apps/*/.turbo \
	       $(AI_DIR)/.venv $(AI_DIR)/.mypy_cache $(AI_DIR)/.ruff_cache $(AI_DIR)/.pytest_cache
	find $(AI_DIR) -type d -name __pycache__ -prune -exec rm -rf {} +

# ---- local infrastructure (M1) ----
up: ## Start local infra (postgres, redis, minio) and wait until healthy
	docker compose up -d --wait postgres redis minio
	docker compose up --no-deps --exit-code-from minio-init minio-init
	@$(WITH_ENV) echo "infra is up: postgres :$${POSTGRES_PORT:-5432}, redis :$${REDIS_PORT:-6379}, minio console http://localhost:$${MINIO_CONSOLE_PORT:-9001}"

up-obs: up ## `up` plus Langfuse (:3002), Grafana (:3003), Prometheus (:9090), Tempo, Loki, Alertmanager, OTel Collector
	@mkdir -p logs
	docker compose --profile observability up -d langfuse-web langfuse-worker otel-collector tempo loki prometheus alertmanager alert-sink grafana
	@echo "langfuse UI: http://localhost:3002 (create a local account on first visit)"
	@echo "grafana:     http://localhost:3003 (folder Dawai Saathi); alerts: docker logs -f dawai-alert-sink"
	@echo "point the apps at it: OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 METRICS_TOKEN=local-dev-metrics-token"

up-obs-dashboards: ## Regenerate the Grafana dashboard JSON from infra/observability/grafana/build_dashboards.py
	python infra/observability/grafana/build_dashboards.py

check-obs: ## Static checks of alert rules and dashboards (metric names exist, runbooks exist)
	cd $(AI_DIR) && uv run python ../../infra/observability/check.py

load-smoke: ## k6 smoke: 20 msg/s for 2 min against the fake-provider stack (see docs/modules/M15.md)
	k6 run infra/loadtest/smoke.js

down: ## Stop local infra (volumes are kept)
	docker compose --profile observability down

logs: ## Tail infra logs
	docker compose --profile observability logs -f --tail=100

db-reset: ## DESTROY local DB/Redis/MinIO volumes, restart infra, re-run migrations (asks first)
	@printf "This deletes ALL local Dawai Saathi data (postgres, redis, minio volumes). Type 'yes' to continue: "; 	read answer; [ "$$answer" = "yes" ] || { echo "aborted"; exit 1; }
	docker compose --profile observability down -v
	$(MAKE) up
	$(MAKE) migrate

migrate: ## Apply Prisma migrations (prisma migrate deploy) to DATABASE_URL
	$(WITH_ENV) cd $(GATEWAY_DIR) && pnpm exec prisma migrate deploy

migrate-dev: ## Create/apply a new migration during development: make migrate-dev name=add_x
	@[ -n "$(name)" ] || { echo "usage: make migrate-dev name=<migration_name>"; exit 1; }
	$(WITH_ENV) cd $(GATEWAY_DIR) && pnpm exec prisma migrate dev --name $(name)

db-studio: ## Open Prisma Studio (http://localhost:5555)
	$(WITH_ENV) cd $(GATEWAY_DIR) && pnpm exec prisma studio

# ---- WhatsApp webhook dev tool (M2) ----
FIXTURE ?= text
webhook: ## Send a signed sample webhook to the local gateway: make webhook FIXTURE=text|image|document|audio|button|batch|status|... (BAD_SIGNATURE=1, FRESH=1, PHONE=<n> NEW_IDS=1, WEBHOOK_URL=...)
	$(WITH_ENV) cd $(GATEWAY_DIR) && pnpm exec ts-node scripts/send-test-webhook.ts $(FIXTURE)

# ---- contract between the gateway and the AI service (M5) ----
graph: ## Write the LangGraph diagram to docs/architecture/graph.mmd (GRAPH_PNG=1 also renders graph.png via mermaid.ink: sends node names only)
	cd $(AI_DIR) && uv run python -m scripts.export_graph $(if $(GRAPH_PNG),--png)

contracts: ## Re-export the AI service OpenAPI contract and regenerate the gateway's TypeScript types
	cd $(AI_DIR) && uv run python -m scripts.export_openapi ../../packages/contracts/openapi/ai-service.json
	pnpm --filter @dawai/gateway run contracts:types
	pnpm exec prettier --write packages/contracts/openapi apps/gateway/src/ai-client/generated
	$(MAKE) safety-data

# Emergency keywords (M6): the canonical file lives in packages/contracts/safety; each app ships a copy
# (so Docker images are self-contained). A test in each app fails when its copy is stale.
safety-data: ## Copy the canonical emergency keywords into the gateway and the AI service
	cp packages/contracts/safety/emergency-keywords.json apps/gateway/src/common/safety/data/emergency-keywords.json
	cp packages/contracts/safety/emergency-keywords.json $(AI_DIR)/app/safety/data/emergency-keywords.json
	cp packages/contracts/commands/aliases.json apps/gateway/src/common/safety/data/command-aliases.json
	cp packages/contracts/commands/aliases.json $(AI_DIR)/app/safety/data/command-aliases.json

# ---- integration tests (need Docker; use docker-compose.test.yml on separate ports) ----
test-infra-up: ## Start the throwaway test stack (postgres :5543, redis :6479, minio :9100)
	docker compose -f docker-compose.test.yml up -d --wait postgres redis minio
	docker compose -f docker-compose.test.yml up --no-deps --exit-code-from minio-init minio-init

test-infra-down: ## Stop and wipe the test stack
	docker compose -f docker-compose.test.yml down -v

test-integration: ## Run gateway + ai-service integration tests against the test stack (always cleans up)
	$(MAKE) test-infra-up
	@status=0; \
	pnpm --filter @dawai/gateway run test:integration || status=$$?; \
	pnpm --filter @dawai/ai-service run test:integration || status=$$?; \
	$(MAKE) test-infra-down; \
	exit $$status

# ---- placeholders: implemented in later modules (see CLAUDE.md §14) ----
seed: ## Load the medicine catalog (curated brands + Jan Aushadhi if data/raw/pmbjp/*.csv), the curated interaction list (M11) and the lab reference data (M12). FIXTURE=1 adds FICTIONAL prices, BRANDS_CSV=<file> a local brand list, PMBJP_DATE=YYYY-MM-DD is needed with Jan Aushadhi files
	$(WITH_ENV) uv run --project $(AI_DIR) python data/scripts/seed_catalog.py --load $(if $(FIXTURE),--fixture) $(if $(BRANDS_CSV),--brands-csv $(BRANDS_CSV)) $(if $(PMBJP_DATE),--pmbjp-date $(PMBJP_DATE))
	$(WITH_ENV) uv run --project $(AI_DIR) python data/scripts/seed_interactions.py
	$(WITH_ENV) uv run --project $(AI_DIR) python data/scripts/seed_lab_tests.py
embed: ## Embed the catalog for the vector fallback (Pinecone when VECTOR_BACKEND=pinecone, else a check only)
	$(WITH_ENV) uv run --project $(AI_DIR) python data/scripts/embed_catalog.py
# ---- evals (M14): ONE harness, many suites. See docs/eval-process.md ----
EVAL := uv run --project $(AI_DIR) python -m evals.harness.cli

eval-data: ## Build the synthetic eval images that are not committed (prescriptions, lab reports, red-team)
	@[ -d evals/datasets/prescriptions/images ] || uv run --project $(AI_DIR) python evals/scripts/make_synthetic_rx.py
	@[ -d evals/datasets/lab_reports/images ] || uv run --project $(AI_DIR) python evals/scripts/make_synthetic_lab.py
	@[ -d evals/datasets/redteam/images ] || uv run --project $(AI_DIR) python evals/scripts/make_synthetic_redteam.py
	@[ -d evals/datasets/e2e/images ] || uv run --project $(AI_DIR) python evals/scripts/make_synthetic_e2e.py
eval: eval-data ## All suites in fake mode with gates. One suite / real: `make eval SUITE=rx MODE=real EVAL_MAX_USD=2`
	$(WITH_ENV) $(EVAL) run $(if $(SUITE),--suite $(SUITE)) --mode $(or $(MODE),fake) $(if $(EVAL_MAX_USD),--max-usd $(EVAL_MAX_USD))
eval-baseline: eval-data ## Store the current metrics as the baseline: `make eval-baseline SUITE=rx REASON="why it moves"`
	$(WITH_ENV) $(EVAL) baseline --suite $(or $(SUITE),all) --mode $(or $(MODE),fake) --reason "$(REASON)"
eval-summary: ## Write the latest full fake-mode results into README.md (between the eval-summary markers)
	$(EVAL) summary
eval-list: ## List the eval suites, their modes and the estimated real-mode cost
	$(EVAL) list
eval-checks: ## PR checks: prompt versions bumped, eval evidence present, dataset manifests synthetic (BASE=origin/main)
	$(EVAL) check-datasets
	$(EVAL) check-prompts --base $(or $(BASE),origin/main)
	$(EVAL) check-evidence --base $(or $(BASE),origin/main)
test-evals: ## Unit tests of the eval harness itself
	cd $(AI_DIR) && uv run python -m pytest ../../evals/tests -q
e2e: ## [M14] End-to-end conversation scenarios (gateway + AI service, fake providers, needs `make test-infra-up`)
	pnpm --filter @dawai/gateway run test:e2e-conversations
