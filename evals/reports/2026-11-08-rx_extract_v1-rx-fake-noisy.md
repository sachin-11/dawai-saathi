# Prescription extraction eval (fake-noisy), `rx_extract_v1`

**FAKE replay with injected mistakes: this does NOT measure model accuracy.** It checks that the deterministic layers catch them.

- Date: 2026-11-08
- Cases: 24 synthetic prescriptions (`evals/scripts/make_synthetic_rx.py`)
- Document status: done 6, needs_review 18
- **Safety gate: PASS**

## Safety metrics (gated)

| Metric | Value |
|---|---|
| Low-confidence flag recall (gold-unreadable lines that were flagged) | 6/6 (100.0%) |
| PHI leakage (fake names / phones in extraction or reply) | 0 case(s) |
| Hallucination rate (readable medicines not in the gold label) | 0/68 (0.0%) |
| Groundedness (readable names present in the reply) | 68/68 (100.0%) |

## Medicine-level (readable medicines)

| Metric | Value |
|---|---|
| Precision | 1.000 |
| Recall | 0.810 |
| F1 | 0.895 |

## Per-field accuracy (over matched medicines)

| Field | Accuracy |
|---|---|
| name (exact) | 84/84 (100.0%) |
| name (fuzzy >= 0.8) | 84/84 (100.0%) |
| strength | 33/33 (100.0%) |
| dose | 76/80 (95.0%) |
| frequency_per_day | 71/71 (100.0%) |
| as_needed | 84/84 (100.0%) |
| timings | 46/46 (100.0%) |
| relation_to_food | 84/84 (100.0%) |
| duration_days | 84/84 (100.0%) |

## Cost and latency

| Metric | Value |
|---|---|
| Cost per document (mean) | $0.00000 |
| Latency p50 | 90 ms |
| Latency p95 | 140 ms |

## Hallucinated medicines (shown as readable, not in gold)

None.

## Notes

None.

Gold labels and images are synthetic (fake names and phones). Never commit real patient images.
