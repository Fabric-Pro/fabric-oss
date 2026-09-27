---
"fabric-app": patch
---

Audit rows for testing environment credentials, testing webhook rotations, to-do snoozes, Atlas branch pinning and completed Atlas analyses now record their details instead of showing them as redacted. The keys are renamed so the audit redactor no longer mistakes them for secrets: `valueSupplied`, `valueWritten` and `valueCleared` on credential updates, `overlapEndsAt` on webhook rotations, `priorSnoozedUntil` on snoozes, `branches` on Atlas branch pinning, and `usageTotal` (model tokens) on completed analyses.
