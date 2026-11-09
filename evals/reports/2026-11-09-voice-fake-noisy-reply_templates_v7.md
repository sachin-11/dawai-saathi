# Voice evaluation (fake-noisy) 2026-11-09

Templates `reply_templates_v7`. 100 synthetic prompts: {'medicine': 16, 'interaction': 6, 'command': 22, 'chatter': 12, 'emergency': 44}.

> `fake` modes replay the prompt text through a fake speech provider. They prove the plumbing and the
> safety rules; they do **not** measure speech-recognition accuracy (see the real-mode report for that).

## Hard gates

| gate | result |
|---|---|
| emergency recall on voice | 44/44 = 100.0% (must be 100%) |
| command detected inside a sentence | 0 (must be 0) |
| DELETE by voice with a side effect | 0 (must be 0) |
| answered about a misheard medicine | 0 of 5 (must be 0) |

Command detection: 18/22.

**Result: PASS**
