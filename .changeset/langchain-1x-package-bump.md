---
"fabric-app": patch
---

Update the LangChain 1.x packages (core, langgraph, openai, anthropic, groq, sdk) to their current releases.

Fizzy #2423. Coordinated bump across the ten LangGraph agent workspaces, `@repo/agent-core`
and `@repo/temporal`:

| package | old | new |
|---|---|---|
| `@langchain/core` | ^1.1.24 | ^1.2.9 |
| `@langchain/langgraph` | ^1.1.4 | ^1.4.14 |
| `@langchain/openai` | ^1.2.7 / 1.2.7 | ^1.5.11 / 1.5.11 |
| `@langchain/anthropic` | ^1.3.17 | ^1.5.9 |
| `@langchain/groq` | 1.1.0 | 1.3.1 |
| `@langchain/langgraph-cli` | 1.1.13 | 1.4.5 |
| `@langchain/langgraph-sdk` | ^1.6.2 | ^1.10.2 |
| `@langchain/mcp-adapters` | ^1.1.3 | ^1.1.4 |

Three vendor SDKs move a major underneath those: `openai` 6.22.0 -> 7.10.0,
`@anthropic-ai/sdk` 0.73.0 -> 0.120.0 and `groq-sdk` 0.19.0 -> 1.6.0. No source change
was needed for any of them — every `ChatOpenAI` / `AzureChatOpenAI` / `ChatGroq` /
`ChatAnthropic` construction site in `packages/agent-core` type-checks unchanged, and the
`configuration: { baseURL, fetch }` option survives the openai 6->7 move intact.

The `modelKwargs` + `__includeRawResponse` gateway reasoning workaround in
`packages/agent-core/src/services/langchain-models.ts` is still required at 1.5.11 and is
kept: `__includeRawResponse` still reaches the converter, and the completions converter
still records only `message.reasoning_content`, never the gateway's
`choices[].message.reasoning`. Only the dist line citations are refreshed (the converter
also moved to `dist/converters/completions.cjs`), plus the same stale version marker in
`output-truncation.ts`.

`@langchain/langgraph@1.1.4` and `langchain@1.2.10` stay in the tree as transitives of
`@ag-ui/langgraph` / `@copilotkit/runtime`, which pin their own ranges; both now resolve
against `@langchain/core@1.2.9`, so the duplicate `core@1.1.24` is gone.

Also raises `node_version` from 20 to 22 in the `task-planner` and `story-breakdown`
`langgraph.json` files (the only two that declare it), matching the repo's Node engine
floor.

The lockfile change is hand-merged rather than a full regeneration: re-resolving this
workspace with pnpm 11.25.0 rewrites ~4000 lines that have nothing to do with LangChain
(`libc:` metadata on 99 platform binaries, `supports-color` optional-peer suffixes on 784
sites, zod peer flips on `@ai-sdk/*`, and `@better-auth/passkey`'s exact peers). Only the
LangChain closure is taken from the new resolution.
