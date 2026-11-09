# Lab report eval: 2026-11-09 (lab_extract_v1, mode `fake`)

- reports: 36; document status: {'done': 36}; pipeline errors: 0
- Gold labels and images are SYNTHETIC (fake names, ids and phones).
- `fake` replays the gold: it proves the plumbing, it does NOT measure how well a model reads.

## Hard gates

| Gate | Result |
|---|---|
| Critical value recall (must be 100%) | 12/12 (100.0%) |
| Critical line first (must be 100%) | 12/12 (100.0%) |
| Reports with diagnosis wording (must be 0) | 0 |
| Values in replies not on the page (must be 0) | 0 |
| PHI strings in extraction or reply (must be 0) | 0 |

**All hard gates passed.**

## Accuracy (reported, not gated)

| Metric | Value |
|---|---|
| Test-name mapping (catalog code) | 266/266 (100.0%) |
| Value + unit exact | 266/266 (100.0%) |
| Printed range extraction | 266/266 (100.0%) |
| Status | 266/266 (100.0%) |
| Gold rows not found in the output | 0 |

## Cost and latency

| Metric | Value |
|---|---|
| Cost per report (mean) | $0.00000 |
| Latency p50 | 65 ms |
| Latency p95 | 232 ms |

Never commit real patient reports. The ranges and critical limits are NOT clinically reviewed.
