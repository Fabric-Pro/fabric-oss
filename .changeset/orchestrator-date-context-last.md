---
"fabric-app": patch
---

Render the orchestrator's date context date-only and append it last so provider prompt caching survives across calls within a day

Fizzy #2345. `packages/temporal/src/workflows/orchestrator/phases/initialization.ts` hand-rolls its own "Today is …" line because Temporal workflow code runs in a sandboxed isolate and cannot import `@repo/ai`'s `getCurrentDateContext()`. It rendered the stamp at minute granularity and prepended it at position 0 of the system prompt, ahead of policy enrichment, project context, instance memory, Fabric pattern enrichment, workflow guidance and orchestrator memory — so every orchestrator LLM call started with a string that changed each minute and the provider's cached prefix never matched.

The date is now rendered at day granularity and appended as the final segment, mirroring the date-last ordering already used in `agent-execution-core/context-builder.ts`. The `new Date()` acquisition site and the hand-rolled UTC day/month tables are unchanged, so nothing determinism-sensitive moves; only the format and the placement of the resulting string change. Pinned by `packages/temporal/__tests__/orchestrator-date-context-placement.test.ts`.
