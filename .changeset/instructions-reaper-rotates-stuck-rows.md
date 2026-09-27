---
"fabric-app": patch
---

The Coding Instructions cleanup sweep no longer gets stuck behind uploads and validations whose workflows are still running or cannot be checked, so an abandoned upload or a validation that stopped responding behind them is still closed out.
