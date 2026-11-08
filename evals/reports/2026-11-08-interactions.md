# Interaction eval (2026-11-08, fake LLM, core list v1)

- cases: 135
- expected interactions found: 94 / 94
- expected duplicate ingredients found: 15 / 15

## Hard gates (all must be 0)

- pair_recall: 0
- duplicate_recall: 0
- hallucinated: 0
- stop_advice: 0
- unchecked_called_safe: 0
- severity_wording: 0
- wrong_severity: 0

## By category

- combination: 10 / 10 cases with no violation
- duplicate: 13 / 13 cases with no violation
- no_row: 15 / 15 cases with no violation
- pair: 67 / 67 cases with no violation
- question: 20 / 20 cases with no violation
- stored: 5 / 5 cases with no violation
- unchecked: 5 / 5 cases with no violation

Coverage is PARTIAL: the core list is a small curated set. A case with no expected finding
means 'no row in our list', never 'safe'.
