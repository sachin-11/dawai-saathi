# LangGraph migration: regression comparison

The same evals through the pre-graph pipeline (`minimal`) and the LangGraph pipeline (`graph`), with fake models (offline). **This checks that the migration changed no behaviour; it does not measure model quality.**

- Date: 2026-11-08
- **Result: PASS**

## Emergency messages (M6)

| Metric | minimal | graph | verdict |
|---|---|---|---|
| missed_emergencies (hard gate) | 0 | 0 | equal |
| recall_pct | 100 | 100 | equal |
| clear_negatives_flagged | 0 | 0 | equal |

## Prescriptions (M7, M8)

| Metric | minimal | graph | verdict |
|---|---|---|---|
| flag_misses (hard gate) | 0 | 0 | equal |
| phi_leaks (hard gate) | 0 | 0 | equal |
| hallucinated_medicines (hard gate) | 0 | 0 | equal |
| ungrounded_names (hard gate) | 0 | 0 | equal |
| unsafe_generic_suggestions (hard gate) | 0 | 0 | equal |
| errors (hard gate) | 0 | 0 | equal |
| medicine_precision | 1 | 1 | equal |
| medicine_recall | 0.952 | 0.952 | equal |
| accuracy: name (exact) | 1 | 1 | equal |
| accuracy: name (fuzzy >= 0.8) | 1 | 1 | equal |
| accuracy: strength | 1 | 1 | equal |
| accuracy: dose | 1 | 1 | equal |
| accuracy: frequency_per_day | 1 | 1 | equal |
| accuracy: as_needed | 1 | 1 | equal |
| accuracy: timings | 1 | 1 | equal |
| accuracy: relation_to_food | 1 | 1 | equal |
| accuracy: duration_days | 1 | 1 | equal |
| documents_done | 15 | 15 | equal |
| documents_needs_review | 9 | 9 | equal |
| documents_failed | 0 | 0 | equal |

## Typed generic questions (M8)

| Metric | minimal | graph | verdict |
|---|---|---|---|
| gate: wrong_strength (hard gate) | 0 | 0 | equal |
| gate: wrong_form_release (hard gate) | 0 | 0 | equal |
| gate: wrong_salt (hard gate) | 0 | 0 | equal |
| gate: forbidden_suggestion (hard gate) | 0 | 0 | equal |
| cases_with_a_suggestion | 57 | 57 | equal |

