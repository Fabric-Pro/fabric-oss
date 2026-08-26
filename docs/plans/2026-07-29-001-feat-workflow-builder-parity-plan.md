---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: workflow-builder-audit
type: feat
title: "feat: Workflow builder — unify action registries, harden execution, close trigger/export gaps"
date: 2026-07-29
plan_depth: deep
branch: feature/workflow-builder-parity
origin_story: "Audit of fabric's visual workflow builder against the upstream vercel-labs/workflow-builder-template it was derived from"
related_docs:
  - apps/web/content/docs/features/workflow-builder.mdx
  - docs/adr
---

# feat: Workflow builder — unify action registries, harden execution, close trigger/export gaps

- **Audience**: Engineers working on the visual workflow builder
- **Owner**: Workflow Builder

## Summary

Fabric's visual workflow builder (`apps/web/modules/saas/workflows`, `packages/api/modules/workflows`, `packages/temporal/.../workflow-builder-execution.ts`) was derived from `vercel-labs/workflow-builder-template` and has since surpassed it on durability and governance: version history, publish/rollback, HMAC webhook triggers, preflight graph validation, human-in-the-loop approvals, MCP/browser/hybrid steps, multi-tenancy, and a read-only write gate.

It has fallen behind in one structural way, and that one thing causes most of the concrete defects below: **the upstream generates from a single source of truth what fabric maintains by hand in four places.** As a result ~20 integrations that are already built cannot be placed on a canvas, five step keys are ambiguous, ~2,000 lines of plugin-driven config UI are unreachable, and the declared step metadata on plugin actions is stale enough to be wrong.

This plan covers eight phases. Phases 1–3 are the value core; 4–8 close discrete feature gaps. Each phase is independently shippable, and the recommended PR grouping is in [Sequencing](#sequencing).

---

## Problem Frame

### Verified current state

**Four hand-maintained registries describe "what actions exist", and they have drifted.**

| Source | Count | Consumed by |
|---|---|---|
| `lib/plugins/*/index.ts` | 28 plugins / ~68 actions | `getAllActions()` (`registry.ts:118`) — **exported, never called by any UI** |
| `lib/node-definitions.ts` | 18 node types | `WorkflowBuilder.tsx:793` (Actions tab, rendered `:1339`), `NodeConfigEditor.tsx:33`, `NodePalette.tsx` |
| `WorkflowBuilder.tsx:151` `nodeTypes` | 18 + 2 placeholders | React Flow renderer map |
| `activities/lib/step-registry.ts` | 48 entries | `executeStep()` (`:471`) |

Consequences, each verified in the tree:

1. **~20 plugins are unreachable from the canvas.** Asana, Attio, Bitbucket, Canva, ClickUp, Confluence, Databricks, Freshservice, Front, GitLab, Google Drive, HubSpot, Intercom, Jira, Microsoft Teams, NHTSA, Notion, Resend, Salesforce and Zendesk have full plugin definitions — and roughly twelve of them have working executors in `activities/lib/steps/` — but no `nodeDefinitions` entry, so no user can add them to a workflow.

2. **Six plugins have UI definitions with no executor at all**: `confluence`, `databricks-vector-search`, `google-drive`, `microsoft-teams`, `nhtsa-vpic`, `notion`.

3. **Eight steps across five integrations are registered under bare, vendor-less keys**: `create-task` / `list-tasks` (Asana), `create-record` / `search-records` (Attio), `create-conversation` / `list-conversations` (Front), `list-designs` (Canva), `create-ticket` (Freshservice). `getNodeType()` (`registry.ts:111`) produces `asana-create-task`, so these never match; and `findActionById` (`registry.ts:160`) falls back to matching a bare `action.slug`, making `create-ticket` genuinely ambiguous across Linear, Zendesk and Freshservice — resolved by `Map` iteration order.

4. **Drift fails open.** `executeStep()` returns `{ success: true, output: { skipped: true } }` for an unknown node type (`step-registry.ts:476-481`). A workflow referencing a missing step reports a green run that did nothing.

5. **Declared step metadata is wrong.** `stepFunction` / `stepImportPath` on plugin actions were copied verbatim from upstream and never reconciled: Linear declares `createLinearTicketStep` / `create-ticket`, the actual export is `executeLinearCreateTicketStep` in `linear-create-ticket.ts`. Same for GitHub (`createIssueStep` vs `executeGithubCreateIssueStep`) and Asana. Only Zendesk happens to match. Nothing reads these fields today, which is why it went unnoticed.

6. **The plugin-driven config path is dead code.** `ActionConfigPanel.tsx` (494 lines), `TemplateInput.tsx` (370), `SchemaBuilder.tsx` (520), `OutputDisplay.tsx` (347), `IntegrationTestPanel.tsx` (210) and `NodePalette.tsx` (115) have zero consumers outside the `components/index.ts` barrel. `ActionConfigPanel` itself has its `TemplateInput` and `SchemaBuilder` imports commented out (`:40-41`), so `template-input` and `schema-builder` field types currently degrade to plain inputs.

**Execution engine.**

7. `workflow-builder-execution.ts:22-32` applies `maximumAttempts: 3` to *every* node, including `linear-create-ticket`, `slack-send`, `email-send`, `github-create-issue`. An activity that succeeds externally but fails on the return path duplicates the ticket / message / email. The set needed to fix it already exists: `EXTERNAL_WRITE_NODE_TYPES` (`step-registry.ts:432`).

8. Execution is strictly sequential: a single queue re-pushes not-ready nodes and `await sleep(100)` (`:224-225`). Independent branches never overlap, and every not-ready dequeue writes a timer into workflow history. With `skipPreflightValidation: true` the loop is also unbounded on a cyclic graph.

9. Node config is `console.log`ged in full — `JSON.stringify(stepConfig, null, 2)` at `:286` — inside the *workflow*, so it also prints on every replay. `activities/lib/redact-sensitive-data.ts` exists but is not applied here.

10. No node enable/disable. Upstream supports `data.enabled === false` → skip node, continue downstream.

**Missing surfaces.**

11. **No cancel.** `packages/api/modules/workflows/router.ts` has no cancel procedure. Executions start as Temporal workflow id `workflow-execution-${execution.id}` on task queue `workflow-builder` (`start-execution.ts:129-133`), so cancellation is straightforward — it simply does not exist.

12. **Schedule trigger is a dead option.** The trigger node offers `schedule` (`node-definitions.ts:31`) and `generate-from-prompt.ts:36` instructs the model to emit `scheduleExpression`, but nothing creates a Temporal Schedule on save. Choosing "Schedule" silently does nothing. `packages/temporal/src/schedules/url-source-schedule.ts` is the in-repo precedent for per-entity user schedules.

13. **Workflow API keys cannot be created.** `WorkflowApiKey` exists in `schema.prisma:8517` and the webhook route verifies bearer tokens against it (`api/workflows/trigger/[workflowId]/route.ts:92-135`), but no procedure or UI ever writes a row — that auth branch is unreachable. The HMAC path works (provisioned by `publish-workflow.ts:185`).

14. **Export/codegen is a stub.** `generate-code.ts` is 402 lines of hand-written `switch` covering 12 of ~68 actions, and most cases emit comments rather than code (`results["x"] = { title: "..." }`).

15. **Six upstream integrations have no fabric equivalent**: `blob`, `clerk`, `stripe`, `superagent`, `v0`, `webflow` (16 actions).

### Robustness, as distinct from feature parity

"As robust as upstream" understates fabric on one axis and overstates upstream on another: upstream has **zero unit tests**, fabric has ~4,700. Upstream's robustness comes from generation (the registries cannot disagree), 14/14 plugin connection tests, and one e2e smoke spec. Fabric hand-joins its registries and has almost no coverage of the layer where integration behaviour actually lives.

16. **The output contract was unenforced, and five actions broke it.** A plugin's `outputFields` is exactly what the builder offers in its `{{Node.field}}` autocomplete; the value comes from whatever the step returns. Nothing checked they agreed. `linear/create-ticket` advertised `id` and returned `issueId`; `slack/send-message` advertised `ok`/`ts` and returned `channel`/`timestamp`; `resend/send-email` advertised `id` and returned `emailId`; `firecrawl/scrape` advertised `html`/`description` that were never fetched and a `title` only reachable at `metadata.title`; `firecrawl/search` advertised a `count` it never set.

17. **An unresolved reference used to be delivered verbatim.** `interpolateTemplate` returned the literal `{{...}}` text, so a workflow filing a Linear ticket and posting its ID to Slack posted the string `{{Create Linear Ticket.id}}` — no error, no empty value, a green run with corrupt output. Upstream `lib/utils/template.ts` behaves identically, so this is a place to be better than upstream, not to match it.

18. **`stepFunction`/`stepImportPath` were wrong on 24 of 40 wired actions** — copied verbatim from upstream and never reconciled, pointing at functions that do not exist in fabric. Nothing read them, so nothing noticed. The remaining 28 actions declared bindings to steps that do not exist at all.

19. **The step layer is ~4% tested**: 51 step files, 2 tests. Each step is a bespoke HTTP client with its own auth, error mapping and output shape.

20. **The builder had no e2e coverage** — 20+ Playwright specs in `apps/web/tests/`, none touching it — and **zero `data-testid` hooks** in the entire workflows module, so any spec would have rested on brittle text selectors.

21. **No execution bounds.** No `workflowExecutionTimeout`/`workflowRunTimeout` on `client.workflow.start` (`start-execution.ts:129`), no max-node check in `workflow-validation.ts`, no per-tenant concurrency cap, and `workflowId` is `workflow-execution-${execution.id}` — unique per row, so the same workflow can be started unboundedly in parallel. The webhook route's 60/min limiter is an in-process `Map`, so it does not hold across instances.

22. **Credential access has no chokepoint**: 33/51 steps use `fetchCredentialsByProvider`; 8 diverge (`ai-generate-*`, `firecrawl-*`, `gitlab-*`, `mcp-tool`). Some are legitimate — GitLab resolves OAuth tokens via `gitlab-resolver` — but there is no single place to add token rotation, expiry handling or credential-access audit.

Two things that looked like gaps and are not, recorded so they are not re-raised: Confluence has an inline credential test rather than a `test.ts`, and Databricks / Google Drive / Teams / Notion set `skipClientTest` deliberately because verification happens through OAuth status. The real gap was that nothing *enforced* the choice.

---

## Requirements

| ID | Requirement | Source |
|----|-------------|--------|
| R1 | Exactly one authored source of truth describes an action. Palette entries, React Flow node types, config fields and the executor registry are all derived from it. | #1–#6 |
| R2 | It is impossible to merge a plugin action that has no executor, or an executor with no plugin action, without a failing test. | #1, #2 |
| R3 | Every step key is namespaced by integration; no bare slugs; existing saved workflows referencing legacy keys keep working. | #3 |
| R4 | An unknown node type fails the execution instead of reporting success. | #4 |
| R5 | Non-idempotent external-write actions are never automatically retried. | #7 |
| R6 | Independent branches execute concurrently; in-flight executions keep replaying. | #8 |
| R7 | Node configuration is never logged unredacted. | #9 |
| R8 | A node can be disabled without deleting it. | #10 |
| R9 | A running execution can be cancelled from the UI. | #11 |
| R10 | A workflow with a Schedule trigger actually runs on its cron, and the schedule is reconciled on save/publish/unpublish/delete. | #12 |
| R11 | Workflow API keys can be created, listed, revoked; the raw key is shown once. | #13 |
| R12 | Generated code is executable, covers every action, and is derived from the same source as R1. | #14 |
| R13 | The six missing integrations are available with executors and tests. | #15 |
| R14 | Every field an action advertises in `outputFields` is a field its step actually returns, asserted per action. | #16 |
| R15 | An unresolved `{{...}}` reference never reaches an external system as text. | #17 |
| R16 | An action's step binding is either truthful or absent; an action with no executor is not offered in the palette. | #18, E |
| R17 | The builder has e2e coverage of the save/load round-trip, resting on stable test hooks. | #20 |
| R18 | A single workflow execution cannot consume unbounded time, nodes, or concurrency. | #21 |

---

## Cross-cutting constraints

These apply to every phase and are non-negotiable in review.

- **Temporal determinism.** `workflow-builder-execution.ts` is a registered workflow with recorded histories and a CI replay gate (`packages/temporal/__tests__/replay-validation.test.ts`, `.github/workflows/temporal-replay-validation.yml`). Changes that alter the *command sequence* (Phase 6 parallelism, node skipping) **must** be gated with `patched()`, following the precedent in `agent-supervisor.ts:486-490` and `coding-run-workflow.ts:444-454`. Changes that only alter activity timeout/retry options are replay-safe — see the note in `atlas.ts:46` — so Phase 2 needs no patch.
- **Multi-tenancy.** Every new procedure resolves tenant via `resolveOrganizationId` + `requirePermission`, and copies `userId`/`organizationId` onto any new row, per `AGENTS.md`.
- **Read-only gate.** Any new external-write step must be added to `EXTERNAL_WRITE_NODE_TYPES`; Phase 1's generator should emit that set rather than leaving it hand-maintained.
- **Database.** `prisma migrate dev` only, never `db push`. Run `pnpm --filter @repo/database generate` and `apply:rls` after tenant-table changes.
- **i18n.** New UI strings go through `next-intl` message catalogues (en + de), matching the existing workflow builder surfaces.
- **Codegen hygiene.** Generated files carry a `DO NOT EDIT` header, are committed, and CI asserts `git diff --exit-code` after regeneration.

---

## Phase 0 — Make the contract real *(implemented)*

**Goal:** R14, R15, R16, R17. The regression net that makes every later phase safe. Landed ahead of Phase 1 because Phase 1 makes 28 unrunnable actions clickable, and this is what stops that.

1. **Output contract.** Steps now return every field their plugin advertises, additively — `id` alongside `issueId`, `ts`/`ok` alongside `timestamp`, top-level `title` alongside `metadata.title` — so nothing that resolved before stops resolving. `html`/`description` were dropped from `firecrawl/scrape`: the scraper does not fetch them, and declaring a field that cannot exist is the defect.
2. **Unresolved references.** `interpolateTemplateWithDiagnostics` returns `{ text, unresolved }`; unresolved references interpolate to empty and are reported. `interpolateTemplate` keeps its signature for the ~47 call sites and warns. An empty value is recoverable and visible; a placeholder posing as data is neither.
3. **Truthful bindings.** `stepFunction`/`stepImportPath` corrected on all 40 wired actions and removed from the 28 without executors.
4. **Contract test** (`plugins/__tests__/action-executor-contract.test.ts`) asserts per action that the binding resolves to a real exported function and that every advertised output field is returned, with `ACTIONS_WITHOUT_EXECUTORS` as the explicit inventory. Plus plugin hygiene: distinct types, non-empty actions, and every plugin either offering a credential test or explicitly setting `skipClientTest`.
5. **e2e smoke spec** (`apps/web/tests/workflow-builder.spec.ts`) plus the `data-testid` hooks it needs, covering list → create → palette → add node → save → reload, and asserting executor-less actions are not offered. Never clicks Run, so no external side effect is possible.

Deliberately deferred: surfacing unresolved references per-node in the execution-log UI needs step-level plumbing through ~47 call sites; the warn is the interim signal.

---

## Phase 1 — One source of truth for actions

**Goal:** R1, R2. Delete `node-definitions.ts` as an authored file; derive everything from `lib/plugins/*`.

### Design — *revised during implementation: no code generator*

The plan called for porting upstream's `scripts/discover-plugins.ts`: an AST-based generator emitting committed artifacts into both packages. **That turned out to be unnecessary machinery.** What the requirement actually asks for (R1/R2) is that one authored source determines the palette, and that the palette and the executors cannot disagree. Two cheaper mechanisms cover it:

- **The frontend derives at runtime.** `node-definitions.ts` computes the palette from `getAllActions()` plus `system-nodes.ts`. It is client code reading an in-process registry — there is nothing to pre-compute. No generator, no committed generated files, no `git diff --exit-code` CI step, and drift is not merely detected but impossible.
- **The executor registry stays authored** in `packages/temporal`. It is already the single source for which steps exist; generating it from `apps/web` would introduce a cross-package codegen dependency for no benefit. Agreement is enforced instead by Phase 0's contract test, which checks both directions — every action resolves to a real exported step, and every step file is claimed by some action.

Upstream needs a generator because its steps are co-located with plugins and it emits export templates for standalone projects; fabric's are split across packages and it has a test suite. Keep the generator idea for Phase 7, where codegen templates genuinely have to be materialised.

An action is offered only when `stepImportPath`/`stepFunction` are set. Phase 0 removed the untruthful bindings from the 28 actions with no executor, which is what makes presence a reliable signal rather than a heuristic.

> **Node types must be read, never derived.** *(established in the `nodeType` groundwork commit)* Five actions are stored under names that predate the `<type>-<slug>` convention — `ai-generate-text`, `ai-generate-image`, `mcp-tool`, `email-send`, `slack-send`. A generator that derived them would rename the node in every saved workflow, and those are the most-used nodes in the product. `IntegrationAction.nodeType` now pins them; the generator must use `getAllActions()[].nodeType`, which already resolves pinned-then-derived. The invariant `nodeType === stepImportPath` for wired actions is asserted in the contract test — that is what lets one source emit both the palette entry and the executor registry key.

**Authored input** — `apps/web/modules/saas/workflows/lib/plugins/<name>/index.ts`, extended per action with the fields the palette needs today:

```ts
{
  slug: "create-ticket",
  label: "Create Linear Ticket",
  description: "...",
  category: "Productivity",
  icon: "TicketPlus",              // NEW — lucide key from iconMap, plugin icon still wins at render
  paletteCategory: "integrations", // NEW — triggers | ai | web | logic | integrations | notifications
  externalWrite: true,             // NEW — feeds EXTERNAL_WRITE_NODE_TYPES + retry policy
  defaultConfig: { ... },          // NEW — was nodeDefinitions.defaultData.config
  stepFunction: "executeLinearCreateTicketStep",  // CORRECTED
  stepImportPath: "linear-create-ticket",         // CORRECTED
  configFields: [...],
  outputFields: [...],
}
```

**Generated outputs** (all `DO NOT EDIT`):

| File | Contents |
|---|---|
| `apps/web/.../lib/generated/node-definitions.generated.ts` | `nodeDefinitions`, `nodeCategories`, `getNodeDefinition` — same public shape as today's `node-definitions.ts` |
| `apps/web/.../lib/generated/node-types.generated.ts` | `WorkflowNodeType` union; `GENERATED_NODE_TYPE_KEYS` for the React Flow map |
| `packages/temporal/src/activities/lib/generated/step-manifest.generated.ts` | `nodeType → { integrationType, slug, stepImportPath, stepFunction, externalWrite }` + `EXTERNAL_WRITE_NODE_TYPES` |

System nodes (`trigger`, `condition`, `http-request`, `mcp-tool`, `browser-*`, `hybrid-step`) are not plugin-backed. Keep them in a small authored `lib/system-nodes.ts` that the generator merges — mirroring `SYSTEM_ACTIONS` in the upstream `action-grid.tsx`.

### Steps

1. ~~**Parity test first.**~~ **Done in Phase 0** — `plugins/__tests__/action-executor-contract.test.ts` is the R2 guard: binding truthfulness, output-field coverage, distinct node types, `nodeType === stepImportPath`, forward and reverse executor coverage.
2. ~~Correct `stepFunction` / `stepImportPath`~~ **done in Phase 0.** Still to do: add `icon`, `paletteCategory` and `defaultConfig` per action, porting values out of `node-definitions.ts` for the 15 plugin-backed types that have them and authoring the rest. `externalWrite` can be derived from `EXTERNAL_WRITE_NODE_TYPES` rather than re-authored.

   **`configFields` do not need to move.** Only `perplexity/search` is missing a field its `nodeDefinitions` entry has (`systemPrompt`); every other plugin-backed action's `configFields` already cover their `nodeDefinitions` counterpart. So generated palette entries need palette metadata only (type, label, description, icon, category, defaultData) — the config UI comes from the plugin action via `ActionConfigPanel`. That keeps the generator small and lossless.

   Only **three** current `nodeDefinitions` entries are true system nodes with no plugin: `trigger`, `http-request`, `condition`. Their authored `ConfigField`s stay in a small `lib/system-nodes.ts` and keep rendering through `NodeConfigEditor`. `browser-*`, `hybrid-step` and `fabric-enrichment` have executors but no plugin and are deliberately not builder actions — they stay out of the palette (asserted by `NON_ACTION_STEPS` in the contract test).
3. Write `scripts/generate-workflow-registries.ts` (model on upstream `scripts/discover-plugins.ts`, ~860 lines; fabric's version is smaller because it emits three files, not six). Uses `typescript` `createSourceFile` + object-literal walking. Fails loudly on a duplicate `nodeType`, a missing `stepImportPath`, or a step file that does not export the declared function.
4. Add `pnpm generate:workflow-registries`; wire into `apps/web` `predev`/`prebuild` and `packages/temporal` `predev`, plus a `turbo.json` task. Add a CI step asserting `git diff --exit-code` after regeneration.
5. Replace `lib/node-definitions.ts` with a re-export of the generated module so existing importers (`WorkflowBuilder`, `NodeConfigEditor`, `index.ts`, tests) keep compiling; delete the authored array.
6. Build the React Flow map from `GENERATED_NODE_TYPE_KEYS` instead of the literal at `WorkflowBuilder.tsx:151` — `Object.fromEntries(keys.map(k => [k, WorkflowNodeComponent]))` plus the two placeholders.
7. Replace the hand-written `stepRegistry` object with one built from the generated manifest, keeping the lazy `load()` shape so imports stay statically analysable for the worker bundle.
8. **Wire the dead UI.** Point the properties panel at `ActionConfigPanel` when `findActionById(node.type)` resolves, falling back to `NodeConfigEditor` for system nodes. Restore the commented-out `TemplateInput` / `SchemaBuilder` imports (`ActionConfigPanel.tsx:40-41`) so `template-input` and `schema-builder` field types render properly. Wire `OutputDisplay` into `ExecutionPanel` using each action's `outputConfig`.
9. Replace the Actions-tab grid (`WorkflowBuilder.tsx:1339`) with a port of upstream `components/workflow/config/action-grid.tsx`: `getAllActions()` + system actions, search, category grouping, per-integration hide/show. This is what makes the ~20 dark integrations reachable.

### Tests

- `action-parity.test.ts` (above) with `KNOWN_GAPS` emptied of everything the phase fixes.
- Generator unit test: fixture plugin dir → expected emitted artifacts (snapshot).
- `integrations.test.ts` updated — it currently asserts against the authored array (`:361-429`).
- RTL test: Actions tab renders ≥ 60 actions and filters by search.

### Risks

- **Bundle size.** The action grid imports every plugin icon. Icons are already imported via the registry barrel, so this is neutral, but check the `/workflows/[id]` route bundle before/after.
- **`node-definitions.ts` public surface.** `apps/web/modules/saas/workflows/index.ts:25` re-exports it; keep the re-export shim in step 5 rather than touching call sites.

### Acceptance

Every plugin action **that has an executor** appears in the Actions tab, drops onto the canvas, and renders its plugin-declared config fields. Actions in Phase 0's `ACTIONS_WITHOUT_EXECUTORS` are **filtered out of the palette**, not merely annotated — offering an action that cannot run is worse than not offering it, and the Phase 0 e2e spec asserts their absence. `pnpm generate:workflow-registries` is a no-op on a clean tree.

Note for the generator: the action ID prefix derives from the plugin's `type`, not its folder name. `microsoft-teams/` declares `MICROSOFT_GRAPH`, so its actions are `microsoft-graph/*`.

---

## Phase 2 — Do not retry external writes

**Goal:** R5. Smallest change with the highest correctness payoff; ship first.

### Steps

1. In `workflow-builder-execution.ts`, add a second proxy alongside the existing one at `:22`:

```ts
const { executeWorkflowNode: executeExternalWriteNode } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: "10 minutes",
    heartbeatTimeout: "30 seconds",
    retry: { maximumAttempts: 1 },
  });
```

2. Select the proxy per node from the generated `EXTERNAL_WRITE_NODE_TYPES` (Phase 1) or, if shipping before Phase 1, the existing set at `step-registry.ts:432`. The set must be imported as a plain value — it already is workflow-safe (no I/O).
3. `mcp-tool` is gated by configured tool name in `executeWorkflowNode`, not by node type; treat it as external-write when its resolved tool is a write tool, matching the existing read-only-gate logic.

### Tests

- Workflow unit test (`@temporalio/testing` `TestWorkflowEnvironment`): a failing `linear-create-ticket` activity is invoked exactly once; a failing `http-request` is invoked three times.
- Replay: no `patched()` needed — activity option changes are replay-safe (`atlas.ts:46`). Confirm by running `pnpm --filter @repo/temporal test:replay`.

### Acceptance

A `slack-send` / `email-send` / `*-create-*` node that fails after its side effect lands produces exactly one external artefact.

---

## Phase 3 — Namespace step keys; fail closed on unknown

**Goal:** R3, R4.

### Steps

1. Rename the eight bare keys in `step-registry.ts` to their `<integration>-<slug>` form, matching `getNodeType()` output. After Phase 1 this falls out of generation; before it, do it by hand.
2. **Alias map for stored data.** Saved workflows are JSON `nodes` blobs that may contain the legacy bare types. Add `LEGACY_NODE_TYPE_ALIASES` consulted by `hasStep()`, `getStepInfo()` and `executeStep()`. It lives in a **workflow-safe** module (`workflows/lib/workflow-builder-nodes.ts`) alongside `EXTERNAL_WRITE_NODE_TYPES`, because Phase 2's retry routing needs the same classification from inside the durable workflow — and anything a workflow imports lands in the Temporal workflow bundle, so it cannot come from the step registry (whose lazy `import()`s pull in the database).
3. **Backfill script.** `packages/temporal/src/scripts/backfill-workflow-node-types.ts` (in `@repo/temporal`, not `@repo/database`, so it can import the alias map without a dependency cycle) rewriting `Workflow.nodes` and `WorkflowVersion.nodes`. `WorkflowExecution` has no `nodes` column, and `WorkflowExecutionLog.nodeType` is deliberately left alone — it records what actually ran. Idempotent, dry-run by default. Keep the alias map after backfill as a safety net for restored rows.
4. Rework `findActionById` (`registry.ts:160`) to try its four identifier shapes in strict priority order across the whole registry — action ID, node type, label, slug — instead of trying all four per action while walking plugin-by-plugin. The label and slug strategies must require a unique match; ambiguous identifiers return `undefined` with a diagnostic rather than an arbitrary plugin.
5. Change `executeStep()` (`step-registry.ts:476-481`) **and** the `hasStep` guard in the `executeWorkflowNode` activity (`activities/workflow-builder-execution.ts:198`) to fail closed. Both currently return `success: true`; the activity's guard runs first, so fixing only the registry would leave the hole open. Preflight validation already rejects unknown types when enabled; this closes the `skipPreflightValidation` path.

### Tests

- `findActionById("create-ticket")` throws / returns undefined rather than an arbitrary plugin.
- `executeStep("does-not-exist")` returns `success: false`.
- Backfill script test over a fixture workflow containing all five legacy types.

### Risks

Step 5 turns silently-green historical workflows red. That is the intent, but call it out in the PR and in release notes — a customer whose workflow "worked" may see it start failing.

---

## Phase 4 — Schedule trigger

**Goal:** R10.

### Design

Mirror `packages/temporal/src/schedules/url-source-schedule.ts` (create / update / delete + a reconcile workflow), not the upstream implementation. Fabric already has the per-entity schedule pattern; use it.

- Schedule id: `workflow-builder-${workflowId}`.
- Action: start `workflowBuilderExecutionWorkflow` on task queue `workflow-builder`, with Temporal generating the per-fire workflow id (`{scheduleId}-{scheduledTime}`) so a completed run never blocks the next tick.
- `overlap: ScheduleOverlapPolicy.SKIP` by default, configurable later.
- Schema: add `scheduleId String?` to `Workflow` (nullable, plus migration). Storing it in `triggerConfig` JSON would work but makes reconciliation unqueryable.

### Steps

1. Prisma migration adding `Workflow.scheduleId`; regenerate client.
2. `packages/temporal/src/schedules/workflow-builder-schedule.ts` — `buildWorkflowScheduleId`, `upsertWorkflowSchedule`, `deleteWorkflowSchedule`, cron validation (reject unparseable expressions with a field-level error).
3. Call the upsert/delete from `publish-workflow.ts`, `unpublish-workflow.ts`, `update-workflow.ts` and `delete-workflow.ts`. **Only published workflows get a live schedule** — a draft with a cron must not fire.
4. Trigger config UI: cron input with a human-readable "next 3 fires" preview and validation, in `NodeConfigEditor` / trigger config.
5. Reconcile workflow (`reconcile-workflow-builder-schedules`) on the system schedule list in `packages/temporal/src/schedules.ts`, to repair drift between DB and Temporal — same role `reconcile-url-source-schedules` plays.
6. Surface `scheduleExpression` from `generate-from-prompt.ts:36` into the trigger node config so AI-generated workflows populate it.

### Tests

- Publishing a workflow with a `schedule` trigger creates the Temporal schedule; unpublishing deletes it; changing the cron updates in place.
- Invalid cron is rejected at the procedure boundary.
- Reconcile removes an orphan schedule whose workflow was deleted.

---

## Phase 5 — Cancel a running execution

**Goal:** R9.

### Steps

1. `packages/api/modules/workflows/procedures/executions/cancel-execution.ts` — resolve tenant, verify workflow access, look up `WorkflowExecution.temporalWorkflowId` (written at `start-execution.ts:166`), call `handle.cancel()`, mark the row `CANCELLED` with `completedAt`/`duration`. Idempotent for already-terminal executions.
2. Register as `executions.cancel` in `router.ts`.
3. Handle `CancelledFailure` in `workflowBuilderExecutionWorkflow` so the `CANCELLED` status and partial `outputs` are persisted rather than surfacing as `FAILED` — use `CancellationScope.nonCancellable` around the final status write.
4. Cancel button in `ExecutionPanel` / `WorkflowRunHistory` for `RUNNING`/`PENDING` executions, with confirmation.

### Tests

- Procedure test: non-member gets `NOT_FOUND`; terminal execution is a no-op.
- Workflow test: cancellation mid-run persists `CANCELLED` plus the outputs of completed nodes.

---

## Phase 6 — Execution engine: parallelism, disable, redaction

**Goal:** R6, R7, R8. **This is the phase that needs `patched()`.**

### Steps

1. **Parallel branches.** Replace the queue + `sleep(100)` walk (`:203-227`) with the upstream recursive walk: a `visited` set, `Promise.all` over successors, and a join guard so a node with multiple incoming edges runs once all predecessors are done. Gate the new path:

```ts
const parallelWalk = patched("workflow-builder-parallel-walk-2026-07");
```

Keep the old loop in the `else` branch until recorded histories age out, then remove with `deprecatePatch`.

2. **Node enable/disable.** Under the same patch: `node.data.enabled === false` → record a null output, skip execution, continue to successors. UI: toggle in the node context menu and the config panel, plus dimmed node styling (upstream `action-node.tsx:268`).
3. **Redaction.** Delete the four `console.log` calls at `:279-289`, or route them through `redactSensitiveData` in the *activity*, not the workflow. Logging inside a workflow re-emits on every replay; use `log.debug` from `@temporalio/workflow` if workflow-side visibility is genuinely needed.
4. **Cycle safety.** With the recursive walk the `visited` set makes cycles terminate naturally, removing the unbounded-loop hazard on the `skipPreflightValidation` path.

### Tests

- Workflow test: a diamond graph (A → B, A → C, B → D, C → D) runs B and C concurrently and D exactly once.
- Disabled node is skipped and its successors still run.
- **Replay is the gate.** Capture histories from the current implementation into `packages/temporal/__tests__/__fixtures__/histories/workflowBuilderExecutionWorkflow/` *before* merging, and confirm `test:replay` passes with the patch in place.

### Risks

Highest-risk phase. The `patched()` discipline is the mitigation; do not merge without fixture histories in place.

---

## Phase 7 — Real code generation and project export

**Goal:** R12. Depends on Phase 1.

### Steps

1. Extend `scripts/generate-workflow-registries.ts` to emit `codegen-registry.generated.ts` from the step source files, following upstream `lib/codegen-registry.ts` — the generator lifts each step function body into a template string keyed by `integration/slug`. Actions without an extractable handler fall back to a clearly-marked TODO stub rather than a silent comment.
2. Rewrite `generate-code.ts` to compose from the generated templates + topological order, replacing the 402-line `switch`.
3. Add `GET /workflows/{id}/export` returning a zip of a runnable project: generated workflow file, per-step modules, `package.json`, `tsconfig.json`, `.env.example` derived from each plugin's `formFields[].envVar`, and a README. Port upstream `lib/next-boilerplate` as the skeleton.
4. Export button in the workflow toolbar, reusing `PublishDialog` patterns.

### Tests

- Golden-file test: fixture workflow → generated code, asserted to `tsc --noEmit` clean in a temp dir.
- Every action in the registry has either a real template or an explicit stub marker (no silent gaps).

---

## Phase 8 — Workflow API keys, and the six missing integrations

**Goal:** R11, R13. Two independent, low-risk workstreams; group into one PR.

### 8a — API keys

1. Procedures under `packages/api/modules/workflows/procedures/api-keys/`: `create`, `list`, `revoke`. Key format `wfk_<prefix>_<secret>` to match the parser at `trigger/[workflowId]/route.ts:96-101`; store `sha256` in `keyHash`, first 8 chars in `keyPrefix`; copy `userId`/`organizationId` from the parent workflow (the columns exist for tenant isolation).
2. Return the raw key **once** on create, never again.
3. Update `lastUsedAt` / `usageCount` on successful verification in the trigger route.
4. UI: an API Keys section in `PublishDialog` beside the existing webhook secret, with copy-once affordance and revoke.

No schema change — the model exists at `schema.prisma:8356`.

### 8b — Port six integrations

`blob`, `clerk`, `stripe`, `superagent`, `v0`, `webflow` — 16 actions. Per plugin: `index.ts` + `icon.tsx` + `test.ts` under `lib/plugins/`, executors under `activities/lib/steps/`, new provider values in **both** the Prisma `WorkflowIntegrationProvider` enum (`schema.prisma:8278`, needs a migration) and the mirrored `IntegrationType` union in `plugins/types.ts`, plus `externalWrite` flags for the write actions. The existing `packages/api/__tests__/integration-type-enum-parity.test.ts` guards that the two stay in sync.

Order by value: `stripe` and `resend`-adjacent messaging first, `v0`/`superagent` last. Each plugin lands with a `test.ts` connection check and a step unit test. Phase 1's parity test blocks any of them merging half-wired.

### Tests

- API key create → trigger webhook with bearer token → 200; revoked key → 401; wrong-tenant key → 401.
- Per-plugin: connection test, step happy path, step error mapping.

---

## Phase 9 — Execution bounds

**Goal:** R18. Nothing today limits what one execution, or one caller, can consume.

1. **Run timeout.** Set `workflowExecutionTimeout` on `client.workflow.start` (`start-execution.ts:129`) and on the schedule action from Phase 4. Pick a default that clears the worst legitimate graph (activities are already capped at 10 min each) and make it overridable per workflow via `Workflow.settings.timeout`, which the type already carries but nothing reads.
2. **Max nodes.** Add a node-count ceiling to `validateWorkflowBeforeExecution` (`workflow-validation.ts`), rejecting at save/publish rather than at run so the user finds out while editing.
3. **Concurrency cap.** Per-tenant in-flight execution limit, enforced in `start-execution` before the Temporal start. Fabric already has `OrganizationDeploymentQuota` / `UserDeploymentQuota` for agent deployments — follow that shape rather than inventing a second quota model.
4. **Shared rate limiter.** Replace the in-process `Map` in `api/workflows/trigger/[workflowId]/route.ts` with the Redis limiter used elsewhere, so the 60/min actually holds across instances.
5. **Step-level test harness.** Extend Phase 0's contract test into behavioural coverage per step: missing credential → `{success:false}` rather than a throw; upstream HTTP error → mapped error string; missing required config → validation failure. One table-driven file, not 51.

---

## Sequencing

Ten phases, six PRs, all on `feature/workflow-builder-parity` (or stacked branches off it):

| PR | Phases | Size | Status | Rationale |
|----|--------|------|--------|-----------|
| A | 2 + 3 | S | **done** | Correctness and data-integrity fixes with no UI surface. Ships independently of everything else. |
| A′ | 0 | M | **done** | The contract net. Must precede B, because B makes 28 unrunnable actions clickable. |
| B | 1 | L | **done** | The structural change. Landed without a code generator — see the revised design note. |
| C | 4 + 5 | M | | Two self-contained feature gaps. |
| D | 6 | M | | Isolated in its own PR because replay risk should not share a review with anything else. |
| E | 7 + 8 | M | | Depends on B; low risk. |
| F | 9 | M | | Execution bounds. Independent of B — can move earlier if load is a concern. |

Phase 3's backfill script must run in each environment between PR A and PR B.

---

## Open decisions

**The AI node's Model selector does nothing.** `ai-generate-text` offers a *required* `aiModel` field, but the step deliberately ignores it and uses the user's configured default for the SIMPLE task type, logging a note (`activities/lib/steps/ai-generate-text.ts:81-87`). That is a defensible product choice — model governance centralised in Settings → AI Models — but the builder still asks the user to choose, and then overrides them. Three options, none of which should be picked unilaterally:

1. Remove the selector and say where model choice lives.
2. Honour the workflow's selection when set, falling back to the configured default.
3. Keep it, relabel it as a preference, and surface the override in the run log.

**Step options the builder does not expose.** Several steps read config the UI never collects: `attio-search-records` and `clickup-search-tasks` (`limit`), `clickup-create-task` (`assignees`). Adding them is cheap and additive; they are listed here so the gap is deliberate rather than forgotten.

---

## Out of scope

- Migrating the builder to fabric's newer canvas primitives, or any visual redesign.
- Retry/backoff configurability per node (a natural follow-on to Phase 2, but a separate product decision).
- Workflow templates gallery / marketplace (`automation-templates` is a separate subsystem).
- Public workflow sharing and OG images — upstream has them, fabric's tenancy model makes them a product decision, not a parity gap.
- Sub-workflows, loops, and fan-out over collections. The recursive walk in Phase 6 is a prerequisite; the feature is not.
