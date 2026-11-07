# ADR 0001 — Monorepo with a NestJS gateway and a FastAPI AI service

- **Status:** Accepted
- **Date:** 2026-11-07
- **Module:** M0

## Context

Dawai Saathi has two very different workloads:

1. **User-facing, stateful, latency-sensitive I/O.** This covers the WhatsApp webhook (must ACK in under 1 s), users, consent, messages, medications, reminders, caregiver alerts and scheduled jobs. It needs reliable queues, idempotency and strong typing at the edges.
2. **AI processing.** This covers vision extraction, emergency guard, PII redaction, drug matching, generic finder, interaction check, lab comparison and response composition. The ecosystem we need (LangGraph, Presidio, Pydantic, LLM SDKs, evaluation tooling) is Python-first.

Safety rules (CLAUDE.md §2) require a clear boundary. The model side must only return structured, verifiable data. It must never own user state or send messages itself.

## Decision

- One **monorepo**: pnpm workspaces + Turborepo for Node, `uv` for Python, one Makefile as the entry point, and one CI workflow.
- **`apps/gateway` (NestJS, TypeScript strict).** It owns all user-facing state and all WhatsApp I/O. It also runs the BullMQ workers.
- **`apps/ai-service` (FastAPI, Python 3.12).** It is stateless per request. It only *reads* catalog tables and returns structured JSON through `POST /v1/process`, authenticated with a service token. It never sends WhatsApp messages.
- **`packages/contracts`** holds the shared OpenAPI/JSON Schema. TypeScript types are generated from the Pydantic schemas, so the two sides cannot drift.

## Consequences

**Positive**
- Each side uses the strongest ecosystem for its job.
- AI failures and latency are isolated from webhook ACKs. The gateway queues work and retries.
- The safety boundary is enforced by architecture: user data and outbound messages live in one place.
- The two services scale independently (the AI service is CPU/LLM-bound; the gateway is I/O-bound).

**Negative / costs**
- There are two toolchains, two lint/test stacks and two Docker images.
- The contract must be kept in sync (mitigated by generated types and a contract test, M5).
- An internal network hop adds latency, which is small compared with LLM latency.

## Alternatives considered

- **All TypeScript (NestJS + LangChain.js).** The ecosystem is weaker for Presidio, evals and vision tooling.
- **All Python (FastAPI + Celery/RQ).** This was viable. NestJS gives stronger structure for the large, stateful user-facing surface, and BullMQ gives first-class delayed and repeatable jobs for reminders.
- **Separate repositories.** Rejected for now: too much overhead for a small team, and the contracts would drift more easily.
