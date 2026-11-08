# WhatsApp message templates

Outside the 24-hour customer-service window WhatsApp only allows **Meta-approved template messages** (CLAUDE.md §7.4). This file holds the exact texts to submit to Meta, in Hindi (`hi`) and English (`en`). The code side lives in `apps/gateway/src/messaging/template.registry.ts` (`TEMPLATES`): it maps our internal names to Meta names, the order of the body variables and the number of quick-reply buttons, so no service builds template JSON by hand.

| Template (Meta name = internal name) | Category | Purpose | Used by | Variables | Buttons | Status |
|---|---|---|---|---|---|---|
| `dose_reminder` | UTILITY | Remind the user to take a scheduled dose (all medicines due at that time in ONE message) | M10 | `{{1}}` medicines due, `{{2}}` local time | 3 quick replies | Not submitted |
| `caregiver_invite` | UTILITY | Ask a family member whether they agree to be a caregiver | M10 | `{{1}}` the name the user gave ("Papa") | none (the caregiver answers YES / NO as text) | Not submitted |
| `caregiver_missed_dose_alert` | UTILITY | Tell a verified caregiver that doses were missed (no health details) | M10 | `{{1}}` the name the user gave, `{{2}}` local time of the dose | none | Not submitted |
| `daily_summary` | UTILITY | Evening count of doses taken (behind `DAILY_SUMMARY_ENABLED`) | M10 | `{{1}}` taken, `{{2}}` total | none | Not submitted |
| `reminder_renewal` | UTILITY | "Your reminders end tomorrow, continue?" (open-ended prescriptions) | M10 | none | 2 quick replies | Not submitted |
| `consent_reminder` | UTILITY | Remind a user who has not yet answered the consent message | M4 | none | 2 quick replies | Not submitted |
| `generic_reengage` | UTILITY (may be reclassified) | Re-open the chat after the 24 h window closed | M4 / M10 | none | none | Not submitted |

Use language codes `hi` and `en` (Meta: "Hindi", "English"). Every template needs both versions. When submitting, mark them as **Utility**; Meta may reclassify `generic_reengage` as *Marketing* (it is a "come back" message). If that happens we keep it but expect marketing-template limits, or drop it and rely on the others.

## How a template is used in code

```ts
registry.build('dose_reminder', 'hi',
  { medicines: 'Dolo 650 (1 गोली, खाने के बाद); Metformin 500', time: '08:00' },
  [`rem:taken:${epoch}`, `rem:snooze:${epoch}`, `rem:skip:${epoch}`]);   // quick-reply payloads, 1 per button, ≤ 128 chars
```
Quick-reply payloads come back to us as `button` messages (`button.id`), so the slot (epoch seconds of the reminder time) travels inside the payload. The user is always the sender of the tap, never part of the payload, so nobody can answer for someone else.

---

## 1. `dose_reminder` (UTILITY)

One message per user and time slot, however many medicines are due (fewer messages, less fatigue). Content comes from the saved medicines only, no LLM.

| | `hi` | `en` |
|---|---|---|
| **Body** | दवा का रिमाइंडर: {{1}} का समय {{2}} है। दवा लेने के बाद नीचे का बटन दबाएँ। | Medicine reminder: {{1}} is due at {{2}}. Please tap a button once you have taken it. |
| **Footer** | रिमाइंडर बंद करने के लिए STOP REMINDERS लिखें | Reply STOP REMINDERS to stop reminders |
| **Buttons** (quick reply, ≤ 25 chars) | ले ली ✅ · बाद में ⏰ · छोड़ें | Le li ✅ · Baad me ⏰ · Skip |
| **Sample `{{1}}`** | Dolo 650 (1 गोली, खाने के बाद); Metformin 500 | Dolo 650 (1 tablet, after food); Metformin 500 |
| **Sample `{{2}}`** | 08:00 | 08:00 |

Payloads we send: `rem:taken:<epoch>`, `rem:snooze:<epoch>`, `rem:skip:<epoch>` (epoch = the reminder time in seconds). Inside the 24 h window the same message goes out as an interactive message with the same three ids, so both paths are handled by one parser.

## 2. `caregiver_invite` (UTILITY)

The first message a caregiver ever gets. The caregiver must reply `YES` / `HAAN` within 48 hours; `NO` or silence means no alert is ever sent.

| | `hi` | `en` |
|---|---|---|
| **Body** | नमस्ते! {{1}} आपको दवाई साथी पर अपनी दवा के रिमाइंडर के लिए परिवार का संपर्क बनाना चाहते हैं। अगर आप सहमत हैं तो YES भेजें, नहीं तो NO भेजें। | {{1}} would like to add you as a family contact for their medicine reminders on Dawai Saathi. If you agree, reply YES. If not, reply NO. |
| **Footer** | — | — |
| **Buttons** | — | — |
| **Sample `{{1}}`** | पापा | Papa |

`{{1}}` is the name the **user typed** during `CAREGIVER +91…` ("what does this person call you?"). It is never the user's phone number or a name read from a document.

## 2b. `caregiver_missed_dose_alert` (UTILITY)

Minimum necessary information: a label and a time. **No medicine name, no dose, no condition.** Enforced by the template definition (`bodyParams: ['user_label', 'time']`) and by tests that serialise the whole outbound request and search it for medicine names.

| | `hi` | `en` |
|---|---|---|
| **Body** | सूचना: {{1}} ने {{2}} की दवा नहीं ली, और यह लगातार कई बार हुआ है। कृपया एक बार हालचाल पूछ लीजिए। | Alert: {{1}} did not take the {{2}} dose, and this has happened several times in a row. Please check on them when you can. |
| **Footer** | अलर्ट बंद करने के लिए STOP ALERTS लिखें | Reply STOP ALERTS to stop these alerts |
| **Buttons** | — | — |
| **Sample `{{1}}`** | पापा | Papa |
| **Sample `{{2}}`** | 21:00 | 21:00 |

Throttle: at most one alert per caregiver per 6 hours and three per local day.

## 3. `consent_reminder` (UTILITY)

| | `hi` | `en` |
|---|---|---|
| **Body** | नमस्ते! दवाई साथी आपको पर्ची और लैब रिपोर्ट समझने में मदद करता है। आपके दस्तावेज़ पढ़ने से पहले मुझे उन्हें सुरक्षित रखने की आपकी अनुमति चाहिए। आप कभी भी DELETE भेजकर अपना सारा डेटा हटवा सकते हैं। | Hi! Dawai Saathi helps you understand prescriptions and lab reports. Before I can read your documents I need your permission to store them securely. You can delete all your data at any time by sending DELETE. |
| **Footer** | — | — |
| **Buttons** (quick reply) | मैं सहमत हूँ · अभी नहीं | I agree · Not now |
| **Samples** | none (no variables) | none |

Payloads we send: `consent:yes`, `consent:no` (the same ids as the consent buttons, so the conversation router handles a tap on this template exactly like a tap on the consent message).

## 4. `generic_reengage` (UTILITY, may be reclassified)

| | `hi` | `en` |
|---|---|---|
| **Body** | नमस्ते! हमारी बातचीत की समय-सीमा खत्म हो गई है। कोई भी संदेश, जैसे "नमस्ते", भेजिए, मैं वहीं से आगे बढ़ूँगा। | Hi! Our chat window has closed. Reply with any message, like "Hi", and I will continue from where we left off. |
| **Footer** | — | — |
| **Buttons** | — | — |
| **Samples** | none | none |

## 5. `daily_summary` (UTILITY, behind `DAILY_SUMMARY_ENABLED`)

| | `hi` | `en` |
|---|---|---|
| **Body** | आज की खुराक: {{1}} ली गईं, कुल {{2}}। रिमाइंडर देखने के लिए REMINDERS भेजें। | Today's doses: {{1}} taken out of {{2}}. Send REMINDERS to see your reminders. |
| **Buttons** | — | — |
| **Sample `{{1}}` / `{{2}}`** | 4 / 5 | 4 / 5 |

## 6. `reminder_renewal` (UTILITY)

Sent the day before an open-ended prescription's reminders end (the course had no written duration, so we scheduled `REMINDER_OPEN_ENDED_DAYS`, default 30).

| | `hi` | `en` |
|---|---|---|
| **Body** | आपकी दवा के रिमाइंडर कल खत्म हो रहे हैं। क्या आप इन्हें जारी रखना चाहते हैं? नीचे का बटन दबाएँ। | Your medicine reminders end tomorrow. Do you want to continue them? Please tap a button. |
| **Buttons** (quick reply) | हाँ, जारी रखो · अभी नहीं | Yes, continue · Not now |
| **Samples** | none (no variables) | none |

Payloads we send: `rem:renew:yes`, `rem:renew:no`.

---

## Meta's formatting rules we already respect

- A variable may not be the very first or last thing in the body, and variables are numbered `{{1}}`, `{{2}}`… in order of appearance.
- Body ≤ 1024 characters, footer ≤ 60, quick-reply button text ≤ 25 characters, payload ≤ 128 characters.
- Variable values cannot contain newlines, tabs or 4+ consecutive spaces; `TemplateRegistry.build` cleans them.
- Provide a realistic **sample value** for every variable when submitting (listed above), otherwise Meta rejects the template.

## Rules for all templates

- No diagnosis, prescribing or medical advice (CLAUDE.md §2).
- No personal data beyond what the recipient already knows. Caregiver alerts never include the patient's phone number or document contents.
- Reminder and alert templates mention how to opt out (`STOP REMINDERS` / `STOP`).
- Templates are approved per language; submitting `hi` and `en` as two language versions of the same template name keeps the code simple (`language.code` picks the version).

## Submission checklist (do this before M4 / M10 go live)

1. Meta Business Manager → WhatsApp Manager → Message templates → Create template.
2. Name = the Meta name in the table above (lowercase, underscores), category **Utility**, languages `hi` + `en`.
3. Paste body / footer / buttons / sample values exactly as above.
4. Wait for approval (usually minutes to a day), then set the status column to *Approved*.
