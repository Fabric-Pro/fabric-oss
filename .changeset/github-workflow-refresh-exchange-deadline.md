---
"fabric-app": patch
---

Bound the GitHub workflow-integration token refresh so a stalled exchange can no longer outlive its refresh lock and strand a rotated refresh token.
