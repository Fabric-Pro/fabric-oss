---
"fabric-app": patch
---

Preserve saved project-management context during hourly ticket polling and classify per-ticket fetch failures at the PM boundary.

Fizzy polls now retain the configured account slug instead of falling back to the first connected account. The per-item fetcher owns failure logging so expected missing-card responses stay informational while authentication, timeout, and malformed responses remain actionable errors.
