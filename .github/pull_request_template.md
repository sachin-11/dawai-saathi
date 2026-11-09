## What and why

<!-- One module or one feature per PR. Link the CLAUDE.md section or decision this follows. -->

## Checklist

**Tests**
- [ ] `make lint typecheck test` is green; new business logic has tests
- [ ] `make test-integration` and `make e2e` are green if gateway or AI behaviour changed

**Evals and safety gates** (see `docs/eval-process.md`)
- [ ] `make eval` passes: every hard gate is 0 / 100% and nothing regressed against its baseline
- [ ] I changed a **prompt**: I created the next version file (never edited one in place), ran `make eval SUITE=<x> MODE=real`, and **committed that report** under `evals/reports/`
- [ ] I changed **model env defaults, `pricing.yaml`, `thresholds.yaml`, a safety YAML (`no_substitute`, `critical_values`) or the emergency keywords**: the matching eval report is committed (real mode where a model is involved)
- [ ] If a baseline moved, I ran `make eval-baseline ... REASON="..."` and added a Decisions Log row (CLAUDE.md §15) with the same reason
- [ ] No hard gate or safety rule (CLAUDE.md §2) was weakened to make a test pass; if a gate changed, the Decisions Log says why
- [ ] No real patient data, phone number or secret is in the diff or in a dataset (`contains_real_phi: false`)

**Docs**
- [ ] `docs/modules/M<N>.md` written or updated (Hinglish, interview-ready)
- [ ] CLAUDE.md §14 progress and §15 decisions updated; README updated if setup or commands changed
- [ ] `make contracts` / `make safety-data` output committed if schemas or shared data changed

## How I verified it

<!-- Commands run, reports linked, anything NOT verified (real models, real WhatsApp) said plainly. -->
