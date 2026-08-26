# Agent Skills — progressive-disclosure rollout

## Status

**Partially shipped.** The document-generation path (Temporal → `project_document_generator` LangGraph agent) can use Anthropic Agent Skills today, but:

- The skill is **eager-inlined** into every ARCHITECTURE-doc prompt (SKILL.md body + `assets/template.html` body, ~13 KB of overhead per request), whether the model needs it or not.
- The model has no way to **list** or **load** other skills on demand — only the pre-resolved `activeSkill` is visible.
- The **AI Assistant** (CopilotKit sidebar inside `DocumentEditor`) bypasses the Temporal activity, so `state.activeSkill` is never populated there and skills are invisible to the assistant.

This doc captures the work needed to complete the [Anthropic progressive-disclosure contract](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) across both entry points: a minimal registry in the system prompt, plus three tool calls (`list_skills`, `load_skill`, `read_skill_file`) that fetch skill content **only when the model decides it needs them**.

## Why

- **Surface parity.** An architecture doc generated from the wizard should have the same skill affordances as one edited from the AI Assistant. Today the two paths diverge.
- **Prompt size.** Eager-inline of a single skill is cheap, but the design blocks scaling to 10+ system skills or per-org skills without blowing the context budget.
- **Model autonomy.** The user explicitly asked: *"I don't want to force the LLM to use the architecture diagram generation skill. It should use it if it feels necessary."* Progressive disclosure implements that: the registry is a one-line advertisement, the heavy content is loaded only when the model opts in.
- **New-skill cost.** Adding a second skill today would require a new DOCUMENT_TYPE_SKILL_SLUGS entry, a new prompt template, and another round of eager-inline plumbing. With the progressive-disclosure tools wired, adding a skill is a seed-script entry plus nothing else — the registry refreshes automatically.

## Current state (as of this branch)

| Piece | Where | Status |
|---|---|---|
| `Skill` + `SkillFile` catalog | `packages/database/prisma/schema.prisma` | ✅ in place |
| Seed for `architecture-diagram` SYSTEM skill | `packages/database/prisma/seed-skills.ts` | ✅ seeded |
| Skill runtime (loader, tools, prompt fragments) | `packages/ai/skills/{loader,tools,prompt-fragment}.ts` | ✅ |
| Durable direct-chat registry + tools | `packages/temporal/src/activities/direct-chat/ai-execution.ts` | ✅ wired (used by **Fabric AI sidebar**) |
| Nexus orchestrator chat | `packages/temporal/src/activities/orchestrator/execution/run-agent-iteration.ts` | ❌ **not wired** (used by Nexus + agent `@mentions`) |
| Doc-gen activity resolves `activeSkill` | `packages/temporal/src/activities/project-document-generation.ts` | ✅ — but eager-inlines SKILL.md + template.html into state |
| Agent eager-inline block + `write_document_asset` tool | `agents/langchain/project-document-generator/{prompts/index.ts, nodes/chat-node.ts}` | ✅ — but only `write_document_asset`, no `list_skills` / `load_skill` / `read_skill_file` on the agent |
| Asset upload endpoint | `apps/web/app/api/internal/document-assets/route.ts` | ✅ |
| Doc viewer renders `ProjectDocumentAsset` in sandboxed iframe | `apps/web/modules/saas/projects/components/DocumentAssetFrame.tsx` | ✅ |
| **AI Assistant (CopilotKit) sees skills** | — | ❌ **not wired** |
| **Agent can list/load skills on demand** | — | ❌ **not wired** |

## Constraint: agents can't import `@repo/ai`

The LangGraph agents run in sandboxed Docker containers and consume a `tsup`-bundled `dist/unified-server.js`. `@repo/ai/skills` depends on `@repo/database` and `@repo/storage`, which the agent container can't link to. So the agent must talk to skills **over HTTP**, the same way `write_document_asset` already POSTs to `/api/internal/document-assets`.

## Target architecture

```
┌─────────────────────────────────────────┐         ┌─────────────────────────────────────────┐
│ agent container                         │         │ apps/web                                │
│                                         │         │                                         │
│  chat_node binds 4 tools:               │         │  POST /api/internal/skills/list         │
│    list_skills()       ────HTTP────────▶│─────────▶ POST /api/internal/skills/load          │
│    load_skill(slug)    ────HTTP────────▶│─────────▶ POST /api/internal/skills/read-file     │
│    read_skill_file()   ────HTTP────────▶│─────────▶ POST /api/internal/document-assets      │
│    write_document_asset────HTTP────────▶│                                                   │
│                                         │         │  All endpoints: X-AI-Token auth,        │
│  System prompt: 1 line/skill registry   │         │  tenant-scoped via token claims,        │
│  (no eager-inline of SKILL.md bodies)   │         │  delegate to @repo/ai/skills runtime    │
└─────────────────────────────────────────┘         └─────────────────────────────────────────┘
```

Both the Temporal doc-gen path and the CopilotKit assistant path invoke the same agent with the same tool surface. Skill resolution is pulled by the model, not pushed by the caller.

## Work to do

### 1. Internal web-app endpoints

Create three new route handlers under `apps/web/app/api/internal/skills/`. All use the `X-AI-Token` JWT auth pattern from `apps/web/app/api/internal/document-assets/route.ts` (see `verifyAIToken` from `@repo/ai-token`). Tenant context (`userId`, `organizationId`) comes from token claims, not the request body.

| Route | Body | Response | Notes |
|---|---|---|---|
| `POST /api/internal/skills/list` | `{}` | `{ skills: SkillSummary[] }` | Delegates to `listAvailableSkills(ctx)` from `@repo/ai/skills`. Returns slug, name, description, version, category, tags, and file manifest. |
| `POST /api/internal/skills/load` | `{ slug: string }` | `SkillBundle` | Delegates to `loadSkillBundle(slug, ctx)`. Returns `skillMd` (frontmatter stripped) + manifest. |
| `POST /api/internal/skills/read-file` | `{ slug: string, path: string }` | `SkillFileContent` | Delegates to `readSkillFile(slug, path, ctx)`. Returns `{ contentType, encoding, data, sizeBytes }`. Respects `MAX_SKILL_FILE_READ_BYTES` (256 KB) — errors on overflow. |

Keep them thin. The existing `@repo/ai/skills` runtime already enforces scope filtering, caching, and size limits — the route handlers just verify the token and invoke the runtime function.

### 2. Agent-side tool bindings

In `agents/langchain/project-document-generator/nodes/chat-node.ts`:

- Bind `list_skills`, `load_skill`, `read_skill_file` with Zod schemas mirroring `packages/ai/skills/tools.ts`. Handlers POST to the new endpoints, forwarding the AI token header.
- Keep `write_document_asset` binding (existing).
- Drop the `state.activeSkill && state.documentId` precondition — tools should bind whenever the agent has a valid AI token (i.e. always, in practice).

The tools become **server-side tools** (route to `tool_node`) just like `write_document_asset` already does, so no routing changes in `agent.ts` are needed — the existing `shouldContinue` logic handles them.

### 3. Registry in system prompt

Replace the current eager-inline skill block in `prompts/index.ts` (`buildSkillBlock` + `ACTIVE_SKILL_TOOL_INSTRUCTIONS`) with a minimal registry:

```md
## Available Skills

The following skills are available. Call `load_skill(slug)` to fetch the full instructions, then `read_skill_file(slug, path)` for any referenced asset, then `write_document_asset(...)` to persist generated artifacts.

- architecture-diagram: Generate dark-themed self-contained HTML/SVG system architecture diagrams.
- <slug>: <description>
```

The registry needs the list of skills in scope. Two options for sourcing it:
- **(a)** Pre-fetch in the Temporal activity and pass as `state.availableSkills: SkillSummary[]`. This keeps the pattern symmetric with today's `activeSkill` hand-off.
- **(b)** Have the agent call `list_skills` itself at the start of every run. This is the cleanest progressive-disclosure shape but adds one RTT per run.

Prefer (a) for the Temporal path (the activity has the DB anyway) and (b) for the CopilotKit path (where the caller can't pre-resolve). Since the agent can't tell the two apart, make it `(a) or (b)` depending on whether `state.availableSkills` is already populated.

### 4. Remove eager-inline

In `packages/temporal/src/activities/project-document-generation.ts`:

- Replace `resolveActiveSkillForDocumentType` (returns a fully-loaded `SkillBundle` with file bodies inlined) with a simpler `listSkillsForDocumentContext` that returns `SkillSummary[]` only.
- Pass into the stream input as `availableSkills`, not `activeSkill`.
- Drop the `isTextContentType` filter and the `EAGER_SKILL_FILE_MAX_BYTES` constant — no longer needed.
- Drop `DOCUMENT_TYPE_SKILL_SLUGS`. The model decides which skill to use based on the registry and its own judgment.

In `agents/langchain/project-document-generator/state/index.ts`:

- Replace the `activeSkill: Annotation<{ slug, skillMd, files }>` field with `availableSkills: Annotation<SkillSummary[]>`.
- Keep `documentId` — still needed by `write_document_asset`.

In `agents/langchain/project-document-generator/unified-server.ts`:

- Replace the `activeSkill` forward with `availableSkills`.
- Optional: if `availableSkills` is missing from input (CopilotKit path), have the unified-server call `list_skills` itself before invoking `projectDocumentGeneratorGraph.stream()` so the system prompt can render the registry on the first turn.

### 5. Drop the loop-back / forcing shim

Already removed from `chat-node.ts` as part of the "make the skill advisory" change. This refactor keeps it out.

## Out of scope for this doc

- Admin UI for creating / editing user-scope or org-scope skills. An earlier architecture-review plan for this repo explicitly deferred it, and it stays deferred.
- Per-`RegisteredAgent` skill filtering. Current design exposes all in-scope skills to any agent that chooses to query them.
- Skill version pinning. Always serves `Skill.version` latest.
- Sidekick `suggest_skills` tool.
- Anthropic native skills API (`client.beta.messages.create({ container: { skills } })`) — bypasses Vercel Gateway + forks `streamText`. Revisit if/when Gateway integration lands.

## Acceptance

A single ARCHITECTURE-doc regeneration and a single AI-Assistant edit both produce the following trace signals:

**Regeneration (Temporal → agent):**
```
[activity] listed 1 skill (architecture-diagram) for documentType=architecture
[agent chat_node] boundTools: [..., list_skills, load_skill, read_skill_file, write_document_asset]
[agent chat_node] System prompt contains "## Available Skills" block (no SKILL.md body inline)
[model] → load_skill("architecture-diagram")
[ToolNode] POST /api/internal/skills/load → 200
[model] → read_skill_file("architecture-diagram", "assets/template.html")
[ToolNode] POST /api/internal/skills/read-file → 200
[model] → write_document_asset(...)
[ToolNode] POST /api/internal/document-assets → 200
[model] → write_document_local(...) → END
```

**AI Assistant (CopilotKit → agent):**
Same signal sequence — no divergence. The unified-server auto-fetches `availableSkills` when the input doesn't carry it.

And the negative case: an AI-Assistant edit that doesn't need a diagram (e.g. "fix typo in section 3") produces **no** `load_skill` call and no asset write. The skill is available, not imposed.

## Touch list (rough)

```
NEW   apps/web/app/api/internal/skills/list/route.ts
NEW   apps/web/app/api/internal/skills/load/route.ts
NEW   apps/web/app/api/internal/skills/read-file/route.ts
MOD   agents/langchain/project-document-generator/nodes/chat-node.ts         — bind 3 new tools
MOD   agents/langchain/project-document-generator/nodes/tool-node.ts         — handlers that POST to /api/internal/skills/*
MOD   agents/langchain/project-document-generator/prompts/index.ts           — registry block (not eager-inline)
MOD   agents/langchain/project-document-generator/state/index.ts             — availableSkills: SkillSummary[]
MOD   agents/langchain/project-document-generator/unified-server.ts          — forward availableSkills; fallback-fetch when missing
MOD   packages/temporal/src/activities/project-document-generation.ts        — listSkillsForDocumentContext, drop eager-inline
```
