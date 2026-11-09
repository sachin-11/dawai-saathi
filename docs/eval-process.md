# Eval process: how to change a prompt, a model or a safety list safely

Dawai Saathi is a health assistant. A prompt, a model id, a price file or a keyword list can change what a
patient is told, so every such change goes through the same loop: **edit, version, measure, compare, record**.

## The pieces

| What | Where |
|---|---|
| Suites (one per area) | `evals/suites/*.py`: emergency, matcher, interactions, rx, lab, voice, redteam, e2e_conversations, readability |
| Numbers that decide pass / fail | `evals/thresholds.yaml` (hard gates + soft thresholds, the only place numbers live) |
| Stored results to compare with | `evals/baselines/<suite>.json` (one block per mode, with the reason it was written) |
| Reports | `evals/reports/<date>-<git sha>[-scope].md` + `.json` (metrics, gates, diff vs baseline, cost, latency, failing example ids) |
| Datasets | `evals/datasets/*` (synthetic only; each has a `manifest.json` with `contains_real_phi: false`) |
| PR checks | `make eval-checks BASE=origin/main` (also run by CI on every pull request) |

**Hard gate**: a safety property that must hold exactly (100% emergency recall, 0 wrong-strength generics, 0
hallucinated interactions, 0 PHI leaks, every red-team assertion). It fails the run whatever the baseline says.
Changing one needs a Decisions Log row in `CLAUDE.md` §15.

**Soft threshold**: quality that depends on the model (field accuracy, WER, latency p95, cost per document,
readability). It fails only when a metric is *worse than its baseline by more than the tolerance* (for example
accuracy -2 points, p95 latency +20%, cost +15%). A metric with no baseline yet is reported as `new`.

**Fake mode vs real mode.** Fake models replay the gold labels or play a scripted (even "obedient", attacked)
model. They are deterministic and free, run on every PR, and prove the *plumbing and the deterministic safety
layers*. They cannot tell you how well a real model reads a handwritten prescription or whether it resists an
injection. Only `MODE=real` can, and it costs money, so it has a cost cap (`EVAL_MAX_USD`, a run that passes it is
aborted and counts as failed).

## Change a prompt (step by step)

1. **Never edit a prompt file in place.** Copy `apps/ai-service/app/prompts/files/rx_extract_v1.md` to
   `rx_extract_v2.md`, set `version: rx_extract_v2` (it must equal the file name), edit the new file, and point the
   `*_PROMPT_ID` constant in code at it. CI fails (`check-prompts`) on an in-place edit.
2. Keep the line that says the input is **DATA, not instructions**. A test (`test_prompt_data_note.py`) checks it.
3. Run the affected suites offline: `make eval SUITE=rx` (and `redteam`). Fix what the gates report.
4. Run them with a real model: `make eval SUITE=rx MODE=real EVAL_MAX_USD=2`. Read the report. Compare with the
   baseline column: any `regress` is a failure; a `warn` needs a sentence in the PR.
5. **Commit the real-mode report** from `evals/reports/` in the PR (CI `check-evidence` looks for it).
6. If the numbers moved on purpose, update the baseline with a reason:
   `make eval-baseline SUITE=rx MODE=real REASON="rx_extract_v2: clearer dose rule, F1 +0.03"`.
7. Add a row to the Decisions Log in `CLAUDE.md` §15: what changed, the metrics before and after, the report file.

## Change a model (env default, provider, version)

Model ids come from env (`VISION_MODEL`, `TEXT_MODEL`, `CHEAP_MODEL`, `FALLBACK_*`) and are never hard-coded.
Changing a default in `.env.example` or `config.py` is treated like a prompt change: run **every** suite that uses a
model in real mode (`emergency, rx, lab, voice, redteam, readability`), compare with the baselines, commit the
reports, update baselines with a reason, log the decision. Then run the red-team suite on the new model *first*:
a model upgrade can quietly become more obedient to injected text.

## Change a safety list, a price file or a threshold

`no_substitute.yaml`, `critical_values.yaml`, `emergency-keywords.json`, `pricing.yaml` and `thresholds.yaml` need an
updated report for the suites they affect (`check-evidence` lists which). Lowering a hard gate or removing a
keyword is never done to make a test pass. If you genuinely cannot run a real-mode suite yet, add a Decisions Log
row whose text contains `eval-waiver` and say why; that is the only override.

## Run things

```bash
make eval                                      # all suites, fake models, with gates (needs make test-infra-up for e2e)
make eval SUITE=redteam                        # one suite
make eval SUITE=rx MODE=real EVAL_MAX_USD=2    # real provider, capped
make eval-baseline SUITE=rx REASON="..."       # store metrics (refused for a run with a failing hard gate)
make eval-summary                              # refresh the table in README.md
make e2e                                       # only the conversation scenarios
make test-evals                                # tests of the harness itself
```

CI: every push runs each suite in its own job (`ci.yml`, matrix) and the e2e suite inside the integration job;
pull requests also run the prompt-version and eval-evidence checks. `eval-real.yml` runs the real-model suites
weekly and on demand with the cost cap, uploads the report and updates the "Weekly eval report" issue.

## What the datasets are (and are not)

All datasets are **synthetic or anonymised by construction**: generated pages with invented names and numbers,
sentences written for this project. No real patient document, voice or phone number is ever used, because (a)
real-mode runs send the data to an outside provider, (b) the DPDP purpose-limitation principle does not allow a
user's health data to become test data without their explicit consent, and (c) synthetic data can be committed and
shared. The price is realism: synthetic TTS voices and rendered pages are easier than a shaky phone photo or an
elderly speaker, so a high score means "the plumbing and the safety rules work", not "real users are served well".
A small, consented real-document set (with the faces, names and numbers removed) is a later, separate decision.
