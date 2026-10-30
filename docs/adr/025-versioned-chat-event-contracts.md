# ADR-025: Versioned chat event contracts

Proposed direction for typed chat transport and incremental engine convergence.

- **Audience**: Engineering
- **Owner**: Engineering team
- **Status**: Proposed
- **Date**: 2026-09-28
- **Deciders**: Pending engineering review

## Context

Direct, Orchestrator and Research historically decoded SSE independently and
consumed untyped values inside React hooks. Connection closure can be mistaken for successful completion,
and producer events can lack corresponding consumer handling. Fabric also has
Orchestrator and AG-UI interfaces whose event names and lifecycle contracts differ.

## Decision

Propose schema-derived discriminated event contracts shared by producers and
consumers, transport decoding outside React, and explicit turn outcomes. Introduce
an additive top-level `version: 1` on the existing Direct and Orchestrator SSE objects. Continue
accepting legacy unversioned events during rolling deployment; reject unsupported
versions and malformed known events while tolerating unknown event kinds for
additive evolution. EOF alone cannot complete a reply.

The implementation covers Direct and Orchestrator route producers and Direct,
Orchestrator and Research consumers through one transport reader. Existing
Orchestrator reconnects observe the same run; malformed contracts fail without
reconnecting. Research retains legacy text/completion aliases. Primary
Orchestrator-run output also uses a temporary PostgreSQL journal, described below.
It retains existing
workflow signals and adds the opt-in decideApproval Update as an approval
authority, plus the chatRunContext query for authorization context. Preserve AG-UI at existing agent interfaces. Keep the browser-safe
schemas in the web application until other consumers justify a shared package.

## Alternatives Considered

- Continue using untyped JSON in each hook: permits producer/consumer drift and
  duplicates transport behavior.
- Replace all wire protocols immediately: couples every engine and deployment to
  one migration, including AG-UI consumers.
- Add event types without connecting producers and consumers: provides no runtime
  validation or user-facing reliability improvement.

## Consequences

The Direct and Orchestrator routes declare the event shapes they emit. The browser
validates received events and retains partial text when the transport is interrupted.
Existing clients can still read the unchanged top-level event fields. Validation
failures must avoid logging event bodies because tool results can contain sensitive
content. Future resume support must observe an existing run without automatically
replaying a request that could execute writes again.

The [productization roadmap](../features/agent-productization.md) defines the later
durability, governance and UI milestones and their acceptance gates.

## Output replay cursors

Updated clients opt in with `eventReplay: true` and reattach with an optional
`afterEvent` cursor containing `turnId`, `runId` and a decimal bigint `sequence`.
These fields are observation positions, never execution or approval authority.
The route resolves current ownership, organization membership, project access and
the pinned run before reading the journal, and periodically rechecks access while
delivering output. A cursor for another run, a missing entry or an expired entry
ends observation explicitly rather than silently skipping a gap or starting work.

Primary-run activity publishers append text, tool, iteration, limit and compaction
output before notifying Redis. Cursor-bearing Redis notifications wake a serialized
journal drain immediately, independently of slower workflow status polling.
A one-second journal poll covers lost notifications without adding a database
read to every 200 ms workflow-status poll. Small text chunks are coalesced for up to 50 ms
or 8 KiB of text; buffers drain before a later event or activity completion.
The database serializes append commits under the
parent turn lock; a source key makes a retried physical publication idempotent.
Each entry projects to one SSE event, carrying `eventCursor`. Consumers discard
older/duplicate entries and acknowledge a position only with the state it
produced. Snapshot events, including current pending approvals and final results,
retain their existing unnumbered semantics. No replayed event executes a command.

The journal is a transport cache, retained for 24 hours from turn admission and
bounded to 20,000 output entries per physical run (plus one gap marker) and 1 MiB
per entry. Credential keys use the shared denylist before storage; a narrow
allowlist preserves ordinary tool fields such as `mapping` and `maxTokens`,
while still recursively redacting credentials inside them. Expired rows are not readable and are purged in bounded
batches by daily request-span retention. Turn erasure
cascades to its journal. A failed append never advertises a resumable position;
known output gaps stop observation while the workflow continues independently.
An activity interceptor records an unavailable flag in its Temporal result when
journaling fails, overflows its 32-entry pending queue, or the activity retried.
A query-only workflow interceptor rebuilds a sticky integrity flag from those
recorded results, strips the private field before workflow code consumes them,
and schedules no commands. Readers check that flag after reading journal rows
and before delivery, so another worker cannot silently splice past a failed
producer even if the database gap-marker write also failed. Legacy histories
without the flag retain their results and command sequence. Journal appends retry
one transient failure with the same source key; definitive output limits stop
immediately. Activities retain heartbeats while draining, and Redis commands
have a three-second timeout.
Uncommitted provider output cannot be recovered from this journal, and legacy
workers still provide live-only updates. The final workflow result remains the
authoritative answer. Terminal turn records bypass the transport cache, including
expired cursors and incomplete journals; a newly terminal workflow drains its tail
before delivering its outcome. Access-check failures never use that fallback.

The flag-gated `/api/agents/runtime` transport is a separate rollout. This
milestone adds cursors to the Orchestrator stream endpoint and its Research and
Orchestrator hooks. The extracted execution observer and turn-state helpers
accept replay callbacks and resume options; callers that omit them retain the
runtime's current event semantics. Extend cursor recovery to the runtime before
retiring the stream transport.

Deploy the migration and RLS policies before workers and web/API. Older readers
ignore cursor metadata; older workers retain their current publication path.
Only activity I/O changes; no Temporal workflow command sequence changes.

## Opt-in approval Updates

`ORCHESTRATOR_APPROVAL_UPDATES_ENABLED` defaults to off. Only the exact string
`true` enables it, and only web/API starters read it. Deploy this code to all
workers first, then enable the switch on web/API. Workflow input and memo capture
`approvalProtocol: 2` together at start. Existing runs keep their original
protocol even when the switch changes. Workflow child starts remain legacy.

Without that memo value, approval routes submit the legacy pending-ID `approval`
signal; success confirms submission, not workflow acceptance. Protocol-2 runs
served by the new web/API use `decideApproval` Updates and require an accepted
receipt; stale, expired and rejected decisions do not report success. Legacy
web/API versions can still send approval signals to protocol-2 workers through
the legacy-signal adapter.

Before enabling, web/API and workers may roll forward or back independently for
legacy approvals. After enabling, histories that accepted an Update cannot replay
on workers older than this change. To roll workers back past this change, turn
the switch off and let protocol-2 runs finish first. Turning it off does not
convert existing protocol-2 runs to the legacy protocol. Web/API rollback retains
legacy signal-submission semantics and does not remove recorded Update events.
