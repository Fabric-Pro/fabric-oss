---
"fabric-app": patch
---

Reuse the document generator's tool definitions across a generation run instead of rebuilding them on every tool call.

Fizzy #2427. `nodes/tool-node.ts` previously defined ~18 `create<Name>Tool(state, aiToken)` factories that each returned a fresh `DynamicStructuredTool` closing over that invocation's `state`/`aiToken`, and `toolNode()` re-ran every applicable factory plus constructed a brand-new `ToolNode` on every single tool-node invocation of the graph.

LangChain 1.x's `tool()` helper (from `@langchain/core/tools`) hands a tool function a `ToolRuntime` on every call, carrying that invocation's graph `state` and its `RunnableConfig` (so `runtime.configurable?.ai_token` gives the run's AI token) — the reason the per-call rebuild existed. Every tool is now a `tool()` instance built once at module scope, reading `runtime.state` and a new `getAiToken(runtime)` helper instead of closure variables.

Per-call tool-list gating (Teams/Slack/repo integrations, and `write_document_asset` when an active skill + document are present) still applies — `chat-node.ts`'s `model.bindTools(...)` documents that a gateway can still return a call to a tool that was never offered, so `toolNode()` must keep rejecting those rather than executing them. What changed is how: the four gate booleans are combined into a cache key (at most 16 combinations), and a small `Map<string, ToolNode>` builds one `ToolNode` per combination on first use and reuses it after — so gating is preserved with zero tool or `ToolNode` construction on the common path of repeated calls with the same gates.

Pure refactor otherwise: tool names, descriptions, zod schemas, request URLs/bodies/headers, log lines, and return strings are unchanged. Added `__tests__/tool-node-runtime.test.ts`, exercising `toolNode` through the real `ToolNode` against a mocked `fetch` to prove state and the AI token come from the per-invocation `ToolRuntime`, that a disallowed tool call still gets rejected as "not found" without touching the network, and that the `ToolNode` cache is reused rather than rebuilt per call.
