---
"fabric-app": patch
---

Bound the LangGraph agents' model-call retries and share one retry helper across the agents.

Fizzy #2424. `createProviderModel`'s `DEFAULT_MAX_RETRIES` fed straight into LangChain core's `AsyncCaller`, which wraps every `invoke` in `pRetry` with a 1 s base delay, factor 2, jitter x[1,2), and an uncapped max timeout. At 10 retries that backoff alone summed to 17–34 minutes of pure sleep in the worst case, on top of whatever whole-node retry each agent layered above it; at 3 retries it's bounded to roughly 14 seconds. The LangGraph agents under `agents/langchain/` are the only callers of this factory.

Added `packages/agent-core/src/retry.ts` (`MAX_NODE_RETRIES`, `RETRY_BASE_DELAY_MS`/`RETRY_MAX_DELAY_MS`, `isJsonParseError`, `isRetryableError`, `calculateRetryDelay`, `sleep`) and re-exported it from `@repo/agent-core`. `document-generator`, `story-breakdown`, `backlog-updater`, `prompt-enhancer` and `project-document-generator` now re-export these instead of each carrying its own copy.

Deleted `task-planner`'s standalone `withRetry` wrapper (`utils/retry.ts`) entirely — its five nodes now call `model.invoke` / `modelWithTools.invoke` directly and rely on the SDK's own bounded retry.

Intentional behaviour changes:
- `document-generator`, `story-breakdown` and `backlog-updater`'s node-retry backoff moves from 1000/2000/4000 ms to 500/1000/2000 ms, capped at 4000 ms (matching the delay shape `prompt-enhancer` and `project-document-generator` already used).
- `backlog-updater`'s retry predicate now also matches "JSON parse error" and "network" in the error message, which it previously did not check for.

The JSON-parse predicate keeps matching "Failed to parse tool call arguments as JSON" even though the installed SDKs never throw that exact string as an `Error` today (it only shows up as the `.error` field of an `invalid_tool_call` block in streaming paths these agents don't use) — it's cheap to keep and some agents use it to pick a larger retry ceiling.
