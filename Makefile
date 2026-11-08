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

.PHONY: help install dev lint format typecheck test build docker-build clean contracts safety-data eval-emergency eval-rx eval-matcher eval-interactions embed graph \
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

up-obs: up ## Same as `up` plus Langfuse (profile "observability", UI on :3002; first boot takes 1-2 min)
	docker compose --profile observability up -d langfuse-web langfuse-worker
	@echo "langfuse UI: http://localhost:3002 (create a local account on first visit)"

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
seed: ## Load the medicine catalog (curated brands + Jan Aushadhi if data/raw/pmbjp/*.csv) and the curated interaction list (M11). FIXTURE=1 adds FICTIONAL prices, BRANDS_CSV=<file> a local brand list, PMBJP_DATE=YYYY-MM-DD is needed with Jan Aushadhi files
	$(WITH_ENV) uv run --project $(AI_DIR) python data/scripts/seed_catalog.py --load $(if $(FIXTURE),--fixture) $(if $(BRANDS_CSV),--brands-csv $(BRANDS_CSV)) $(if $(PMBJP_DATE),--pmbjp-date $(PMBJP_DATE))
	$(WITH_ENV) uv run --project $(AI_DIR) python data/scripts/seed_interactions.py
embed: ## Embed the catalog for the vector fallback (Pinecone when VECTOR_BACKEND=pinecone, else a check only)
	$(WITH_ENV) uv run --project $(AI_DIR) python data/scripts/embed_catalog.py
eval-emergency: ## Emergency-detection eval (rules + fake classifier). Real model: add `MODE=real`
	uv run --project $(AI_DIR) python evals/run_emergency_eval.py --mode rules
	uv run --project $(AI_DIR) python evals/run_emergency_eval.py --mode $(or $(MODE),fake)
eval-matcher: ## Drug matching + generic finder eval: every safety gate must be zero
	uv run --project $(AI_DIR) python evals/run_matcher_eval.py
eval-interactions: ## Interaction checker eval (135 cases, offline): every safety gate must be zero
	uv run --project $(AI_DIR) python evals/run_interaction_eval.py
eval-rx: ## Prescription eval on synthetic images (fake replay). Real model: `make eval-rx MODE=real` (needs keys)
	@[ -d evals/datasets/prescriptions/images ] || uv run --project $(AI_DIR) python evals/scripts/make_synthetic_rx.py
	uv run --project $(AI_DIR) python evals/run_rx_eval.py --mode $(or $(MODE),fake)
eval: ## [M14] Run the evaluation suite
	@echo "make eval: not implemented yet - arrives in M14 (eval harness & CI gates)."
