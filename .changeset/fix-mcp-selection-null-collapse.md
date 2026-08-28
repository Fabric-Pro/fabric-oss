---
"fabric-app": patch
---

Stop an unrestricted MCP selection collapsing to the managed defaults, so a chat runs with every server the user has enabled rather than only Excalidraw

Follow-up to Fizzy #2040, and a different bug from the fair-share tool budget shipped in v1.14.0 — that fix works; this one sits upstream of it, in the route.

`enabledMcpConfigIds` is a three-state contract, documented on `getDetailedMcpToolInfo` in `@repo/agent-core`: `null`/`undefined` means "no filter, every enabled config for the tenant", `[]` means "the user explicitly disabled all MCP servers", `[ids]` means "exactly these". Both chat routes union managed-default servers (`mcpServer.defaultEnabled && isSystemProvided`, i.e. Excalidraw) into the caller's set so those stay reachable. Both did it with `Array.isArray(x) ? x : []` before spreading — which folds states 1 and 2 into state 3 and hands the workflow *only* the defaults. "All my servers" and "none of my servers" both became "just Excalidraw".

Confirmed from production Temporal history, two chats eight minutes apart, same six-server control deck, same org, same user. The failing run's `preloadMcpToolsForConfigsActivity` was scheduled with a single id — the managed default — while the working run carried all six and returned 176 tools across four servers. No activity failed and nothing was capped; the selection simply never arrived. The model then correctly reported it had no tools for the connected server, and the control deck showed 6/6 green throughout because it renders local state and never sees the workflow input.

The union now runs only when the caller actually restricted the set, which is the rule the prioritized-ids union sitting twenty lines below it already followed. Unrestricted callers lose nothing: "every enabled config" contains the managed defaults by definition.

Extracted to one shared `unionDefaultMcpConfigIds` helper rather than fixing the same expression twice — the duplication is why the defect existed in both engines identically.

Behaviour change worth naming: `[]` previously came back as `[<default>]`, so a user who had disabled every MCP server still silently got Excalidraw. It now stays empty, which is what the contract says and what the toggle implies.

Tests: 7 pinning all three states, mutation-checked — restoring the old fold fails exactly the `null`, `undefined` and `[]` cases and leaves the other four green. Route-layer only; `packages/temporal` is untouched, so no worker rollout is required.
