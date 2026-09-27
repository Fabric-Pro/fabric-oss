---
"fabric-app": patch
---

Coding Instructions audit rows now show how many possible secrets a rejected or flagged version had, and whether a repository sync change moved its folder, instead of recording both as redacted. Rejection counts are recorded as `metadata.reasons`, a list of `{ reason, count }`, and the folder flag as `metadata.rootChanged`.
