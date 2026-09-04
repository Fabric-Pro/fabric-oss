---
"fabric-app": patch
---

Temporal: route every client connection through the shared TLS/API-key/fail-closed policy and remove the dead @repo/rag browser extractor

`packages/temporal/src/client.ts` is where the Temporal Cloud API-key, mTLS and production fail-closed logic live (`createConnection` refuses a plaintext connection under `NODE_ENV=production` unless `TEMPORAL_ALLOW_INSECURE=true`, SOC 2 CC6.7). Three call sites bypassed it with a bare `Connection.connect({ address })`:

- `packages/rag/lib/extraction/extractors/browser-extractor-client.ts` — the browser extractor's private client. On inspection the whole extractor was dead code: `BrowserExtractor` was never registered with the extraction factory, nothing in the repo imported it, and its client read `result.extracted` / `result.screenshotUrl` from a `BrowserTaskResult` that only has `extraction` / `screenshots`, so it could never have returned text even over a working connection. The live browser RAG path runs entirely inside the worker (`browser-rag-ingestion.ts` → `chunkAndStoreWebContent`). Both files are deleted and `@repo/rag` drops its `@temporalio/client` dependency, which its own barrel comment flagged as a protobuf double-registration hazard under Turbopack. This avoids the alternative of a rag → temporal dependency, which would have been the repo's first workspace cycle (temporal already depends on rag).
- `packages/temporal/src/activities/agent-supervisor.ts` and `deployment-execution.ts` — live activities that also built `new Client({ connection })` with no namespace, so on Temporal Cloud they would have targeted `default`. Both now call the shared `getTemporalClient()`.

`schedules.ts` duplicated the TLS/API-key branches of `createConnection` without the fail-closed guard; it now calls the (newly exported) `createConnection()` instead.

The fail-closed check itself is extracted into `assertInsecureConnectionAllowed()` and the worker's `NativeConnection` path in `worker.ts` now calls it too. Before this the worker would happily poll over plaintext in production while the API side refused to start — the two halves of the same deployment disagreed on the policy. Staging and production use Temporal Cloud with an API key, so the guard never fires there; it only turns a silent downgrade into a startup error. `TEMPORAL_ALLOW_INSECURE=true` remains the emergency override for both.

Two new tests: `packages/temporal/__tests__/temporal-connection-policy.test.ts` walks the repo and fails on any `Connection.connect(` / `NativeConnection.connect(` outside an explicit allowlist (the shared client, the worker's `NativeConnection`, and two developer scripts), and also fails if an allowlisted entry disappears; `temporal-connection-fail-closed.test.ts` pins the guard's production / override / non-production behaviour.

Fizzy #2399.
