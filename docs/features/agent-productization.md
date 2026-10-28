# Agent productization

Implementation roadmap for governed, operable agents across Fabric's existing orchestration platform.

- **Audience**: Product and engineering
- **Owner**: Engineering team
- **Status**: In progress; shared chat transport, approval controls, and portable draft definitions are implemented; broader parity milestones remain open.

## Scope

Preserve Fabric's organization-only tenancy, project permissions, coding agents,
memory, MCP, LangGraph, and Temporal orchestration. Improve the contracts and
product experience around those capabilities. Reference-product behavior informs
requirements; implementations and assets remain Fabric-owned unless reuse is
explicitly reviewed with its applicable license.

This roadmap describes incremental delivery, not a claim of feature parity.
Each milestone must work through a real producer, execution path, consumer, and
authorization check before it is considered delivered. Types and dormant UI alone
do not complete a feature.

## Verified starting points

| Area | Existing implementation | Remaining work to establish |
| --- | --- | --- |
| Chat | [Direct workflow](../../packages/temporal/src/workflows/direct-chat.ts), [stream route](../../apps/web/app/api/agents/fabric-ai/stream/route.ts), separate Direct and Orchestrator hooks, cancellation routes, reasoning, usage, tool results | Shared event semantics across engines; durable interruption, graceful stop, tool approvals, reconnect and UI composition |
| Tool governance | [Executor registry](../../packages/integrations/src/executor-registry.ts) already owns schemas, read/write classification, credentials and retry safety | Cover built-ins and MCP consistently; output contracts, approval policies, discovery and audit metadata |
| Knowledge | [Connector contracts](../../packages/connectors/src/types.ts), federated search, workspace/project RAG and repository sync | One authorized content and citation representation across indexed and live retrieval |
| Agent lifecycle | [Version history](../../packages/api/modules/agents/procedures/get-instance-versions.ts), [restore](../../packages/api/modules/agents/procedures/restore-instance-version.ts), [builder Sidekick](../../apps/web/modules/saas/agents/sidekick/AgentBuilderSidekick.tsx) | Complete published snapshots, portable manifests, resource rebinding, version diffs and execution pinning |
| Observability | [Project usage](../../packages/api/modules/projects/procedures/usage/get-summary.ts), [usage limits](../../packages/api/modules/payments/procedures/ai-usage-limits/upsert.ts), deployment metrics and audit infrastructure | Correlated conversation/tool/agent-version diagnostics and budgets at missing scopes |
| Channels | [Unified inbound handler](../../apps/web/lib/channels/inbound-handler.ts) and [Teams mention workflow](../../packages/temporal/src/workflows/teams-mention-handler.ts) | Verify and unify assistant semantics, identity mapping, approvals, citations and delivery recovery across Slack and Teams |
| Artifacts | [Artifact browser](../../apps/web/modules/saas/artifacts/components/ArtifactBrowser.tsx), [Frames](../../apps/web/modules/saas/frames/components/FrameViewer.tsx), chat artifact panels | Consistent conversation attachment, version history, authorized sharing and execution policy |

These are source-level findings. End-to-end availability, permission completeness,
and production readiness still require the acceptance checks below. In particular,
existing channel workflows should be evaluated before replacing them with a
different chat workflow.

## Delivery sequence

### 1. Chat runtime and modular UI

Implemented:

- [Direct](../../apps/web/modules/saas/agents/lib/direct-stream-protocol.ts) and
  [Orchestrator](../../apps/web/modules/saas/agents/lib/orchestrator-stream-protocol.ts)
  schema-derived event contracts, used by route producers and browser consumers.
  Research reads the Orchestrator contract with its legacy text/completion aliases.
- One [SSE reader](../../apps/web/modules/saas/agents/lib/read-chat-event-stream.ts)
  outside React state, including fragmented Unicode, CRLF, multiline data and reader
  cleanup. Unknown event kinds remain additive; incompatible versions and malformed
  known events fail with a safe message. Unversioned producers remain readable.
- EOF without an explicit outcome is an interrupted reply. Orchestrator preserves
  its bounded reconnect-to-existing-run behavior; contract failures do not trigger
  reconnection. Research reports interruption and keeps buffered partial output.
- Partial answers and failure reasons remain separate in the UI and persisted
  Research/Orchestrator history. Pending tool cards settle on failed transport.
- Modular [workflow confirmation controls](../../apps/web/modules/saas/agents/components/FabricChat/WorkflowConfirmationCard.tsx)
  driven by explicit events or validated legacy workflow-tool results. A local
  decision is consumed before dispatch, preventing duplicate clicks and resurrected
  prompts. Started, declined, rejected and unknown outcomes are distinct. Unknown
  starts do not offer automatic retry. Existing server authorization remains required.
- Final Orchestrator events carry workflow-recorded approval history, accumulated
  limits and token-budget metadata;
  approval-resolution notices do not infer that a vanished checkpoint was approved.

- A separate [workflow approval controller](../../packages/temporal/src/workflows/orchestrator/approval-controller.ts)
  now acknowledges decisions through Temporal Updates. It binds a single decision
  to the pending checkpoint, run, actor and organization, rejects stale, expired or
  conflicting decisions, and withholds checkpoints until their gates are ready.
  Approve-all cannot satisfy an explicit runtime-authority checkpoint.
- Chat and Weave submit the displayed checkpoint ID. The shared
  [browser decision hook](../../apps/web/modules/saas/agents/hooks/useChatApproval.ts)
  suppresses duplicate clicks, handles uncertain outcomes, and ignores receipts
  after the conversation changes or the card unmounts. Conversation persistence uses
  workflow-recorded decisions even when stream completion precedes HTTP delivery.
  Orchestrator approval
  presentation and Direct history parsing live outside the large chat containers.
- Chat control and observation resolve ownership, organization membership and
  project access before addressing a pinned Temporal run. Approval additionally
  checks current execution permission. Older runs recover project provenance from
  an immutable workflow-input query, rather than treating absent memo fields as
  unrestricted organization access. Approval/cancellation emit content-free audits.

The Direct workflow-start confirmations remain local controls, separate from these
Orchestrator/Weave checkpoint decisions. They do not provide durable cross-tab start
idempotency. Exact tool-argument digests, activity-time authorization across every
executor, and Research observation resumption remain open.

Roll out updated Temporal workers before the web/API change. The controller retains
legacy signal semantics on replay while exposing acknowledged decisions to older
runs without altering their recorded timer commands. Workers that lack the new
handlers cannot safely approve through the new endpoint; the endpoint fails closed.
Replay tests cover decisions, expiry, cancellation and historical signals.

Next increments:

1. Extend common lifecycle semantics to durable event identities and approval
   state. Preserve AG-UI interoperability at existing agent interfaces. See
   [ADR-025](../adr/025-versioned-chat-event-contracts.md).
2. Introduce durable run and turn identities with ordered events, replay cursors,
   deduplication and retention. Resuming observation must never start a second run.
3. Separate cancel (stop in-flight work), interrupt (stop the active turn and
   process queued input), and graceful stop (finish current work, launch no new
   step). Define races with completion, approvals and queued messages explicitly.
4. Represent pending/approved/denied/expired approvals and authentication-required
   tools. Bind approval to tenant, actor, run, tool call and argument digest;
   recheck current permissions before execution. Expiry, changed arguments or
   revoked access cannot authorize execution. Never send credentials through chat
   events or Temporal history.
5. Extract message state, transcript, composer, tool cards and approvals from the
   large chat views. Virtualize long transcripts while preserving keyboard focus,
   screen-reader access, selection, scroll anchoring and mounted tool applications.
6. Add authorized conversation forks, plan updates and context-compaction records
   with explicit parent provenance and user-visible explanations.

Acceptance: transport fragmentation and schema tests; all engine outcome tests;
cancel/interrupt/approval races; workflow replay; no repeated write on reconnect;
cross-tenant denial; sibling component tests; accessible long-history rendering.

### 2. Canonical tool governance

Implemented for the existing NHTSA VPIC and Databricks Vector Search registry:

- All eleven registered operations declare structured result schemas. The common
  dispatcher validates results before returning them to either chat or step
  execution. Contract errors identify the operation without echoing provider data.
- Chat discovery advertises the derived output schema, canonical READ/WRITE effect
  and retry safety alongside the existing input schema. Drift tests tie these
  advertised contracts to the definitions actually executed.
- Tests exercise all nine real NHTSA adapters with a mocked HTTP boundary, plus
  Databricks adapter behavior, malformed outputs and sibling discovery/authority
  paths. Tenant and credential gates remain in the existing execution adapters.

This does not yet cover every built-in or external MCP tool, nor introduce durable
approval grants or a unified execution-policy service.

Next increments:

Extend the executor-registry contract rather than add a competing catalog. Provide
adapters for built-in, integration and external MCP tools. Each executable operation
declares input/output schema, effect, retry safety, risk/approval policy, credential
scopes, visibility, display/discovery metadata and audit action. Keep policy
evaluation server-side; model suggestions and remote MCP annotations are not grants.

Discovery and execution must consult the same policy, with a fresh permission
check at dispatch. Unknown operations fail closed. An approval never overrides a
project read-only restriction. Split read/idempotent activity retries from writes
that need a durable idempotency key or cannot be retried after dispatch.

Acceptance: contract coverage for registered tools, schema/discovery drift checks,
wildcard-key live permissions, revoked credentials, denied writes, approval replay,
argument tampering, redacted audits and retry tests for each effect class.

### 3. Permission-aware content and sources

Extend connector contracts with a content node for documents, folders, messages,
issues, repository files, tables and attachments. Include stable source identity,
organization, project when applicable, parent identity, provider revision, canonical
citation, and permission provenance. Credentials are external references, never
content-node fields.

Use adapters for indexed and live retrieval. Enforce access before returning
snippets, counts, titles or citations; revalidate source access after revocation.
Missing/stale permission information fails closed. Cache keys include tenant,
principal, relevant resource scope and permission revision. Deletion and access
revocation must invalidate indexed content and caches.

Acceptance: guest project access, same external ID in different organizations,
revoked group membership, stale ACLs, citation authorization, deletion propagation,
and equivalent permission behavior in RAG, MCP and project context. Prove two
existing providers before expanding the connector inventory.

### 4. Agent-as-code and publication

Implemented:

- Versioned `fabric.ai/v1` JSON/YAML definitions for template/custom instructions,
  skill files, basic model policy and goal execution settings. Export uses an
  allowlist instead of serializing database rows or connection configuration.
- **Export agent** on the agent detail page; **Import agent** in the creation
  builder. Import previews the definition and unresolved setup requirements before
  creating a draft in the selected organization. The detail page retains those
  original requirements for review.
- Server-side destination membership and live role checks, tenant-scoped export,
  strict schemas, duplicate-key/path rejection, depth/size limits and disabled YAML
  aliases. Imports create new local identities and skill ownership in one transaction
  with an `org.agent_definition.imported` audit record. Export emits
  `org.agent_definition.exported`; audit metadata excludes definition contents.
- Connections, knowledge filters, trigger configurations, API exposure and approvals
  are not imported. Only logical setup requirements travel with the definition.
  Conversation history and learned memory are excluded. Instruction and skill text
  are intentional exports and must be reviewed before sharing.

Current limits: model options are restricted to model name, temperature, topP and
maxTokens; availability is reviewed in the destination. Skill files must use
`skills/<name>/SKILL.md`. Requirements record original intent, not a live binding
status. This is portable draft creation, not a complete publication contract or a
lossless backup. Existing version history is unchanged; immutable publication,
execution pinning, version diffs, authorized rebinding and Git sync remain open.

Next increments:

Extend existing stable agent identities and version history. Define a versioned
JSON manifest with a YAML representation for instructions, skill revisions, tool
references, triggers and model policy. Export portable logical references, never
secrets or source-organization database IDs as destination authority.

Import into an explicitly resolved destination organization as a draft. Validate
size, syntax, supported schema version, model availability and resource binding;
show unresolved resources and a diff before publication. Triggers remain disabled
until rebound and authorized. Persist immutable published snapshots and pin each
execution to one snapshot. Rollback creates a new publication from an old snapshot.
Add Git-backed synchronization only after the import and publishing path is sound.
Reuse Sidekick for conversational creation with the same server validation.

Acceptance: deterministic export/import round trips, cross-organization rebinding,
secret exclusion, immutable published versions, concurrent publish behavior,
rollback, trigger permissions and execution-version attribution.

### 5. User-facing observability

Join usage, workflow and audit records by organization, conversation, run, turn,
tool call and agent version. Expose cost and model usage, model/tool latency,
failures, approval wait time, retrieval provenance, retries and timeouts. Distinguish
estimated cost from settled usage and unknown cost from zero. Aggregate without
double-counting workflow retries or replayed stream events.

Extend existing limits to missing agent/conversation scopes using concurrency-safe
reservations and reconciliation. Checks must also cover channel-originated runs.
Gate financial detail using existing billing permissions and resource access.

Acceptance: accounting under retries/concurrency/cancellation, budget exhaustion,
authorized usage visibility, redaction and reconciliation against underlying usage.

### 6. Slack and Teams assistants

Audit existing handlers and workflows together. Normalize verified provider events,
deduplicate within installation/tenant scope, bind the external sender to current
Fabric authority, and map threads to authorized conversations. An unlinked sender
must not inherit an integration owner's unrestricted access.

Use the common governed execution path, durable outbound delivery IDs and provider
adapters for DMs, mentions, updates and rate-limit recovery. Preserve agent/version
identity, citations and approval state. Approval callbacks must authenticate the
actor and bind to the exact pending tool call; duplicated events and callbacks
must not execute a write twice. Apply organization policies and usage budgets.

Acceptance: provider signature/token verification, replay windows, duplicate
delivery, same thread IDs across installations, bot-loop suppression, revoked
sender access, approval expiry, failed replies and equivalent Slack/Teams behavior.

### 7. Conversation artifacts and Frames

Extend existing artifact and Frame surfaces with conversation/run provenance,
versioned updates and authorized sharing. Enforce project/resource access on
preview, download and embedded execution. Keep the existing sandbox/CSP and
validated message protocol; a generated Frame cannot gain tool or credential
authority through its parent conversation.

Acceptance: cross-tenant preview/download denial, version restoration, concurrent
edits, sandbox escape/message-origin tests and accessible artifact navigation.

## Cross-cutting release gates

- Investigate reported Weave routing, tooling and checkpoint defects with a
  reproduction and regression test before expanding orchestration. Existing Weave
  watchdog, implementation bridge and approval-linking tests are starting points;
  the comparison alone is not proof that a particular defect remains present.
- Keep organization-only tenancy and object-level project access throughout.
- Put I/O in activities and replay representative histories for changed workflow
  control flow. Use additive migrations and tenant RLS for new persisted records.
- Add machine-enforced contract, registry and navigation drift tests alongside the
  relevant implementation, including Get Started updates for new product surfaces.
- Release each working increment with its focused tests and explicit changeset
  decision. Do not claim this roadmap complete while later milestones remain open.
