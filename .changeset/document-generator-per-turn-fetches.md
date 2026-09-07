---
"fabric-app": patch
---

Speed up project document generation by reusing prompt settings across a run and recording usage asynchronously.

`chatNode` runs once per tool round plus once for the final answer — up to 21 times per run, and once more per retryable model error that re-enters the node via `new Command({ goto: "chat_node" })`. Two pieces of per-turn work were pure overhead:

1. `buildSystemPromptAsync` probed the Fabric AI server (`/health`) and, when it answered, re-fetched the pattern and persona context. The composed fragment depends only on the pattern/context names the document type resolves to, and `fetchFabricJson` runs with `keepAlive: false`, so each turn paid fresh handshakes — and up to two 3 s timeouts per turn whenever the server was down.
2. `logAgentUsageFromRunnableConfig` was awaited on the critical path right after each model invocation, at five sites, even though nothing downstream reads the usage row back.

Changes:

- `agents/langchain/project-document-generator/prompts/index.ts` — the availability check plus pattern/context fetch is now memoized per (pattern, context) behind `getFabricPromptFragment`. 5 minute TTL on a success, 60 second TTL on "no fragment" (server down, or no such pattern), so an unreachable server costs one probe per minute instead of two timeouts per turn. The entry stores the promise, so concurrent callers share one round trip. The assembled prompt text is byte-identical for the same inputs.
- `packages/agent-core/src/services/usage-logging.ts` — `logAgentUsageFromRunnableConfig` now wraps its whole body, so it is guaranteed never to reject (previously an exception while shaping the payload could escape; the fetch itself was already caught). Only the project-document-generator's five call sites switch to `void`; other agents still await.

The other per-turn round trip, `getAgentModelAsync`'s call to `/api/agents/ai-config/task`, is deliberately left uncached: that endpoint runs `getAIModelWithMetadata`, which enforces the tenant's AI usage limit on every call, so memoizing its answer would let the rest of a run keep calling the provider after the cap is hit.

Covered by `agents/langchain/project-document-generator/__tests__/fabric-prompt-cache.test.ts` and two new cases in `packages/agent-core/__tests__/usage-logging.test.ts` pinning the never-rejects contract.
