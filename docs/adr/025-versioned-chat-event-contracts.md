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
disables replay for that connection and emits a non-terminal `replay_unavailable`
notice. Redis live forwarding continues and clients reconnect without replay or a
cursor. When a resumed window loses continuity, the Orchestrator client replaces its
text on the next delta, as a resumed window did before the journal (#2269). Only a definite `ChatRunAccessError`, direct or carried by
`ChatReplayAuthorizationError`, ends observation. Other authorization lookup errors in
`createChatReplayObserver.initialize` or its re-check degrade the already-authorized
connection to live-only.

Primary-run activity publishers append text, tool, iteration, limit and compaction
output before notifying Redis. Cursor-bearing Redis notifications wake a serialized
journal drain independently of slower workflow status polling, with wake-driven drains throttled to about once per second. Multi-page drains check integrity once per page. Terminal observation forces a final integrity check.
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
batches by `purgeExpiredConversationTurnEvents` from `request-span-retention.ts` on the request-span retention schedule registered in `schedules.ts`. When `FABRIC_REQUEST_SPAN_RETENTION_ENABLED=false`, registration does not create the schedule; an existing schedule keeps running until deleted. Reads still hide expired rows. Turn erasure
cascades to its journal. A failed append never advertises a resumable position;
known output gaps disable replay while live observation continues.
An activity interceptor records an unavailable flag in its Temporal result when
journaling fails, overflows its 32-entry pending queue, or a retried activity publishes output. Activities that publish nothing do not flag retries.
A workflow interceptor rebuilds a sticky integrity flag from those
recorded results, strips the private field before workflow code consumes them,
and adds no workflow commands. While old and new workers overlap during a rollout, a
producer that runs on an old worker writes no journal rows and is flagged only when it
completes, so a cursorless reload in that window can replay an incomplete journal. The activity interceptor flushes output and rethrows the
original failure unchanged. The workflow interceptor conservatively flags any failed
activity in `chatReplayProducerActivities`, including failures from old workers whose
journal state is unknown; failed non-producers do not flag. Missing metadata from the
output activity families in `chatReplayProducerActivities` also disables replay during
mixed-worker rollout. Readers check that flag after reading journal rows
with wake-driven drains throttled to about once per second; a multi-page drain
checks once per page, and terminal delivery checks again, so readers detect recorded producer failures even if the database gap-marker
write also failed. Legacy histories
without the flag retain their results and command sequence. Journal appends retry
one transient failure with the same source key; definitive output limits stop
immediately. Activities retain heartbeats while draining, and Redis commands
have a three-second timeout.
Uncommitted provider output cannot be recovered from this journal, and legacy
workers still provide live-only updates. The final workflow result remains the
authoritative answer. Terminal turn records bypass the transport cache, including
expired cursors and incomplete journals; a newly terminal workflow drains its tail
before delivering its outcome. Definite access denials do not use that fallback.
`createServerChatReplay` checks the run's gap marker through a scoped unique-key
lookup before reading a cursorless backlog. It streams pages without staging the
full backlog and validates workflow integrity before delivering each page. Empty
cursorless drains recheck the marker until the first row is sent. Replay with a
cursor skips the point lookup and can deliver valid continuations up to a gap
marker.

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
