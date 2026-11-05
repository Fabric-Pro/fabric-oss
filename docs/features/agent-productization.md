# Agent productization

Implementation roadmap for governed, operable agents across Fabric's existing orchestration platform.

- **Audience**: Product and engineering
- **Owner**: Engineering team
- **Status**: In progress; shared chat transport, Orchestrator/Weave checkpoint controls, and portable draft definitions are implemented; Direct approval resumption is explicitly unavailable; broader parity remains open.

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
| Artifacts | [Project artifacts](../../apps/web/modules/saas/projects/components/ProjectArtifactsList.tsx), [Frames](../../apps/web/modules/saas/frames/components/FrameViewer.tsx), chat artifact panels | Consistent conversation attachment, version history, authorized sharing and execution policy |

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
- EOF without an explicit outcome is an interrupted reply. Orchestrator and
  Research reconnect to the existing run within bounded retry budgets; contract
  failures and authorization refusals do not trigger reconnection. Research keeps
  buffered partial output and pending tool state across observation windows, checks
  for silent connections, and stops observing when the user stops or leaves the
  conversation. Reattachment carries the run identity and authorization scope,
  without resending the message, attachments, or tool configuration. A stream that
  never identifies its run is not retried automatically.
- A short-lived PostgreSQL output journal records primary-run text, tool,
  iteration, limit and compaction events before live publication. Research and
  Orchestrator request replay after their last applied cursor; duplicate and older
  entries are ignored before updating the UI. Cursors identify the server-admitted
  turn and physical Temporal run, and authorize nothing by themselves. Research
  persists exact text, tool state and its cursor together for history resumption.
  Replaying output never dispatches a tool, starts a workflow or submits approval.
  Pending approvals and cancellation are refreshed from authoritative workflow
  state rather than replayed as commands.
- Replay reads recheck current run/project access, fail on expired or mismatched
  cursors, and stop delivery after observation cancellation. The replay window is
  24 hours from turn admission, with at most 20,000 output entries per run (plus
  one gap marker) and 1 MiB per entry. Credential fields are redacted before storage. Expired rows are removed
  in bounded batches by the daily request-span
  retention activity; deleting a turn cascades to its output. Storage failures or
  output limits stop replay explicitly, while workflow execution remains separate.
  Journal failure also survives worker changes through a private activity-result
  flag and a query-only workflow interceptor. Redis wakes serialized reads;
  terminal results remain available after journal expiry or gaps.
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
idempotency. Direct also accepts client-supplied `approvedToolCall` arguments rather than a
server-issued pending checkpoint; that payload is not durable proof of human approval, although
executor resource authorization remains necessary. Gate protected Direct mutations on a persisted,
single-use, expiring checkpoint bound to the admitted run, actor, organization, tool and argument
digest. Do not trust a forged/replayed client assertion or dispatch an unkeyed write from a
retrying chat activity. Use the shared idempotent action/receipt boundary; where an effect cannot
be reconciled or made retry-safe, refuse automatic retries and surface the uncertain outcome.
Exact tool-argument digests, activity-time authorization across every
executor, and broader lifecycle-event convergence remain open. The journal covers
committed primary-run output, not uncommitted provider chunks, external AG-UI
streams, or the history of every approval transition. The final workflow result
remains authoritative. Old workers retain live-only behavior during rollout.
The flag-gated CopilotKit agent-runtime transport retains its current observation
semantics; it needs a separate cursor integration before the stream transport can
be retired. Shared observer and turn-state helpers preserve both paths.

Apply the additive replay-journal migration and RLS policies before updating
workers and web/API. Updated workers persist output independently of browser or
Redis availability; updated browsers explicitly opt in to cursor replay. Older
clients continue using live events. The existing daily request-span retention
schedule also purges expired replay output, independently of the request-span
retention period. No workflow command/control-flow change is required.

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

Before admitting new mutating Harness/Genie/report/deployment actions, bind the authorization
contract to organization, current actor/grants, run, tool/action identity, target and argument digest.
Actions requiring a human decision use an exact runtime-authority checkpoint; generic chat
approve-all cannot satisfy that decision or a later changed write. Reject stale, altered or replayed
approval for another operation and recheck at dispatch. Idempotent retry attaches to the original
operation/decision rather than asking the user again or consuming authority for different arguments.

Bounded autonomous draft/artifact writes may use an explicit approved policy with the same resource,
action, destination, time and budget constraints; this is not a mandate for a human prompt before
every harmless report update. Model assent and generic approve-all are not such a policy. Preserve
existing publication/write-lane rules and add negative tests for approve-all, changed arguments,
expired/revoked grants and a second unrelated write, plus a positive exact-retry test.

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

### Default creation and deliberate advanced implementation

Implemented default authoring preserves the current Agents page, template/custom creation builder, instance identities and Temporal
execution. The default creation experience asks for a purpose, selected Project/knowledge and
expected output. Offer a few relevant starters such as project assistant, documentation maintainer
and recurring report; creating a report directly still uses Reports and its template builder.
Do not require every report/document to become a new persistent agent.

Use the existing Sidekick to propose editable name, description and instructions. Show the selected
sources, allowed capabilities and output in a compact review. A sample invokes the normal authorized
Fabric run path and shows real results/citations, or a truthful setup/error state. Sampling is an
explicit bounded action, not an implicit charge on every field edit; saving configuration remains
possible without a successful sample. Default invocation is on demand. Activating a schedule,
external delivery or write action is a deliberate authorized action. Reuse the organization's
configured model policy and inspectable server-enforced limits. No Databricks resource IDs,
credentials, runtime matrix or native console is part of this path.

Qualify the reused builder rather than assuming its current controls meet this contract. Remove
Sidekick's mount-time paid request; conversational assistance and the sample each start from an
explicit user action. AI-suggested field/tool/MCP changes are reviewable proposals, with permission
expansion explicitly accepted before activation. Remove simulated `setTimeout` AI generators or
label deterministic template suggestions accurately. Persist a typed selected-project binding and
expected-output contract through create/update/import; verify its organization and current project
access on the server and again when activities load it. A JSON project-context tool setting is not
an authorization grant. Test no-spend-on-open, declined suggestions, changed bindings, invalid
project IDs and preserved advanced values.

An **Advanced configuration** expander edits the same definition and preserves existing values:

- Existing goal-oriented execution, success criteria, iteration/time/tool limits and supported human
  checkpoints; no second loop editor.
- Selected knowledge/data scopes, read/write tool actions, required approvals and live connection
  readiness; a connected server does not implicitly grant all its tools.
- Prompt/model policy, output schema, skill/dependency release pins, webhook/API exposure, timezone,
  delivery audience and retention where supported.
- An optional supported Harness implementation artifact when configuration is insufficient. Finite
  work uses `defineAgent()` from the strict public SDK contract; persistent `createAgent()` is
  selected only for an addressable cross-interaction requirement. Compile/package reviewed code in
  a qualified build boundary, never evaluate arbitrary imported TypeScript in the application API.

Advanced authoring does not require infrastructure-admin rights. The server validates the same
commands and resource permissions for builder, import, API, CLI and MCP callers. Publishing an
implementation pins its schema, package/protocol generation, repository revision/artifact digest,
logical tool/context requirements and bindings. Surface unsupported requirements before activation.

Pin the implementation entrypoint as well as the artifact: finite job name or explicit
`responses.agent`/exported agent identity, entry module and expected protocol/input/output schemas.
The current Harness App build can select the first persistent agent when `responses.agent` is
omitted; a matching multi-agent bundle digest therefore does not prove the intended agent is being
served. Reject ambiguous artifacts in the initial adapter. Test the correct bundle with a wrong
selected agent, reordered/default selection, and a mismatched entrypoint or schema before allowing
publication, evaluation or invocation.
Retain existing workers as the default; platform routing selects a qualified provider from an
approved policy and never silently changes the identity/runtime of an admitted run.

Harness augments existing Fabric-created agents; it does not require rewriting all current loops,
replacing their workers, importing a sibling source tree, or creating a second user-facing registry.
A public finite-job or persistent-invocation adapter carries bounded inputs, versioned bindings,
receipts/events and output/artifact references. Temporal retains application schedules, approvals
and delivery recovery; provider-local session/submission durability is a separate subordinate
contract. The framework builders remain independently usable outside Portal.

### 4. Agent-as-code and publication

Implemented:

- Versioned `fabric.ai/v1` and `fabric.ai/v2` JSON/YAML definitions for template/custom instructions,
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

The v2 descriptor additionally pins implementation kind, repository/package artifact identity,
entrypoint and protocol/input/output schema hashes, and carries logical destination binding
requirements. Import creates a disconnected draft with no triggers, API exposure or copied approvals.
Unsupported implementations are inspectable and exportable but cannot publish, activate, expose
an API or execute through native fallbacks. A v1 export refuses a lossy Harness conversion.
Generic configuration updates cannot overwrite reserved implementation metadata.

The public finite Harness client adapter validates complete trusted-target configuration and
real actor/project allowlist arrays before admission. Credential/client preparation precedes
claiming the job. Only a request that might have reached the transport is classified as uncertain;
known local aborts use a durable not-started receipt. No live target or persistent hosting is implied
by the existence of this adapter.

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

Version this publication schema to include an optional implementation descriptor: existing native
runtime, `harness_finite` or `harness_persistent`, with public package/protocol generation,
repository revision, artifact digest and exact entrypoint/schema requirements. The current v1
portable-draft schema cannot silently round-trip an advanced implementation. An older exporter
must refuse unsupported implementations or explicitly offer a clearly labeled configuration-only
draft; importing one must never activate a different runtime by default. Code-owned fields remain
read-only in UI/YAML until a rebuild produces a new release. One manifest references the reviewed
artifact rather than maintaining a competing editable copy of its TypeScript logic.

Import into an explicitly resolved destination organization as a draft. Validate
size, syntax, supported schema version, model availability and resource binding;
show unresolved resources and a diff before publication. Triggers remain disabled
until rebound and authorized. Persist immutable published snapshots and pin each
execution to one snapshot. Rollback creates a new publication from an old snapshot.
Add Git-backed synchronization only after the import and publishing path is sound.
Reuse Sidekick for conversational creation with the same server validation.

Include deployment/team lifecycle and rollback in this release slice. Characterize
`packages/api/modules/agent-deployments/`, instance update/restore queries and
`packages/api/modules/agents/procedures/restore-instance-version.ts`: require matching non-null
organization, current execution permissions and a worker-polled supervisor queue, with durable
start/receipt reconciliation. Team adoption or a second member's edit cannot inherit another
person's private OAuth or departed-owner authority; require explicit authorized rebinding where
necessary. Authorized organization-agent discovery/mentions must agree with the directory.
Restore preserves all executable snapshot fields, including instruction/skill memory files and
API policy, but disabled/revoked credentials, exposure or triggers do not reactivate through
rollback. Keep declaration separate from live grants and require normal activation checks.

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
