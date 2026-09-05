---
"fabric-app": patch
---

Type-check all seven LangChain agents in CI; fix the zod 3 tool-schema blow-up that made two of them impossible to check (Fizzy #2383)

Seven agents under `agents/langchain/` had no `type-check` script (`weave-readers` and `weave-shuttle` had one misnamed `typecheck`, which turbo's `type-check` task never matched), so the root type-check silently skipped them and a type-level regression in a dependency bump could ship unseen.

The card's diagnosis (the include pulls `@repo/agent-core` and the whole dependency graph) did not hold up: `agent-core`'s full source checks in 25 s, and each `@repo/*` import in isolation checks in under 3 s. The real cause is `DynamicStructuredTool` from `@langchain/core` 1.1.x typed against a **zod 3.25** schema: core's own zod is 4.x, so every zod 3 schema goes through its v3 interop types and a single tool costs ~10 million type instantiations, 2.5 GB and 50 s (TS2589 "excessively deep"). `project-document-generator/nodes/tool-node.ts` builds seventeen of them and `data-analyst` builds eight, which is the OOM at 4/8/16 GB. Importing `z` from `zod/v4` (zod 3.25 ships v4 under that subpath; `packages/mcp-stdio-wrapper` already does this) drops project-document-generator to 4 s / 460 MB and data-analyst to 3 s / 790 MB with no package.json or lockfile change. Project references, narrower includes and a bigger heap would not have helped.

Making the check run exposed errors that were shipping unseen:
- `project-document-generator/unified-server.ts`: `AgentSkill` was imported from `@repo/agent-core/unified-server`, which does not export it (it comes from the root entry); and both `copilotkit` state literals lacked the `interceptedToolCalls` / `originalAIMessageId` fields CopilotKit 1.70 added to its annotation — exactly the kind of regression from the 1.70.1 upgrade (Fizzy #2376) the card was worried about.
- `project-document-generator/nodes/chat-node-tools.ts`: the `isToolMessage` guard's predicate type is wider than `BaseMessage`, so TypeScript never narrowed `m` and `m.tool_call_id` was an error.
- `data-analyst`: thirteen errors of its own (see the PR).
- `weave-readers`: its standalone tsconfig applied `noUnusedLocals` to `@repo/observability` sources it pulls in; it now extends `@repo/tsconfig/base.json` like `weave-planners`.

zod 4 API changes in data-analyst: `z.record(v)` → `z.record(z.string(), v)` (six sites), `.passthrough()` → `.loose()` (one site).
