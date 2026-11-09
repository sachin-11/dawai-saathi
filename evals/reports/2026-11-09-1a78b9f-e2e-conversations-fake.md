# Eval report 2026-11-09 (1a78b9f+dirty, e2e_conversations, mode fake)

**Overall: FAIL**

| Suite | Mode | Cases | Hard gates | Regressions | Warnings | Result |
|---|---|---|---|---|---|---|
| e2e_conversations | fake | 14 | 1/3 | 0 | 0 | FAIL |

Fake modes prove the plumbing and the safety layers, not model reading accuracy.

## e2e_conversations (fake): FAIL

- Cases: 14; dataset `f77283f2bbc3`; prompts: reply_templates (gateway i18n + AI templates)
- Models: fake / none
- Cost: $0.0000; latency p50 0 ms, p95 0 ms
- Baseline: 2026-11-09 (f401ec7)

### Hard gates

| Metric | Rule | Value | Result |
|---|---|---|---|
| scenarios_total | >= 12 | 14 | pass |
| scenario_pass_rate | == 1.0 | 0.4286 | FAIL |
| steps_failed | <= 0 | 8 | FAIL |

### Soft thresholds and baseline diff

| Metric | Value | Baseline | Diff | Rule | Status |
|---|---|---|---|---|---|
| - | - | - | - | - | - |

### Failing examples (ids and short redacted snippets)

- `new_user_prescription_reminder_delete`: step 3 (send image: rx_003) - `button rx:reminders: missing (got: none); button rx:generic: missing (got: none)`
- `reminder_outside_the_24h_window_is_a_template`: step 0 (send image: rx_004) - `no reply contains "Dolo 650"; seen: user=["text:Reading it now… this takes abo",`
- `prescription_and_generic_details`: step 0 (send image: rx_000) - `button rx:generic: missing (got: none); no reply contains "Dolo 650"; no reply c`
- `duplicate_ingredient_across_two_prescriptions`: step 1 (send image: rx_001) - `0 documents, expected 2; 0 medications, expected at least 2; no active duplicate`
- `lab_report_twice_and_reports_command`: step 0 (send image: lab_a) - `no reply contains "not a doctor"; seen: user=["text:Reading it now… this takes a`
- `delete_in_the_middle_of_a_flow`: step 0 (send image: rx_002) - `0 medications, expected at least 1; state: {"reminders":[],"misses":0,"reminders`
- `voice_note_commands`: step 1 (send audio: meds) - `no reply contains "Dolo 650"; seen: user=["text:You have no active medicines s"]`
- `caregiver_invite_and_missed_dose_alert`: step 6 (advance_time 18:00 next day) - `the caregiver got nothing; caregiver template caregiver_missed_dose_alert not se`

> The AI service ran in fake mode: this checks the plumbing between the services, not model quality.

<details><summary>Suite detail</summary>

### Conversation scenarios

| Scenario | Steps run | Result |
|---|---|---|
| new_user_prescription_reminder_delete | 4 | FAIL |
| reminder_outside_the_24h_window_is_a_template | 1 | FAIL |
| consent_decline_blocks_documents | 4 | pass |
| emergency_before_consent | 1 | pass |
| prescription_and_generic_details | 1 | FAIL |
| duplicate_ingredient_across_two_prescriptions | 2 | FAIL |
| lab_report_twice_and_reports_command | 1 | FAIL |
| emergency_in_the_middle_of_a_reminder_setup | 4 | pass |
| stop_reminders_command | 5 | pass |
| delete_in_the_middle_of_a_flow | 1 | FAIL |
| voice_note_commands | 2 | FAIL |
| voice_note_needs_consent_v2 | 3 | pass |
| spoken_emergency_is_answered_first | 1 | pass |
| caregiver_invite_and_missed_dose_alert | 7 | FAIL |

37 steps in total. Failing steps (with the database state and the replies seen) are listed under 'Failing examples'.

</details>
