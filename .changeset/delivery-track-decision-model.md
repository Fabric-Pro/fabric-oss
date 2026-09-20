---
"fabric-app": patch
---

Backlog delivery-track classification now uses an organization's configured decision model for confident track verdicts before falling back to the language classifier.

One typed evaluation asks for every story in a batch at once, over the same project context and track guidance the language classifier receives, and a story whose answer clears the confidence floor is assigned its track from that answer alone. Because a typed evaluation returns a choice and a probability rather than written evidence, a story decided this way is stored with an empty rationale and the track's own description is shown in its place. No configured decision model, an uncertain or malformed answer, or an evaluation error other than an exhausted usage limit all send the affected stories to the existing language classifier, so classification behaves exactly as before for organizations without a decision model.
