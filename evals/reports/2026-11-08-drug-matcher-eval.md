# Drug matching and generic finder eval

Offline run against the curated brand list + the FICTIONAL-price fixture. The cases are synthetic and written by us: they check the safety rules, not coverage of the real market.

- Date: 2026-11-08
- Cases: 279 (245 with a known product, 19 unsafe-to-compare inputs, 15 unknown names)
- Suggestions given: 57 cases
- **Hard gates: PASS**

## Hard gates (must be 0)

| Gate | Violations |
|---|---|
| wrong_strength | 0 |
| wrong_form_release | 0 |
| wrong_salt | 0 |
| forbidden_suggestion | 0 |

## Matching (reported, not gated)

| Metric | Value |
|---|---|
| Correct product (keys equal the gold) | 239/245 (97.6%) |
| Wrong product | 0/245 (0.0%) |
| Abstained (no match) | 6/245 (2.4%) |
| Unknown medicines correctly left unmatched (`none` precision) | 15/15 (100.0%) |
| Unsafe-to-compare inputs (wrong strength/form, unverifiable, ambiguous) that got NO suggestion | 19/19 (100.0%) |
| Suggestion coverage on cases with a safe generic in the catalog | 57/71 (80.3%) |

### By method (cases with a known product)

| Method | Correct | Wrong |
|---|---|---|
| exact | 189 | 0 |
| none | 0 | 0 |
| salt_written | 11 | 0 |
| trgm | 39 | 0 |

### By category

| Category | Outcomes |
|---|---|
| brand_exact | {'correct': 37} |
| brand_hyphen | {'correct': 37} |
| brand_prefixed | {'correct': 37} |
| brand_squeezed | {'correct': 37} |
| brand_suffixed | {'correct': 37} |
| brand_typo | {'abstained': 2, 'correct': 35} |
| devanagari | {'abstained': 4, 'correct': 5} |
| release | {'correct': 2} |
| salt_written | {'correct': 12} |
| strength_unverified | {'guarded': 7} |
| unknown | {'correct_none': 15} |
| wrong_form | {'guarded': 4} |
| wrong_strength | {'guarded': 8} |

## Wrong matches (no suggestion may have followed; see the gates)

None.

## Unknown names that matched something (a real false match; none expected)

None.
