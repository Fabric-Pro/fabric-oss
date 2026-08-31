---
"fabric-app": patch
---

Edit an AI-suggested answer before saving it on a feature's Summary + Questions tab.

Each suggested answer now carries its own Edit control, which opens the answer field pre-filled
with that suggestion's text so it can be refined instead of accepted verbatim or retyped. Cancel
restores the suggestion list and leaves the question open; an empty field still blocks the save.

This also corrects what `AnswerSource.AI_EDITED` means. It was defined as "a recommendation was
offered but the PO typed their own answer" — but that flow opens an EMPTY box, so nothing is taken
from the AI, and there was no way to start from a suggestion and change it. The value now means
what its name says: a suggestion the PO opened and modified. "Type your own" records MANUAL, and a
suggestion opened and saved untouched records AI_SUGGESTED rather than counting as an edit.

A data migration moves existing AI_EDITED rows to MANUAL. That is safe because the client is the
only writer of the column — no agent, MCP tool, seed or backfill path sets it — so every existing
row came from the typed-own flow. Note this retroactively shifts historical AI-adoption reporting:
"edited" answers move into "manual". That is the correction, not a regression.

Implementation note: the panel's `activeFromSuggestion` boolean became an `editingSeed` string,
because deciding between the three provenances requires knowing the text the field was seeded with,
not merely that a suggestion existed.
