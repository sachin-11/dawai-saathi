# WhatsApp message templates

> Placeholder. Final texts, variables and Meta approval status are filled in during **M3** (messaging client) and **M10** (reminders and caregiver alerts).

Outside the 24-hour customer-service window, WhatsApp only allows **Meta-approved template messages** (CLAUDE.md §7.4). Each template below needs a Hindi (`hi`) and an English (`en`) version.

| Template name (proposed) | Category | Purpose | Variables (draft) | Buttons (draft) | Module | Status |
|---|---|---|---|---|---|---|
| `dose_reminder` | Utility | Remind the user to take a scheduled dose | `{{1}}` medicine name, `{{2}}` dose, `{{3}}` time, `{{4}}` before/after food | Le li ✅ · Baad me ⏰ · Skip | M10 | Not submitted |
| `caregiver_alert` | Utility | Tell a verified caregiver about repeated missed doses | `{{1}}` relation/first name (no phone), `{{2}}` medicine name, `{{3}}` missed count | — | M10 | Not submitted |
| `consent_reminder` | Utility | Remind a user who has not yet accepted the consent message | `{{1}}` retention days | I agree · Not now | M4 | Not submitted |

## Rules for all templates

- No diagnosis, prescribing or medical advice (CLAUDE.md §2).
- No personal data beyond what the recipient already knows. Caregiver alerts never include the patient's phone number or document contents.
- Every template mentions how to opt out (`STOP REMINDERS` / `STOP`).
