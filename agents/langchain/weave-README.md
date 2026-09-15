# Fabric Weave

Multi-agent orchestration system for Fabric, bringing OpenCode Weave's
capabilities to the Fabric platform.

Every claim in this document is either verified against the source it cites, or
marked as a known gap with its tracking card. Where a capability exists in code
but is not reachable in the wired-up path, this document says so rather than
describing the intent.

## Known gaps

Three defects are open and pre-existing. They are listed here once, up front,
because several features described below depend on them. Each section that is
affected points back here.

| Gap | Effect today | Card |
|---|---|---|
| Reader routing always resolves to Thread | Spindle, Weft and Warp are unreachable over A2A. Every reader request is answered by Thread. | `Fizzy #2515` |
| Reader steps receive no sandbox tools | `readFile`/`listFiles`/`searchCode`/`execCommand` are never constructed for an orchestrated reader step, under **either** execution provider. | `Fizzy #2516` |
| `trustAutoApproved` is computed and discarded | Trust-based checkpoint auto-approval has no effect; every step that requires approval waits for a human. | `Fizzy #2517` |

### `Fizzy #2515` — reader routing falls through to Thread

`resolveAgent()`
([`weave-readers/src/routes/a2a.ts:34`](weave-readers/src/routes/a2a.ts))
selects the reader by substring-matching `metadata.skillId` plus an agent id
taken from `metadata.delegationContext.agentId` or `metadata.agentId`, and
defaults to `thread`. No production caller sends any of those fields:

- All four reader agents are registered with the **same** base URL and no path
  (`WEAVE_READERS_URL`, `packages/database/prisma/seed-system-agents.ts:542`,
  `:581`, `:613`, `:645`), so there is no path for the orchestrator to select
  with in the first place.
- The orchestrator's A2A metadata is `{ orchestratorContext, delegationMode,
  isCompleteTaskDelegation, history }`
  ([`delegate-to-agent.ts:398-415`](../../packages/temporal/src/activities/orchestrator/delegation/delegate-to-agent.ts))
  — no routing identifier.
- Callers that *do* try to select by URL path lose it: `A2AClient.sendMessage`
  does `new URL("/a2a/send", baseUrl)`
  ([`packages/agent-core/src/a2a/client.ts:82`](../../packages/agent-core/src/a2a/client.ts)),
  and a leading-slash path **replaces** the base URL's path. So
  `chat.ts:71`'s `/spindle` becomes `/a2a/send`, and Pattern's
  `/spindle/research` and `/thread/inspect`
  (`weave-planners/src/pattern/agent.ts:225`, `:240`) both arrive at the same
  default-routed endpoint.

Consequences, all live today: the `agent: "spindle"` option on `/weave/chat` is
silently ignored; Pattern's "external research" and "codebase grounding"
sections are both produced by Thread; and orchestrated Weft review and Warp
security steps run the Thread system prompt.

### `Fizzy #2516` — orchestrated reader steps get no sandbox tools

Reader routes build sandbox tools only when `sandboxSessionId` **and**
`workDir` are present as **top-level** request metadata
([`a2a.ts:198-235`](weave-readers/src/routes/a2a.ts); the same guard is in
`routes/thread.ts:45`, `routes/weft.ts:78`, `routes/warp.ts:64`). Nothing
supplies them:

- The orchestrator embeds the session id as **prompt text** —
  `<sandbox-session id="…" />`
  ([`enrich-delegation.ts:165-166`](../../packages/temporal/src/activities/weave/enrich-delegation.ts))
  — and never sends `workDir` at all.
- The one activity that would pass both in a delegation context,
  `delegateToWeaveAgent`
  (`packages/temporal/src/activities/weave/delegate-to-weave-agent.ts:94`), has
  no callers.
- Even that path would not help: `createSandboxActivity` returns
  `workDir: ""`
  ([`weave/sandbox.ts:104`](../../packages/temporal/src/activities/weave/sandbox.ts)),
  and the values would land inside `orchestratorContext` rather than at the top
  level.

This is **not** provider-specific. Reader steps run without sandbox access
under `BACKGROUND_AGENTS` as well as `KANBAN_LOCAL`, even though
`BACKGROUND_AGENTS` does correctly create and store the shared session.

The same metadata mismatch drops the rest of the delegation context: the reader
reads `body.metadata.delegationContext` (`a2a.ts:174`, `:179`) while the
orchestrator nests it under `body.metadata.orchestratorContext`, so
`reviewMode`, `changedFiles` and `originalPlan` never reach `buildUserContent`
either.

### `Fizzy #2517` — trust-based auto-approval is inert

`trustAutoApproved` is produced at
[`authority-policy.ts:144`](../../packages/temporal/src/activities/orchestrator/approval/authority-policy.ts)
and propagated at
[`authority-check.ts:218`](../../packages/temporal/src/activities/orchestrator/authority-check.ts).
Nothing reads it. The approval gate
([`execution.ts:979`](../../packages/temporal/src/workflows/orchestrator/phases/execution.ts))
branches only on `step.requiresApproval && !step.approvalId`, so a
trust-auto-approved step still waits on `handleStepApproval`.

Weave is doubly affected: weave planning returns early with a pre-approved plan
and skips `handlePlanApproval()`
([`planning.ts:215`](../../packages/temporal/src/workflows/orchestrator/phases/planning.ts)),
which is the only place `analyzePlanApprovalActivity` runs and the only place
auto-approved step ids clear `requiresApproval`.

## Architecture Overview

Fabric Weave implements a 3-tier architecture. Tier 1 and Tier 3 are HTTP
services; Tier 2 is a bridge to a coding-run provider.

### Tier 1: Read-Only Agents (weave-readers)

**Port: 8140**

A single Hono service hosting four agent personas. Routing between them is
broken today (`Fizzy #2515`), so in practice every request runs Thread.

- **Thread** (`/thread`): Codebase exploration
- **Spindle** (`/spindle`): External research — the only persona whose tools do
  not depend on a sandbox (`createWebSearchTools()`, `a2a.ts:207-208`)
- **Weft** (`/weft`): Quality review, with `PLAN` and `WORK` review modes
- **Warp** (`/warp`): Security audit, with RFC citation support

Each persona is a system prompt plus a tool set (`a2a.ts:198-235`). Thread,
Weft and Warp are intended to receive read-only sandbox tools — `readFile`,
`listFiles`, `searchCode`, `execCommand` — and Warp additionally `fetchRfc` /
`clearRfcCache` for RFC verification. **No orchestrated request currently
supplies the metadata those tools require** (`Fizzy #2516`), so they run on the
prompt alone. The `execCommand` guard described under Sandbox Isolation below
is therefore real code on an unreached path.

#### Weft review modes

`reviewMode` selects the system-prompt framing and the verdict thresholds, not
a different set of checks:

- **`PLAN`** is lenient: `APPROVE` unless there is a critical issue or more
  than two high-severity ones.
- **`WORK`** is strict: `REJECT` on any critical, `NEEDS_CHANGES` on any high
  or on more than five total issues.

Both thresholds live in `generateVerdict()`
([`weave-readers/src/lib/weft-quality.ts:433`](weave-readers/src/lib/weft-quality.ts)).

Two deterministic checks exist — `checkStubTodoPlaceholder()` and
`detectFakeTests()` — and `runQualityChecks()` (`weft-quality.ts:563`) runs
**both in both modes**. A third, `checkScopeCreep()` (`:299`), is exported but
never called. Scope creep, implementation completeness and test/code
contradictions are requested of the model by the Weft system prompt
(`weave-readers/src/prompts/weft-system.ts:50`, `:60`, `:73`); they are not
enforced in code, and the model's output is not validated against them.

`runQualityChecks()` is reached from exactly one place: the no-sandbox `WORK`
fallback in `routes/weft.ts:131`, where it scans the *request text* rather than
any code. That route is itself unreachable over A2A (`Fizzy #2515`).

#### Warp

- **Three-phase prompting strategy**, not an enforced pipeline. The route runs
  `step1DiffScan()` to size the change
  ([`routes/warp.ts:61`](weave-readers/src/routes/warp.ts)) and then asks the
  model to do the rest in the prompt (`:141`). `getPatternGrepList()` and
  `step3DeepReview()` (`weave-readers/src/lib/warp-triage.ts:191`, `:208`)
  exist and are unit-tested, but nothing outside the tests calls them.
- 40 security patterns across 8 categories
  ([`weave-readers/src/lib/security-patterns.ts`](weave-readers/src/lib/security-patterns.ts))
- 13 security specs available for citation
  ([`weave-readers/src/lib/security-specs.ts`](weave-readers/src/lib/security-specs.ts))
- Blocking/non-blocking issue classification (max 3 blocking issues,
  `warp-triage.ts:78`)
- Project-specific config via `.weave/specs.json`

### Tier 2: Write-Enabled Agent (weave-shuttle)

**Port: 8141**

Hono-based HTTP service running in its own container/process.

- **Shuttle** (`/shuttle`): Category-specific implementation

  Shuttle does not run its own read/write sandbox tool-calling loop. It is a
  thin bridge: it takes the plan step, resolves the category (from
  `stepInputs.category`, then `metadata.category`, defaulting to `backend` —
  `weave-shuttle/src/routes/shuttle.ts:24-28`), and calls
  `startWeaveCodingRunAndWait()`
  ([`weave-shuttle/src/lib/coding-run-bridge.ts`](weave-shuttle/src/lib/coding-run-bridge.ts)),
  which POSTs to the internal Fabric bridge
  (`POST ${FABRIC_INTERNAL_URL}/api/internal/weave-coding-run`, authenticated
  with `AGENT_SERVICE_SECRET` via the `X-Agent-Service-Token` header) and waits
  for the coding run to finish. Shuttle returns the coding run's summary and,
  when one was opened, its pull request URL.

  Categories are `frontend`, `backend`, `database`, `devops`. Pattern's plan
  prompt asks the model for a category "for shuttle only"
  (`weave-planners/src/pattern/agent.ts:330`, `:339`), but the model's output
  is not validated, and the parse-failure fallback checkbox is created with no
  category at all (`:369-377`). Treat a missing category as normal and expect
  the `backend` default.

  The two execution providers weave can persist and run are
  `BACKGROUND_AGENTS` and `KANBAN_LOCAL` — the only values in the
  `CodingRunProvider` Prisma enum
  (`packages/database/prisma/schema.prisma`). Shuttle's own type signature
  additionally accepts a third value, `VIBE_WORKSPACE`
  (`weave-shuttle/src/lib/coding-run-bridge.ts`), but nothing in the
  persistence path can store it — a known inconsistency, tracked separately,
  not a third supported provider.

  **Shuttle's process boundary is not a write-access security boundary.**
  Shuttle writes nothing itself; the writes happen wherever the coding-run
  provider runs them. Under `KANBAN_LOCAL` that is a Fabric Kanban process
  spawned directly on the host with `cwd` set to a validated working directory
  ([`local-kanban-provider.ts:340-350`](../../packages/temporal/src/lib/coding-execution/local-kanban-provider.ts))
  — not a sandbox. The separate container keeps the reader and writer services
  apart operationally; it is not where write authority is confined.

### Tier 3: Multi-Node Planner (weave-planners)

**Port: 8142**

LangGraph-based multi-node workflow:

- **Pattern** (`/pattern`): Complex plan creation
  - Workflow: `researchNode` → `analyzeNode` → `createCheckboxesNode` →
    `savePlanNode` (`weave-planners/src/pattern/agent.ts:383-392`)
  - The research node calls the readers service twice, targeting
    `/spindle/research` and `/thread/inspect` (`:225`, `:240`). Both currently
    resolve to Thread — see `Fizzy #2515`. Pattern is **not** integrated with
    Spindle in any working sense today.
  - Saves plans to database with an exclusive `userId`/`organizationId` tenant
    filter (see Security Model below)

## Orchestration Layer

Weave used to run on two dedicated Temporal workflows, "Loom" and "Tapestry".
Both were removed — weave execution is now handled by the same general
orchestrator workflow that runs every other agent task
(`orchestratorExecutionWorkflow`, exported from
`packages/temporal/src/workflows/orchestrator/index.ts`, still referred to as
"Fabric Loom" in code comments). See the removal note at
`packages/temporal/src/workflows/index.ts:786-787`.

### Plan creation (no Temporal workflow)

`POST /weave/plans/create` ([procedure](../../packages/api/modules/weave/procedures/create-plan.ts))
calls the Pattern planner service (weave-planners, `/pattern`) directly in a
background job — there is no Temporal workflow involved in generating a plan.
The plan is persisted in `PENDING_APPROVAL` status for review.

### Execution (`orchestratorExecutionWorkflow`)

`POST /weave/executions/start` ([procedure](../../packages/api/modules/weave/procedures/start-execution.ts))
starts `orchestratorExecutionWorkflow` with `executionMode: "weave"` on task
queue **`fabric-orchestrator`**. That workflow iterates over the plan's
checkboxes in dependency-aware waves (`computeExecutionWaves`,
`packages/temporal/src/workflows/orchestrator/execution-waves.ts`) and
delegates each step to an executor. How a Shuttle (implementation) step is
delegated — and whether a sandbox session exists at all — depends on the
execution provider
(`packages/temporal/src/workflows/orchestrator/phases/initialization.ts`,
`.../phases/execution.ts`, `packages/temporal/src/activities/weave/shuttle-execution.ts`):

- **`BACKGROUND_AGENTS` (default)**: the workflow creates one shared sandbox
  session up front ("Creating weave sandbox..."). Read-only agent steps are
  delegated via the general `delegateToAgent` Temporal activity over A2A
  (`SecureA2AClient`); Shuttle steps instead send their prompt into that same
  session and poll it
  (`sendShuttlePromptActivity`/`pollShuttleStatusActivity`). The session is
  torn down on completion by the cleanup activity.
- **`KANBAN_LOCAL`**: no sandbox session is created for the execution at all.
  Shuttle steps instead call `delegateWeaveImplementationActivity`, which
  POSTs straight to the internal `/api/internal/weave-coding-run` bridge —
  the same endpoint weave-shuttle's own `/shuttle` route bridges to (see the
  Tier 2 architecture section above).

Under both providers, read-only agent steps are routed to Thread
(`Fizzy #2515`) and run without sandbox tools (`Fizzy #2516`). Under
`BACKGROUND_AGENTS` the session is created and stored correctly — it simply
never reaches the reader in a form it can act on.

Cleanup (`cleanupWeaveResourcesActivity`,
`packages/temporal/src/activities/weave/cleanup-resources.ts`) always
reconciles the `WeaveExecution` row and its parent `WeavePlan` and always
writes an audit entry; when no session was ever created it skips only the
**provider teardown** and returns a no-op success (`cleanup-resources.ts:88-100`).
It is safe to call unconditionally on every exit path regardless of provider —
and for init/sandbox failures it is what prevents an execution row from sitting
in `RUNNING` forever.

The workflow carries a hard `workflowExecutionTimeout` (`WEAVE_MAX_RUN_MINUTES`,
default 120 minutes) so a wedged execution can't run forever, and surfaces
checkpoints as signals/queries for the UI to approve or cancel.

**Signals** (generic orchestrator signals, exported from
`@repo/temporal/workflows`, used for weave checkpoints too):
- `orchestratorApprovalSignal`: Approve/reject a checkpoint
- `orchestratorCancelSignal`: Cancel execution

**Queries**:
- `statusQuery`: Get current execution status
- `pendingApprovalQuery`: Get the pending checkpoint, if any

Every checkpoint is a human checkpoint — see `Fizzy #2517`.

### Watchdog (stale-execution safety net)

`weaveExecutionWatchdogWorkflow` (`packages/temporal/src/workflows/weave-execution-watchdog.ts`)
is a cron workflow that runs every 5 minutes on the `fabric-worker` queue. It
finds `WeaveExecution`/coding-run rows whose owning workflow exited
ungracefully (force-terminated by `workflowExecutionTimeout`, worker crash,
dropped connection), signals or terminates the workflow, runs provider
cleanup, and flips the row to `TERMINATED_STALE` with an audit-log entry.

## Database Schema

### New Tables

- `ProjectWeaveConfig`: Project-level weave configuration
- `WeavePlan`: Execution plans created by Pattern
- `WeavePlanTemplate`: Reusable plan templates saved from a `WeavePlan`
- `WeaveExecution`: Execution tracking

### Extended Tables

- `AgentApproval`: Extended with `weaveExecutionId`, `weavePlanId`, and `weaveContext`
- `Project`, `UserStory`, `StoryTask`: Added weave plan relations

## API Endpoints

All endpoints are available via oRPC under `/api/weave/`:

### Plans
- `POST /weave/plans/create` - Create new plan (calls the Pattern planner directly)
- `POST /weave/plans/refine` - Refine a plan request before generation
- `GET /weave/plans/:planId` - Get plan by ID
- `GET /weave/plans?projectId=...` - List plans for project
- `POST /weave/plans/:planId/approve` - Approve/reject plan
- `POST /weave/plans/:planId/revise` - Revise an existing plan
- `POST /weave/plans/:planId/retry-generation` - Retry a failed plan generation
- `POST /weave/plans/:planId/checkboxes` - Update a plan's checkboxes
- `POST /weave/plans/:planId/delete` - Delete a plan

### Templates
- `GET /weave/templates` - List saved plan templates
- `POST /weave/templates` - Save a plan as a reusable template
- `POST /weave/templates/:templateId/use` - Create a plan from a template

### Executions
- `POST /weave/executions/start` - Start plan execution (starts `orchestratorExecutionWorkflow`)
- `GET /weave/executions/:executionId` - Get execution status
- `POST /weave/executions/:executionId/signal` - Signal checkpoint approval
- `POST /weave/executions/:executionId/auto-approve` - Auto-approve all remaining checkpoints for this execution
- `POST /weave/executions/:executionId/revoke-auto-approve` - Revoke auto-approval for this execution
- `POST /weave/executions/:executionId/retry-from-step` - Retry execution from a specific failed step
- `POST /weave/executions/:executionId/cancel` - Cancel execution
- `GET /api/weave/stream?executionId=...` - SSE stream of execution progress (Next.js route, not oRPC; see `apps/web/app/api/weave/stream/route.ts`)

### Configuration
- `GET /weave/config/:projectId` - Get project weave config
- `POST /weave/config/:projectId` - Update project weave config

### Chat
- `POST /weave/chat` - Ask a one-off question without creating a plan. The
  input accepts `agent: "thread" | "spindle"` (`chat.ts:25`), but the value has
  no effect — every request is answered by Thread (`Fizzy #2515`).

## Security Model

### Multi-Tenancy (exclusive organization/user filter)

An organization is the only tenant context (see
[ADR-018](../../docs/adr/018-organization-is-the-only-tenant-context.md)).
Weave queries follow the same rule as the rest of the codebase: the
`userId` and `organizationId` arms are never combined with `OR`. The
canonical form (AGENTS.md) carries `userId` in both arms:
```typescript
const tenantFilter = organizationId
  ? { organizationId, userId }
  : { organizationId: null, userId };
```
Use this form as the pattern to copy — it is safe on its own. Some weave
queries (e.g. `list-plans.ts`) instead scope `userId` to only the
`organizationId: null` arm; that narrower form only stays safe because it is
paired with an explicit `hasProjectAccess` check and a `projectId` filter, so
don't copy it without also copying those guards.

### Sandbox Isolation

- **Read-only agents**: weave-readers (port 8140)
- **Write-enabled**: weave-shuttle (port 8141) - separate process, but see the
  Tier 2 note above: the process boundary is operational separation, not where
  write authority is confined
- **Shared session**: One sandbox session per weave execution is created only
  under the `BACKGROUND_AGENTS` provider (the default); `KANBAN_LOCAL`
  executions never create one. Even under `BACKGROUND_AGENTS`, the session
  never reaches the reader agents in a usable form (`Fizzy #2516`)
- **`execCommand` guard**: A command allow-list (`grep`, `find`, `cat`, `ls`,
  `head`, `tail`, `wc`, `pwd`), a reject on `&&`, `||`, `;`, `|` in any
  argument, and single-quote escaping of every argument before it reaches the
  sandbox's shell (see `quote()` in
  [`weave-readers/src/lib/sandbox-client.ts`](weave-readers/src/lib/sandbox-client.ts)).
  This prevents shell injection, but it does not by itself constrain what an
  allowed command does — nothing validates a command's own options, so e.g.
  `find . -delete` or `find . -exec ...` currently passes every check. Do not
  read "read-only" into the allow-list; it is not option-aware. Note that
  `execCommand` is only constructed when sandbox tools are built, which no
  current caller triggers (`Fizzy #2516`).

## Calling an Agent Directly

`serviceAuth({ requireTenantContext: true })`
([`packages/agent-runtime/src/security/middleware.ts`](../../packages/agent-runtime/src/security/middleware.ts))
guards the reader, shuttle and planner services. It lets three things through
without authentication: `/health`, `/.well-known/agent-card.json` and the
legacy `/.well-known/agent.json` (`middleware.ts:79`), plus **every `OPTIONS`
request**, which is skipped before any token check so browser CORS preflights
work (`middleware.ts:72`). Everything else — including `/thread`, `/spindle`,
`/weft`, `/warp` and `/a2a/send` — requires both the `AGENT_SERVICE_SECRET`
service token and an HMAC-signed tenant context header. A plain `curl` POST
gets a 400/401; there is no way to call an agent endpoint with just a bearer
token. When `AGENT_SERVICE_SECRET` is unset the middleware returns 500 for
those same non-skipped, non-`OPTIONS` requests.

Use `SecureA2AClient` from `@repo/agent-core`, the way
[`packages/api/modules/weave/procedures/chat.ts:80`](../../packages/api/modules/weave/procedures/chat.ts)
does:

```typescript
import { SecureA2AClient } from "@repo/agent-core";

const client = new SecureA2AClient({ timeout: 60_000, sourceAgent: "api" });

const result = await client.sendMessageSecure(
  readersUrl,
  {
    role: "user",
    parts: [{ type: "text", text: "Where is the auth middleware defined?" }],
  },
  { userId, organizationId },
  {
    metadata: {
      // Read by the reader service as `body.metadata`.
      skillId: "explore_codebase",
      projectContext: { projectId, projectName },
    },
  },
);
```

Two things this example is deliberate about, both of which the previous version
of this document got wrong:

- **Pass the base URL, not a per-agent path.** `sendMessageSecure` delegates to
  `A2AClient.sendMessage`, which rewrites the URL to `/a2a/send`
  (`client.ts:82`). Any path you append is discarded.
- **Put routing and sandbox metadata in the fourth argument's `metadata`, not
  on the message.** The reader reads `body.metadata` (`a2a.ts:174`), which is
  what `sendMessageSecure` populates from `options.metadata`; metadata attached
  to the message object is never read. Every shipped caller gets one half of
  this wrong: `chat.ts` and Pattern attach their metadata to the message, and
  the orchestrator uses `options.metadata` but nests everything under
  `orchestratorContext` with no routing identifier. That is the mismatch behind
  `Fizzy #2515` and `Fizzy #2516`.

`SecureA2AClient` signs the tenant context and attaches the service token for
you; it is also how the orchestrator's `delegateToAgent` Temporal activity
talks to every weave agent during plan execution.

## Project-Specific Configuration

Weave agents support project-specific configuration via `.weave/specs.json`,
loaded and validated against `ProjectSpecsSchema` in
[`weave-readers/src/lib/project-specs.ts`](weave-readers/src/lib/project-specs.ts):

```json
{
  "customPatterns": [
    {
      "id": "my-secret-pattern",
      "name": "My Secret Pattern",
      "severity": "high",
      "category": "Secrets",
      "grepPatterns": ["MY_SECRET_.*="],
      "description": "Project-specific secret pattern",
      "remediation": "Move to environment variables"
    }
  ],
  "disabledPatterns": ["password-hardcoded"],
  "minSeverity": "medium",
  "enabledCategories": ["Injection", "Cryptography"],
  "disabledCategories": ["Dependencies"]
}
```

**Category and pattern names are case-sensitive and matched exactly.**
Filtering is `Set.has()` against the pattern's own `category` and `id` strings
(`project-specs.ts:134-148`), and the built-in categories are capitalised —
`"Injection"`, `"Cryptography"`, `"Input Validation"`, and so on (see the table
below). A lowercase `"injection"` in `enabledCategories` matches no built-in
pattern and silently disables all of them; a lowercase entry in
`disabledCategories` silently disables nothing. The same applies to
`disabledPatterns`, which takes pattern **ids** such as `password-hardcoded`,
not bare words.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `customPatterns` | object[] | Additional security patterns; each needs `id`, `name`, `severity`, `grepPatterns`, `description`, `remediation` (`filePatterns`, `category`, `rfcRefs` are optional) |
| `disabledPatterns` | string[] | Pattern IDs to exclude from checks (exact match) |
| `extraSpecs` | string[] | Parsed and echoed in the formatted config display (`project-specs.ts:183-184`) and nothing else — it does **not** feed RFC citation selection |
| `minSeverity` | string | Minimum severity level (low, medium, high, critical) |
| `enabledCategories` | string[] | Only run patterns in these categories (exact, case-sensitive) |
| `disabledCategories` | string[] | Skip patterns in these categories (exact, case-sensitive) |

A pattern with no `category` is never filtered out by either category list —
both filters keep `!p.category` entries (`project-specs.ts:140`, `:146`).

### Security Pattern Categories

The 40 built-in patterns, counted from
[`security-patterns.ts`](weave-readers/src/lib/security-patterns.ts):

| Category | Patterns | Examples |
|----------|----------|----------|
| Injection | 8 | SQLi, XSS, Command Injection, LDAPi |
| Authentication | 6 | Weak password policy, Missing MFA, Hardcoded creds |
| Authorization | 5 | IDOR, Privilege escalation, Missing authorization |
| Cryptography | 5 | Weak hash, Static IV, Certificate validation disabled |
| Configuration | 5 | Insecure CORS, Missing security headers, Debug mode |
| Dependencies | 3 | Known CVE, Outdated dep, Unverified package |
| Secrets | 4 | API key in code, Secret in logs, Private key exposure |
| Input Validation | 4 | Missing validation, File upload validation, Path traversal |

### RFC Citation System

Thirteen specs are available for citation in
[`security-specs.ts`](weave-readers/src/lib/security-specs.ts). Selection is
keyword scoring against the code sample, not lookup by id:
`findRelevantSpecs()` (`:203`) scores every spec's `keywords` against the code
and `routes/warp.ts:135-137` appends the top three to the prompt. The rendered
citation is the spec's `name`, `description`, `url` and `keywords` — the `id`
is not rendered, is not matched against a pattern's `rfcRefs`, and cannot be
requested via `.weave/specs.json`. The `ID` column below is the literal `id`
field, listed so the table is checkable against source:

| Spec | ID | Description |
|------|-----|-------------|
| OAuth 2.0 | `RFC6749` | Authorization framework |
| PKCE | `RFC7636` | OAuth security extension |
| JWT | `RFC7519` | JSON Web Token |
| JWK | `RFC7517` | JSON Web Key |
| Token Revocation | `RFC7009` | Token invalidation |
| OpenID Connect Core 1.0 | `OIDC-Core` | Identity layer on OAuth 2.0 |
| WebAuthn Level 2 | `WebAuthn-L2` | Passwordless auth |
| TOTP | `RFC6238` | Time-based OTP |
| HOTP | `RFC4226` | HMAC-based OTP |
| CORS | `CORS` | Cross-origin resource sharing |
| CSP Level 3 | `CSP-L3` | Content Security Policy |
| OWASP Top 10 2021 | `OWASP-Top10-2021` | Top web security risks |
| BCP 195 | `BCP195` | TLS best practices |

## Environment Variables

All three services require `AGENT_SERVICE_SECRET` — it is the shared token
`serviceAuth()` checks (see
[`packages/agent-runtime/src/security/middleware.ts`](../../packages/agent-runtime/src/security/middleware.ts)),
and its absence fails every request that is not `/health`, an agent-card path,
or an `OPTIONS` preflight. `AI_TOKEN_SECRET` is also wired to all three by
`docker-compose.weave.yml` and the Aspire AppHost.

### Weave Readers (8140)
- `PORT=8140`
- `AGENT_SERVICE_SECRET` - Shared inter-agent auth token (required)
- `AI_TOKEN_SECRET` - AI usage token signing secret
- `SANDBOX_API_URL` - Sandbox service base URL, read by `sandbox-client.ts:44` (defaults to `http://localhost:3000`)
- `CORS_ALLOWED_ORIGINS` - Allowed CORS origins

### Weave Shuttle (8141)
- `PORT=8141`
- `AGENT_SERVICE_SECRET` - Shared inter-agent auth token (required)
- `AI_TOKEN_SECRET` - AI usage token signing secret
- `FABRIC_INTERNAL_URL` - Base URL for the internal Fabric coding-run bridge (falls back to `RUNTIME_API_URL`, then `NEXT_PUBLIC_APP_URL`)
- `CORS_ALLOWED_ORIGINS` - Allowed CORS origins

`docker-compose.weave.yml` also sets `SANDBOX_API_URL` on the shuttle
container, but no weave-shuttle source reads it. It is a compose-file vestige,
not a shuttle configuration knob.

### Weave Planners (8142)
- `PORT=8142`
- `AGENT_SERVICE_SECRET` - Shared inter-agent auth token (required)
- `AI_TOKEN_SECRET` - AI usage token signing secret
- `WEAVE_READERS_URL` - URL to weave-readers service
- `DATABASE_URL` - Database connection string
- `CORS_ALLOWED_ORIGINS` - Allowed CORS origins

### API process (packages/api)
- `WEAVE_PLANNERS_URL` - URL to weave-planners service, checked before creating a plan (default `http://localhost:8142`)
- `WEAVE_READERS_URL` - URL to weave-readers service, checked before `/weave/chat` (default `http://localhost:8140`)
- `WEAVE_MAX_RUN_MINUTES` - Execution workflow timeout ceiling in minutes (optional, default `120`)

### Temporal Workflows
- `TEMPORAL_ADDRESS` - Temporal server address (default `localhost:7233`)
- `TEMPORAL_NAMESPACE` - Temporal namespace (default `default`)
- `TEMPORAL_CLOUD_API_KEY` - Temporal Cloud API key (optional; setting it also
  enables TLS). This is the exact name `packages/temporal/src/client.ts:21`
  reads — `TEMPORAL_API_KEY` is not read anywhere and is silently ignored.

## Running Locally

### Option 1: Aspire (recommended)

```bash
./aspire.sh run
```

Brings up all three weave services (weave-readers, weave-shuttle,
weave-planners) plus Postgres, Redis, Temporal, and the web app together —
this is the path used day-to-day, not docker-compose. In dev mode each agent
runs its compiled `dist/index.js` off the bind-mounted checkout, so a source
edit does not take effect until you rebuild: use the Aspire dashboard's
"Rebuild & restart" command on the changed agent's resource (registered for
all three weave agents at `aspire/Fabric.AppHost/Program.cs:1556-1568`). See
[`docs/ASPIRE_USAGE.md`](../../docs/ASPIRE_USAGE.md) for the full command
reference.

### Option 2: Docker Compose

```bash
# Start weave services
docker-compose -f agents/langchain/docker-compose.weave.yml up -d

# Start Temporal worker
pnpm --filter @repo/temporal worker
```

### Option 3: Individual Services

```bash
# Terminal 1: weave-readers
pnpm --filter weave-readers dev

# Terminal 2: weave-shuttle
pnpm --filter weave-shuttle dev

# Terminal 3: weave-planners
pnpm --filter weave-planners dev

# Terminal 4: Temporal worker
pnpm --filter @repo/temporal worker
```

## Usage Flow

1. **Create Plan** — `name` is required
   ([`create-plan.ts:22-31`](../../packages/api/modules/weave/procedures/create-plan.ts)).
   ```typescript
   const { planId } = await api.weave.plans.create({
     projectId: "...",
     name: "User authentication",
     message: "Add user authentication feature",
     techStack: "Next.js, Prisma, NextAuth"
   });
   ```

2. **Review Plan**
   ```typescript
   const plan = await api.weave.plans.get({ planId });
   // User reviews checkboxes in UI
   ```

3. **Approve Plan**
   ```typescript
   await api.weave.plans.approve({
     planId,
     approved: true
   });
   ```

4. **Start Execution** — the repository and branch come from the project, not
   from this call. The input schema still accepts `repoUrl` and `targetBranch`
   ([`start-execution.ts:23-24`](../../packages/api/modules/weave/procedures/start-execution.ts)),
   but the handler ignores both: it reads `project.repositoryUrl` (`:126-128`) and
   the workflow resolves the branch itself. Passing them does not control the
   run.
   ```typescript
   const { executionId } = await api.weave.executions.start({
     planId,
     // Optional; defaults to BACKGROUND_AGENTS.
     executionProvider: "BACKGROUND_AGENTS"
   });
   ```

5. **Monitor Execution**
   ```typescript
   const execution = await api.weave.executions.get({ executionId });
   // Poll, or subscribe to GET /api/weave/stream?executionId=... for
   // Redis-pub/sub-backed SSE progress updates
   ```

6. **Handle Checkpoints**
   ```typescript
   // When execution hits checkpoint
   await api.weave.executions.signalApproval({
     executionId,
     workflowId,
     runId,
     approved: true,
     feedback: "Looks good!"
   });
   ```

## Development

### Adding New Agents

1. Create agent in appropriate tier
2. Add route to service index.ts
3. Register the agent in `packages/database/prisma/seed-system-agents.ts` and
   re-seed; `resolveAgentEndpoint` reads `RegisteredAgent` first
4. Update the `delegateToAgent` Temporal activity's routing (`packages/temporal/src/activities/orchestrator/delegation/delegate-to-agent.ts`) and, for weave-specific enrichment, `packages/temporal/src/activities/weave/enrich-delegation.ts`
5. Add tests

A new reader persona added to `weave-readers` will inherit `Fizzy #2515`: it
shares one registered base URL with the others, so until routing metadata is
sent, requests for it will run Thread.

### Modifying Workflows

There is no `/packages/temporal/src/workflows/weave/` directory — weave
execution runs through the general orchestrator workflow, not a
weave-specific one:

1. Weave-specific activities live in `packages/temporal/src/activities/weave/`; the stale-execution safety net is the standalone `packages/temporal/src/workflows/weave-execution-watchdog.ts` workflow
2. Rebuild worker: `pnpm --filter @repo/temporal build`
3. Restart worker

## Testing

There is no `pnpm test:weave` or `pnpm --filter @fabric/weave-*` — the
package names are unscoped, and `pnpm --filter` silently exits `0` on a
filter that matches nothing, so a typo'd or stale filter looks like a pass
having run zero tests. `weave-planners` has no test suite yet (no `test`
script, no test files).

```bash
# Agent unit tests
pnpm --filter weave-shuttle test
pnpm --filter weave-readers test

# API, Temporal, and web-layer coverage for the weave surface
pnpm --filter @repo/api test        # 7 files in packages/api/modules/weave/procedures/__tests__/
pnpm --filter @repo/temporal test   # includes weave-* files in packages/temporal/__tests__/ and cleanup-resources / watchdog-activities / weave-database in src/activities/__tests__/
pnpm --filter @repo/web test        # apps/web/app/api/internal/weave-coding-run/__tests__/lib.test.ts

# End-to-end (Playwright)
pnpm --filter @repo/web e2e         # apps/web/tests/weave-orchestration.spec.ts — self-skips without seed data containing a project with a connected repo
```

A caution the three gaps above should raise about this suite: the `resolveAgent`
tests pass because they construct the metadata shape production never sends
(`weave-readers/src/routes/a2a.test.ts:30`). `normalizeMetadata` and the
sandbox client have their own unit tests, but no test exercises the route
handlers' sandbox-tool branch — `a2a.test.ts` is the only route test and it
never touches `sandboxSessionId`. Green agent tests are not evidence that a
caller reaches the agent it asked for, or that it arrives with tools.

## Architecture Decisions

1. **Exclusive tenant filter**: Only `userId` + `organizationId`, no `tenantId` field, and never combined with `OR`
2. **Separate Shuttle Service**: weave-shuttle runs as its own service and container. It is operational separation between the read and write surfaces, not the boundary that confines write authority — the writes happen inside the coding-run provider
3. **Shared Sandbox Session (BACKGROUND_AGENTS only)**: Created once per weave execution, intended to be shared by all agent steps; `KANBAN_LOCAL` executions run without one. Reader steps do not currently receive it (`Fizzy #2516`)
4. **Plan creation has no workflow**: `create-plan` calls the Pattern planner directly in a background job; there is no dedicated "Loom" planning workflow
5. **Single execution workflow for checkpoints**: `orchestratorExecutionWorkflow` handles both plan execution and checkpoint approval via signals — there is no separate "Tapestry" child workflow
6. **MCP Config by ID**: Reference config IDs, not tool names (Option B)

## Future Enhancements

- [x] Real-time execution updates — implemented via Redis pub/sub + an SSE endpoint (`GET /api/weave/stream`), not PartyKit/WebSocket as originally planned
- [x] Parallel checkbox execution where dependencies allow — implemented: `convert-plan.ts` maps `WeaveCheckbox[]` into `TaskStep[]` explicitly "so Fabric Loom can execute it via wave-based scheduling", and the execution phase groups steps into dependency-respecting parallel waves via `computeExecutionWaves` (`packages/temporal/src/workflows/orchestrator/execution-waves.ts`, Kahn's topological sort)
- [ ] Checkpoint auto-approval for trusted agents — **not in effect**: the trust verdict is computed and then discarded, and weave skips the plan-approval phase where the analysis would run. See `Fizzy #2517`
- [ ] Reader agent routing and sandbox delivery — see `Fizzy #2515` and `Fizzy #2516`
- [ ] Eval harness for agent testing — **not implemented despite appearances**: `packages/weave-core/evals/runner.ts` exists, but `runEvalCase()` is a stub that returns `passed: true` unconditionally for every case. Treat any eval run through it as a no-op, not a real regression check, until it actually invokes the agents and validates output
- [ ] UI dashboard for plan/execution management
