# Dawai Saathi — developer entry point.
# Requires: Node 20+, pnpm 9, Python 3.12, uv, (Docker for docker-build).
# On Windows run from Git Bash (recipes are POSIX sh).

SHELL := sh
.DEFAULT_GOAL := help

AI_DIR := apps/ai-service

.PHONY: help install dev lint format typecheck test build docker-build clean \
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

# ---- placeholders: implemented in later modules (see CLAUDE.md §14) ----
up: ## [M1] Start local infra (postgres, redis, minio)
	@echo "make up: not implemented yet - arrives in M1 (local infra / docker-compose)."
down: ## [M1] Stop local infra
	@echo "make down: not implemented yet - arrives in M1 (local infra / docker-compose)."
migrate: ## [M1] Apply Prisma migrations
	@echo "make migrate: not implemented yet - arrives in M1 (Prisma schema + first migration)."
seed: ## [M8] Load catalog datasets
	@echo "make seed: not implemented yet - arrives in M8 (medicine catalog), extended in M11/M12."
eval: ## [M14] Run the evaluation suite
	@echo "make eval: not implemented yet - arrives in M14 (eval harness & CI gates)."
