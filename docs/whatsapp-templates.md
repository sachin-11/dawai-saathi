# WhatsApp message templates

Outside the 24-hour customer-service window WhatsApp only allows **Meta-approved template messages** (CLAUDE.md §7.4). This file holds the exact texts to submit to Meta, in Hindi (`hi`) and English (`en`). The code side lives in `apps/gateway/src/messaging/template.registry.ts` (`TEMPLATES`): it maps our internal names to Meta names, the order of the body variables and the number of quick-reply buttons, so no service builds template JSON by hand.

| Template (Meta name = internal name) | Category | Purpose | Used by | Variables | Buttons | Status |
|---|---|---|---|---|---|---|
| `dose_reminder` | UTILITY | Remind the user to take a scheduled dose | M10 | `{{1}}` medicine name, `{{2}}` dose + timing | 3 quick replies | Not submitted |
| `caregiver_missed_dose_alert` | UTILITY | Tell a verified caregiver about a missed dose | M10 | `{{1}}` patient label, `{{2}}` medicine name, `{{3}}` due time | none | Not submitted |
| `consent_reminder` | UTILITY | Remind a user who has not yet answered the consent message | M4 | none | 2 quick replies | Not submitted |
| `generic_reengage` | UTILITY (may be reclassified) | Re-open the chat after the 24 h window closed | M4 / M10 | none | none | Not submitted |

Use language codes `hi` and `en` (Meta: "Hindi", "English"). Every template needs both versions. When submitting, mark them as **Utility**; Meta may reclassify `generic_reengage` as *Marketing* (it is a "come back" message). If that happens we keep it but expect marketing-template limits, or drop it and rely on the others.

## How a template is used in code

```ts
registry.build('dose_reminder', 'hi',
  { medicine_name: 'Dolo 650', dose_timing: '1 गोली, सुबह 8:00 बजे, खाने के बाद' },
  [`taken:${reminderId}`, `snooze:${reminderId}`, `skip:${reminderId}`]);   // quick-reply payloads, 1 per button, ≤ 128 chars
```
Quick-reply payloads come back to us as `button` messages (`button.id`), so the reminder id travels inside the payload.

---

## 1. `dose_reminder` (UTILITY)

| | `hi` | `en` |
|---|---|---|
| **Body** | याद दिलाना: आपकी दवा {{1}} लेने का समय हो गया है। पर्ची के अनुसार मात्रा और समय: {{2}}। दवा लेने के बाद नीचे का बटन दबाएँ। | Reminder: it is time for your medicine {{1}}. Dose and timing as written on your prescription: {{2}}. Please tap a button once you have taken it. |
| **Footer** | रिमाइंडर बंद करने के लिए STOP REMINDERS लिखें | Reply STOP REMINDERS to stop reminders |
| **Buttons** (quick reply, ≤ 25 chars) | ले ली ✅ · 30 मिनट बाद ⏰ · छोड़ें | Taken ✅ · In 30 min ⏰ · Skip |
| **Sample `{{1}}`** | Dolo 650 | Dolo 650 |
| **Sample `{{2}}`** | 1 गोली, सुबह 8:00 बजे, खाने के बाद | 1 tablet, 8:00 AM, after food |

Payloads we send: `taken:<reminderId>`, `snooze:<reminderId>`, `skip:<reminderId>`.

## 2. `caregiver_missed_dose_alert` (UTILITY)

| | `hi` | `en` |
|---|---|---|
| **Body** | सूचना: {{1}} ने दवा {{2}} अभी तक नहीं ली है, जो {{3}} पर लेनी थी। कृपया हो सके तो उनका हालचाल पूछ लें। | Alert: {{1}} has not confirmed taking {{2}}, which was due at {{3}}. Please check on them when you can. |
| **Footer** | अलर्ट बंद करने के लिए STOP लिखें | Reply STOP to stop these alerts |
| **Buttons** | — | — |
| **Sample `{{1}}`** | आपके पिताजी | your father |
| **Sample `{{2}}`** | Metformin | Metformin |
| **Sample `{{3}}`** | रात 8:00 बजे | 8:00 PM |

`{{1}}` is a relation label chosen when the caregiver was added, never a phone number or the patient's name from a document.

## 3. `consent_reminder` (UTILITY)

| | `hi` | `en` |
|---|---|---|
| **Body** | नमस्ते! दवाई साथी आपको पर्ची और लैब रिपोर्ट समझने में मदद करता है। आपके दस्तावेज़ पढ़ने से पहले मुझे उन्हें सुरक्षित रखने की आपकी अनुमति चाहिए। आप कभी भी DELETE भेजकर अपना सारा डेटा हटवा सकते हैं। | Hi! Dawai Saathi helps you understand prescriptions and lab reports. Before I can read your documents I need your permission to store them securely. You can delete all your data at any time by sending DELETE. |
| **Footer** | — | — |
| **Buttons** (quick reply) | मैं सहमत हूँ · अभी नहीं | I agree · Not now |
| **Samples** | none (no variables) | none |

Payloads we send: `consent_yes`, `consent_no`.

## 4. `generic_reengage` (UTILITY, may be reclassified)

| | `hi` | `en` |
|---|---|---|
| **Body** | नमस्ते! हमारी बातचीत की समय-सीमा खत्म हो गई है। कोई भी संदेश, जैसे "नमस्ते", भेजिए, मैं वहीं से आगे बढ़ूँगा। | Hi! Our chat window has closed. Reply with any message, like "Hi", and I will continue from where we left off. |
| **Footer** | — | — |
| **Buttons** | — | — |
| **Samples** | none | none |

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
