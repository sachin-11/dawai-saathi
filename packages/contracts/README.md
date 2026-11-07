# @dawai/contracts

Placeholder package. It will hold the API contracts shared by both apps:

- **Source of truth:** the Pydantic schemas in `apps/ai-service/app/schemas/`.
- **Exported artefacts:** the ai-service OpenAPI document (`openapi.json`) and JSON Schemas for
  `POST /v1/process` request/response (CLAUDE.md §8.1).
- **Generated TypeScript types:** consumed by `apps/gateway/src/ai-client/`, so the gateway never
  hand-writes the AI contract (CLAUDE.md §10 — no `any` at service boundaries).
- **Contract test:** CI regenerates the types and fails on drift (CLAUDE.md §11).

Populated in **M5 — AI service skeleton**.
