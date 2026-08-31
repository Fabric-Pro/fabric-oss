---
"fabric-app": patch
---

Retire the interface strings that name personal tenancy, keeping the ones that name a credential

Seventeen translation values mentioned "personal" and they were three different things. Eight name a credential class — a personal API key, a personal access token — and those outlive the tenancy, so they stay. Three belong to the prompt scope enum, which is decided with the prompt data model rather than here. The remaining ones named the tenancy itself and are gone: the switcher's fallback label, the notifications hint, the audit-log actor filter's title, and two values with no consumer at all.

The switcher's key is renamed alongside its value, so nothing in the codebase still calls that state a personal account. German carried the same five and moves with them.
