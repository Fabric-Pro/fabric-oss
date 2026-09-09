---
"fabric-app": patch
---

Offer several suggested answers per question, as Feature Maturation does

*"For AI suggested answers lets follow the same logic as in fmv2, card (or couple cards if couple possible answers)"* (Fizzy #1851, finding #24).

A question now carries up to four real options — the choices a reader is deciding between, not one answer and its negation — each with the reasoning that supports it. With several on screen the reasoning is the only thing separating them, so an option arriving without one is dropped, which is the rule Feature Maturation already enforces. A pencil opens the editor seeded with that option's text, so a near-miss can be adjusted rather than retyped.

Picking one records `AI_SUGGESTED`; editing one first records `AI_EDITED`. That distinction is the point rather than a detail — starting from the AI's wording is a different fact about acceptance from having typed your own, and the adoption metric measures exactly that difference.

Stored as JSON on the decision entry rather than in a second table, following FMv2's own precedent: the options are read and written as one unit, never queried across and never joined to. `recommendedResponse` is deliberately kept as the single-answer fallback, so nothing needed backfilling and every question minted before this reads exactly as it did.

The options are normalised tolerantly on the way in — a malformed one costs that option and nothing else, where a strict schema would throw a non-retryable validation failure and lose the whole analysis run.
