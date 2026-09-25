---
"fabric-app": patch
---

Failed API calls in the browser console now name the request that failed, so a network error is traceable instead of a bare "Failed to fetch".

Fizzy #2249 logging point, option 1. The shared oRPC client interceptor used to log a transport failure as only `TypeError: Failed to fetch`, which does not say which procedure failed. Its logging decision moves into `modules/shared/lib/rpc-failure-log.ts`, and the log line now reads `oRPC <router/path> failed:` followed by the error, so a server error still carries its message. Expected 4xx responses stay silent, as before, because consumers handle them through their query's `error` and logging them turns each one into a Next.js dev-overlay error. Aborted requests stay silent. The abort check is now by `name` rather than `instanceof Error`, so it does not depend on which realm the DOMException comes from.

Not in scope: sending client failures to a central log sink (option 2).
