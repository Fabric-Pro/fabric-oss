---
"fabric-app": patch
---

Meeting-digest action-item linking now uses an organization's configured decision model for confident link verdicts before falling back to the language verifier.

Uncertain, malformed, or failed decisions and organizations without a configured decision model fall back to the existing language verifier unchanged, and the operator's minimum-confidence setting still governs what becomes a link. Links settled on the fast path carry no reasoning text, because a decision model returns a probability rather than written evidence.
