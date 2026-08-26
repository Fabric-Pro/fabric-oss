# ADR-008: Authored Test Cases with Generic PM Sync and Reused AI Context

- **Status**: Accepted
- **Date**: 2026-06-30
- **Deciders**: Engineering team

## Context

Fabric manages the full SDLC — features (`UserStory`), bugs, architecture
decisions, documents, security scans — but had **no first-class test
artefacts** (see [`../features/test-cases.md`](../features/test-cases.md) for the
canonical feature documentation). Teams that author test cases live in Azure
DevOps Test Plans, TestRail, or Xray and could not keep cases beside the work
they verify, sync them to their PM tool the way Fabric syncs work items, group
them into plans, or expose them to the project AI as context.

The verbatim ask was: *"I want to have test cases in Fabric, synchronize them
with PM tools (similarly to work items), attach test cases to work items,
combine test cases in test plans … and they should be available for AI in the
project as additional context."*

A user-provided prototype described a **much broader QA platform**: a
Test-on-Demand tab with run history and findings, a coverage index, AI
root-cause and promote-to-bug, sceptic AI personas appending adversarial cases,
test plans as generated documents, and a test-type/rigor/evidence taxonomy. Its
"test case" was an acceptance-criterion-derived metadata row, not a step grid,
and most of its surface assumed **execution** (runs, results, pass/fail).

The material questions were therefore:

1. **What is a "test case" in Fabric v1** — an authored artefact, or the
   prototype's run-derived metadata row inside an execution platform?
2. **How does sync work across every PM tool** — and every future one — without
   a per-tool fork?
3. **How does a test case become AI-visible** without building new retrieval
   machinery?

## Decision

Ship an **authored, ADO/TestRail-style Test Cases capability** as a new project
tab — authoring and sync only, no run engine in v1.

### 1. Authored model over the prototype's execution platform

A `TestCase` is first-class and authored: ordered **Action + Expected** steps, a
lifecycle `state` (`DRAFT` / `READY` / `CLOSED`), `priority`, owner, and tags,
identified per project as `TC-NNN`. We borrow the prototype's *visual language*
(editorial labels, mono identifiers, dot+text status chips) and its
*generate-from-acceptance-criteria* idea, but **not** its execution platform.
Execution (test points, runs, results, coverage index, sceptic personas) is a
separate, later program. Forward hooks (`TestCase.automationStatus`,
`TestCaseStep.data`, `TestCaseStep.sharedStepId`) exist in the schema but carry
no logic, so execution can be added later without migration churn.

The two top-level tables (`TestCase`, `TestPlan`) mirror `ArchitectureDecision`
(tenant XOR columns, soft-delete, a per-project unique identifier, a soft
`contextId` pointer); the child tables mirror `StoryTask` (no tenant columns,
parent-cascade).

### 2. Reuse the generic MCP sync engine — not per-tool adapters

Test cases sync through the **same entity-agnostic MCP engine** features use.
`testCaseSyncWorkflow` is a copy/parameterization of `storySyncWorkflow`,
started on the same `ai-chat` task queue, and the sync procedures resolve their
target with the **reused** `resolvePmTarget` — no per-tool fork. The
cross-provider contract is a single serializer:

- `buildTestCaseDescription(testCase)` renders the steps as an ordered,
  human-readable block **into the work-item body for every tool**. This is the
  generic baseline that satisfies "all existing **and** all upcoming PM tools".
- `formatTestCaseStepsForProvider(testCase, toolKey)` adds the only
  provider-specific enhancement: Azure DevOps gets native
  `Microsoft.VSTS.TCM.Steps` XML (mirroring how a Bug's
  `Microsoft.VSTS.TCM.ReproSteps` is handled). Every other tool gets nothing
  extra — the steps are already in the description.

All provider branching lives **inside the serializer**, so a new MCP PM tool
works with zero change outside it. Drift surfaces through the same
`lastPmSyncStatus = CONFLICT` mechanism the Roadmap uses, with Retry/Dismiss
controls; the shared PM-state activities gain an internal `testCase` branch that
leaves the existing story-sync call shape untouched.

### 3. Reuse the ProjectContext RAG mirror (`type = TEST_CASE`)

AI awareness reuses the project-context RAG store rather than building anything
test-case-specific. `syncTestCaseContext` upserts a `ProjectContext` of
`type = TEST_CASE` and fires the **reused** `contextEmbeddingWorkflow`; deletion
fires `contextDeletionWorkflow`. Because `retrieveProjectContexts` is
type-agnostic (no `contextType` filter at answer time), wiring a case into a
`ProjectContext` is sufficient for the AI to use it — no new retrieval code. The
"Generate test cases with AI" assist drafts editable cases from a feature's
acceptance criteria through the project provider and **always creates `DRAFT`
cases** linked to the source feature; it never sets `READY`/`CLOSED`.

### 4. Flat Plan → Cases

A `TestPlan` holds cases directly via a `TestPlanCase` membership join with an
optional `section` label; a case can belong to many plans (`(planId,
testCaseId)` is unique). There is **no** intermediate ADO "suite" entity, and
**no** query-based or requirement-based auto-suites. Plans are **Fabric-local**
in v1 — they have no external/sync columns and are not pushed to PM tools.

## Alternatives Considered

### Build the prototype's QA execution platform in v1

The prototype's full vision — runs, results, coverage index, findings, AI
root-cause, promote-to-bug, sceptic personas, generated test-plan documents — is
a large program that assumes a running, testable application. It also models a
"test case" as an AC-derived metadata row, which conflicts with the verbatim ask
for cases that **sync like work items** and carry **steps**. Building it now
would have delayed the actual request behind months of execution tooling and
coupled authoring to a runner that most teams cannot yet point at a deployment.
The authored model delivers the request directly; execution remains a clean
later phase behind the schema hooks.

### Per-tool sync adapters (a dedicated Test Plans API per provider)

Each PM tool exposes its own test-case surface (ADO Test Plans, TestRail's step
API, Xray/Zephyr step stores). A faithful per-tool adapter would maximize
fidelity but multiply the maintenance surface by every provider and, critically,
**would not work for a future tool** without new code — the opposite of what
"all upcoming tools" requires. Serializing steps into the issue body as the
generic baseline, with one optional native-field branch (ADO), means any MCP PM
tool works out of the box and deep provider fidelity stays an isolated,
opt-in extension point in the serializer.

### A dedicated test-case vector index / retrieval path

We could have given test cases their own embedding collection and a
test-case-specific retrieval call. But project AI retrieval is already
type-agnostic over `ProjectContext`, exactly as Architecture Decisions use it. A
separate index would duplicate embedding, deletion, and tenant-scoping logic and
fragment what the assistant can see. Reusing `ProjectContext(type=TEST_CASE)`
makes a case visible to the AI alongside decisions, documents, and transcripts
with no new retrieval code.

### Nested ADO-style suites under plans

ADO models suites (static / query-based / requirement-based) between a plan and
its cases. That hierarchy is powerful but heavy, and the request was to "combine
test cases in test plans" — a flat grouping. A flat `TestPlanCase` membership
with an optional `section` string covers the need; suites can be layered later
if a team needs them, without reworking the membership table.

## Consequences

### Positive

- The verbatim request is satisfied directly: authored cases with steps, PM sync
  like work items, work-item links, plans, and AI context — without waiting on an
  execution platform.
- One generic sync path means **any current or future MCP PM tool works with no
  per-tool fork**; deep provider fidelity is an isolated serializer branch, not a
  new adapter.
- Reusing `resolvePmTarget`, the `CONFLICT`/Retry/Dismiss drift machinery, the
  `ProjectContext` RAG mirror, and the embedding workflows keeps the new surface
  small and consistent with features and decisions — less code, fewer
  divergent behaviours.
- The authored model maps cleanly onto the existing `ArchitectureDecision` /
  `StoryTask` patterns (tenant XOR, soft-delete, child rows), so isolation and
  RLS behave exactly as the rest of the project surface does.

### Negative

- Generic sync trades provider fidelity for reach: on non-ADO tools the steps
  live in the work-item body, not a structured step field, so a round-trip is
  best-effort text rather than a native step grid. Mitigated by the symmetric
  parse on pull and by the ADO native-steps branch where it matters most.
- No execution in v1: a case can be `READY` but there is no run, result, or
  pass/fail. "Tested by N cases" is a count rollup, not coverage. This is a
  deliberate scope cut, not a gap to paper over.
- AI-drafted cases are only as good as the feature's acceptance criteria, and
  they always land as `DRAFT` requiring human review — the assist reduces typing,
  it does not finalize tests.

### Neutral

- The inbound terminal-state poll (`pm-state-poll.ts`) stays STORY-gated; the
  `PmStateChangeEntityType.TEST_CASE` enum member is added for forward-compat but
  carries no auto-hide logic in v1.
- Plans being Fabric-local is intentional; plan-level PM sync would be an
  additive set of external columns and a serializer, not a rework.
- The schema hooks (`automationStatus`, `step.data`, `sharedStepId`) are inert
  today; they reserve space for execution, parameters, and shared steps without
  committing to them.

## References

- [`../features/test-cases.md`](../features/test-cases.md) — canonical feature documentation.
- [ADR-003: XOR tenant isolation](003-xor-tenant-isolation.md) — the tenant pattern the test-case tables follow.
- [ADR-002: Vendor-hosted MCP servers](002-vendor-hosted-mcp-servers.md) — the MCP engine the generic PM sync rides on.
- [ADR-007: AI-driven security & accessibility scanning](007-ai-security-accessibility-scanning.md) — the permissive-`generateObject`-schema pattern reused by AI drafting.
