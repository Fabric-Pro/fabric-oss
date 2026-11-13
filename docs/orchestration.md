# Orchestration

Intelligent multi-agent coordination system that routes tasks to specialized agents and MCP tools.

- **Audience**: Backend/AI developers
- **Owner**: Architecture team

---

## Architecture

```
User Request
  -> Intent Analysis (LLM-powered)
    -> Capability Matching (priority order)
      1. MCP Tools (direct API, fastest, most deterministic)
      2. Specialized Agents (domain-specific, workspace access)
      3. Workspace Operations (RAG retrieval, document read/write)
      4. Workflow Triggers (published Temporal workflows)
      5. Generalist Agents (autonomous multi-step, e.g. CUGA)
    -> Execution (step-by-step or delegated)
    -> Result Aggregation
```

## Core Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Type definitions | `packages/temporal/src/workflows/orchestrator/orchestrator-types.ts` | Capability types, task steps, agent registry |
| Execution engine | `packages/temporal/src/workflows/orchestrator/orchestrator-activities.ts` | Routing, planning, step execution |
| Workflow | `packages/temporal/src/workflows/orchestrator-execution.ts` | Temporal durable workflow |
| Direct mode | `apps/web/app/api/agents/fabric-ai/orchestrator/` | Non-Temporal execution path |
| UI | `apps/web/modules/saas/agents/components/FabricChat/` | Chat interface with HITL |

## Discovery Protocols

| Protocol | Purpose | Endpoint |
|----------|---------|----------|
| A2A | Agent capability discovery | `GET /.well-known/agent.json` |
| MCP | Tool/resource discovery | `tools/list`, `resources/list` |

All discovery is dynamic at runtime. No hardcoded agent or tool registries.

## Execution Modes

| Mode | Max Steps | Planning Depth | Use Case |
|------|-----------|---------------|----------|
| Lite | 10 | Minimal | Fast, single-tool tasks |
| Balanced | 20 | Standard task plan | Multi-step operations |
| Deep | 25 | Extensive planning | Complex research/analysis |

## Risk-Based Approval

| Risk Level | Operations | Approval |
|------------|-----------|----------|
| Low | Read-only (get, list, search, fetch) | Auto-approved |
| Medium | Update/modify | May require approval |
| High | Create new resources | Requires approval |
| Critical | Delete, bulk operations | Always requires approval |

### Answers to expired or replaced approvals

The Temporal chat sends the pending `approvalId` with Approve, Decline and
Feedback requests to `POST /api/agents/fabric-ai/orchestrator-temporal/approve`.
After checking access to the execution, the route compares that ID with the
workflow's current pending approval. If no approval is pending or the supplied ID
does not match, it returns HTTP 409 with `code: "APPROVAL_NOT_PENDING"` and sends
no approval signal.

The hook classifies HTTP 409 as `stale`. It clears the old controls and approval
progress only if the current pending ID still matches the submitted ID. A newer
approval that arrived while the request was in flight stays visible. All three
handlers show `This approval was already answered or has expired.` and omit the
success notice used for an accepted decision.

The global fetch interceptor leaves HTTP 409 with `APPROVAL_NOT_PENDING` on this
exact approval pathname to the chat's handler, returning the original Response.
Other statuses, codes and paths retain their error reporting. This prevents a
duplicate generic AI failure notice for an expected stale answer.

The response contract is defined in
[`approval-response.ts`](../apps/web/modules/saas/agents/lib/approval-response.ts).
The route and workflow also check pending approval identity before accepting an
answer; clearing a card in the client grants no execution permission.

## Agent Delegation

The orchestrator adapts delegation based on agent capabilities from A2A cards:

| Agent Type | Delegation Mode | Orchestrator Behavior |
|------------|----------------|----------------------|
| Generalist (`autonomousExecution: true`) | `complete-task` | Passes full task as high-level goal |
| Specialist (`autonomousExecution: false`) | `single-step` | Decomposes into steps, delegates individually |

## Tool Discovery Token Optimization

- Tool definitions can consume 50K+ tokens if loaded upfront
- Orchestrator uses semantic matching to filter relevant tools per task
- Only matched tool schemas are included in the LLM context
- Result: ~99% token reduction vs loading all tools

## State Management

| Mechanism | Purpose |
|-----------|---------|
| `VariableContext` | Cross-step state passing |
| `OrchestratorWorkspace` | Context preservation across delegations |
| `Trajectory` | Execution history for learning |

## Advisor allowance and cached history

Ledgered Advisor turns retain raw input and output usage on request attempts.
Settled allowance charges input outside the read cache at full weight, plus a
ceiling-rounded tenth of reported cache-read input, plus output. Missing cache
breakdowns charge the full input. Cache writes remain full weight. Contract v1
accepts both old workers' full-weight settlements and new workers' weighted
settlements; deploy the nullable attempt column migration before new workers.
Old attempts may have a null cache-read count and settle at full input weight.

Reservations still use the full input estimate because cache hits are known
only after the response. The last part of an allowance smaller than one full
minimum reservation cannot be used; this is a deliberate conservative admission
rule. Raw usage telemetry remains suitable for provider usage accounting.

The weighted card starts from the latest ledger reading and adds raw recorded
usage after that reading, including completion-claim checks, delegation-risk
judgments and compaction (also when its summary is empty). Capturing the cost
index with a new reading absorbs earlier costs without counting them twice.
Retention diagnostics recompute `afterRoom` after compaction charges.

Advisor cache anchors use the workflow messages' iteration tags: the preceding
request ends immediately before the first message of the newest recorded
round. This includes multi-call rounds and assistant-text/correction-note
rounds. The activity's map conversion preserves message indices; vision alters
parts only, and the host note is appended after marking. Without round tags,
only the rolling history anchor is used.

With `ADVISOR_TOOL_LOADING=call_tool`, new runs keep the provider's tool list
fixed for the whole answer. `search_tools` returns tool definitions as text
instead of attaching the tools, and two fixed tools act on what it found:
`get_tool_schema` returns a found tool's definition and `call_tool` runs it.
`call_tool` reaches only tools the request itself offered, or that search
returned on an earlier request of the same answer, with the first binding kept.
The real tool is resolved before risk checks, approval and dispatch, and history
keeps the `call_tool` wrapper. Leave the setting unset in shared environments
until tool bindings are re-checked right before dispatch and tool arguments are
validated against the tool's schema.

Advisor chat turns (`input.turnId` is set) keep individual tool results up to
32,000 characters for runs recording `orch-tool-result-cap-v2`. What happens to a
larger result depends on the result-read decision described below: an exact
beginning with a reference when it is true, summarization otherwise. Replays without
that marker retain the 12,000-character allowance. Other runs of the workflow
keep 12,000 and do not evaluate this marker. The workflow-safe
`toolResultCap` helper in `packages/temporal/src/workflows/orchestrator/tool-result-cap.ts`
preserves the 64,000-character skill allowance and the unlimited `get_tool_schema`
allowance in `call_tool` mode. Pagination and repeat labels reserve space within
the selected cap; they can cause a result that fits alone to be shortened.
Paged Fabric body reads request at most 24,000 characters with that same marker
decision on chat runs, and at most 8,000 otherwise. The `pagedBodyMaxLength`
helper selects this allowance; results that overflow after JSON escaping retain
their pagination fields through the over-cap path. History retention can
prune or compact results later under the rules below.

The workflow entry point captures the result-read decision once per run:
`usesIterativeExecution` checks the execution mode, then
`advisorResultReadsEnabled` in
`packages/temporal/src/workflows/orchestrator/advisor-result-read.ts` checks
`turnId` before evaluating `orch-advisor-result-reads-v1`.
The short-circuit conditions prevent evaluating this marker for non-chat runs
(story automations, Weave, project setup) and the upfront `save_reuse` planner.
Iterative chat runs with a true marker offer the read tool.
Unknown fields from earlier starters are ignored.

Non-chat runs and replay of earlier histories without the marker keep the
summarizer and existing history placeholders. The `resultRef` exclusions keep
over-cap results of `load_skill`, `read_skill_file`, `get_tool_schema` and
`advisor_result_read` itself on the summarizer path.
During a rollout or rollback, a worker without this code can pick up a run that
started on a worker with it. That worker skips the marker and continues in the
old mode. Its workflow task fails only when the recorded commands differ, for
example after the model called `advisor_result_read` or an over-cap result
skipped the summarizer, and it keeps failing until a worker with this code picks
the task up. Drain chat runs before rolling workers back.

An enabled answer offers `advisor_result_read` on its first model request in
both tool-loading modes. For same-run refs, the workflow dispatches it locally against the existing
`state.toolCalls` records, without another activity or store. Refs such as `r3`
identify result ordinals in this run, independent of provider call ids. The
`resultRef` helper excludes `load_skill`, `read_skill_file`, `get_tool_schema`
and `advisor_result_read` results. Refs expire with the answer; they do not
address results from an earlier answer.

Arguments are `ref` (required string), `offset` (nonnegative integer, default 0)
and `limit` (integer, default 16,000, clamped to 1..24,000). The
`readAdvisorResult` validator returns the same content-free
`{"v":1,"status":"unavailable"}` for malformed arguments, unavailable refs,
and invalid offsets, including an offset inside a UTF-16 surrogate pair.
A successful page is JSON, for example:

```json
{"v":1,"ref":"r3","tool":"example_read","offset":0,"nextOffset":16000,"totalCharacters":40000,"text":"..."}
```

Offsets and sizes count UTF-16 code units. `text` is the exact substring of the
original `extractMcpResultText` projection. `nextOffset` is omitted at the end;
an offset equal to the total length yields an empty final page. Page boundaries
move back to avoid splitting surrogate pairs. A limit of 1 at an astral
character can yield an empty page with the same `nextOffset`; request at least 2
to advance there. `readAdvisorResult` sizes the serialized JSON, including
escaping and metadata, to the result cap minus 512 characters for host notes.
It shortens the text and updates `nextOffset` when necessary. Metadata that
cannot fit yields the unavailable response.

For an enabled answer, a result that fits the cap retains its original tool
message content. The loop adds no reference note to ordinary results. Refs become
visible in over-cap head notes, pruned placeholders and the compaction list.
When an over-cap result has a readable ref, the loop replaces its summary with an
exact head and a host note giving the real ending offset, total size and ref to
continue.
`exactResultHead` reserves note space before slicing. Continuation fields and
repeat labels retain their existing notes; `search_tools` and `get_tool_schema`
retain the plain-cut exception in `call_tool` mode. Results without a ref keep
the existing summarizer or plain-cut path; excluded skill/schema results do not
receive an exact-head note. Page dispatch declares a read-only result; the `isResultPage` branch
excludes it from over-cap processing and from the result-preview log.

Both history pruners use `resultReadPlaceholder` for referenced results, keeping
the read-back instruction within the 300-character placeholder budget.
Pages remain eligible for pruning and receive no ref. After compaction,
`resultRefCatalog` adds a host-written list of the 30 most recent eligible refs,
tool names (bounded to 128 characters) and sizes. Older entries leave that list
but remain readable by a known ref in this run. Full result bodies stay in the
original records; output truncation still builds separate bounded copies.
`resultReadRecord` removes page text from each read call’s recorded result,
keeping version, source ref/tool, offset, optional next offset, returned and total
character counts, and status. The read call still occupies its ordinal slot.
Its full page remains in the model’s conversation tool message. Completion-child
call records retain the small metadata object, rather than another copy of the
page body. `renderPartialFindings` and `recordedResultForPresentation` use the
run’s `advisorResultReadsEnabled` decision to identify host read records.
On enabled runs, the former excludes those records before selecting its three
latest successful findings, and the latter omits receipt content from flat and
nested public tool results and the awaiting-auth output. This also excludes
receipts from the result-to-artifact builder and generic tool-output UI.
On disabled runs, a same-named external tool retains its ordinary result,
artifacts and partial findings. The upfront planner’s run decision is off, so
its nested results and awaiting-auth output retain external tool content.
Read names, arguments and status remain available as execution history; the
internal record and its ordinal slot remain intact.

Histories recorded before this feature replay through the original branch because
`patched()` returns false when the marker is absent during replay. The captured
`state.advisorResultReadsEnabled` decision keeps these runs on their original
tool, summarizer and presentation paths.

Workers predating this marker can skip its marker event, but still apply the old
cap. Replaying a marked history on those workers can therefore diverge when a
result between the caps omitted a summarizer activity. Drain affected runs before
rolling workflow workers back past this change. New workflow workers may send
`maxOutputLength` up to 31,500 to older activity workers: `summarizeLargeToolResult`
already accepts a numeric target and derives its generation budget from it.

With `ADVISOR_HISTORY_RETENTION=bounded`, new runs retain earlier tool results
until the decision below selects a rewrite. A reset keeps the last three tool
pairs, the existing recent-iteration exemption, skill bodies, paged source
reads, frame windows, and pre-turn history. Clearable results need positive read
knowledge: a Fabric-owned read under the captured approval rules, or an explicit
read-only declaration recorded by the executor. MCP declarations come from the
server's `readOnlyHint: true`; connected GitHub tools use their static registry
flag; operation-registry tools use their declared READ access. Missing declarations
(including old activity results), writes, and ambiguous call ids remain kept.
Kept results contribute no reset savings; `keptNonReadOnlyResults` logs their count
without content. This guard is part of the undeployed bounded-v2 policy.
The bounded-v2 decision uses calibrated prompt size
`S = ceil((estimate + extra input) × factor)`, full uncalibrated minimum
reservation `R = estimate + extra input + 1,024`, serialized activity-input
bytes `B`, and ledger exploration room (allowance minus charged measured usage,
outstanding reservations, and finalization reserve). The soft cap `C` is
`min(100,000, floor(0.6 × context window))`, or 100,000 without a known window.
The context hard limit uses the known window itself.

The byte cap and context window are hard technical limits. Allowance triggers
are disabled when no turn ledger exists; size limits remain active. `S > C` and
approaching allowance pressure (`R <= room` but `R + 16,384 > room`) are soft
triggers. A refused reservation (`R > room`) bypasses the soft guards for a
rescue attempt. Without a technical hard limit, apply the full reset only if
it makes `R <= room`; an unrescuable request reaches the ledger unchanged and
ends the turn through existing allowance handling, without a ledgered
compaction call for refusal.

| Condition before the main request | Selected action |
|---|---|
| No size or allowance trigger | `append` unchanged. |
| Soft triggers only, and a reset or compaction rewrote the preceding round | `append` unchanged. |
| Soft triggers only, with no preceding-round rewrite | `reset` if eligible results free at least 20,000 calibrated tokens; otherwise `append`. The soft-only decision branch does not select compaction. |
| `R > room`, without a technical hard limit | Try the full reset without a savings floor or consecutive-round restriction. Apply it only if the resulting reservation fits; otherwise `append` unchanged. This branch does not select compaction. |
| `B > 512 KiB` or `S > context window` | `reset` without a savings floor or consecutive-round restriction. If a byte or context limit remains afterward, also try `compact`, retaining the reset's changes. |

For these trigger classes, the reset loop replaces all eligible read results
oldest first, with the protection and positive-read guards above enforcing
eligibility. It does not stop once a threshold clears; freeing that backlog
allows subsequent requests to append until another trigger fires. A reset with
no eligible results is a no-op. The soft-only consecutive-round guard prevents
adjacent rewrites, and its savings check enforces the 20,000-token floor for
approaching allowance pressure and soft size triggers. Refused-round resets
are the allowance exception: they may free less than 20,000 calibrated tokens
or follow a rewrite, but only when the original reservation would not fit and
the reset makes it fit. Technical byte/context limits keep their existing
reset and compaction handling when they overlap refusal.

The cumulative-spend compaction path is disabled for v2; the existing compactor
and its cooldown run only for an unresolved technical hard limit. The loop
applies the reset before invoking the compactor, preserving placeholders if cooldown,
short history, an empty summary, or a failed summary leaves compaction unchanged.
A changed reset or changed compaction records the round as a rewrite. If both
still leave a technical hard limit exceeded, existing over-limit request
handling remains in effect.

Calibration uses recorded provider input divided by the estimate, clamped to
0.25–2, with 1 when counts are missing. It does not discount reservations for
expected cache hits. History diagnostics record the action, reason, calibrated
size, soft/hard trigger flags, reservation, room, and tokens and bytes freed,
including in request and turn summaries. Refusal-only decisions use the reason
`allowance_refused`, including when the reset cannot rescue the request. Under
the weighted-allowance marker, the final budget card uses
the same charged ledger usage and turn allowance as the in-turn card; histories
without that marker retain the default denominator. Historical v1 runs retain
their 32,000-token policy; runs with the setting unset retain age pruning.

## Advisor tool-result snapshots

Advisor chat turns with a conversation keep owner-scoped snapshots of successful
reads for two days from the attempt that last wrote the row. A snapshot is a
result that an attempt of that tool call returned; it is not guaranteed to be
the result the workflow recorded. When a retried call's later attempt stores
nothing (it failed, exceeded a limit, or its store write failed), a snapshot
written by an earlier attempt remains. A reader must take its listing and its
pages from the stored row, not from the workflow's record of the call. [`advisorResultStoreFields`](../packages/temporal/src/workflows/orchestrator/advisor-result-store.ts) supplies the
server-admitted turn and conversation; the producing activities call
[`storeAdvisorResult`](../packages/temporal/src/activities/advisor-result-store.ts) before returning their existing result. No extra activity
passes the result through workflow history. Older activity workers ignore the
optional store metadata; newer workers skip storage when it is absent.

`storeAdvisorResult` admits the loop's declared built-in reads and Fabric
catalog tools whose declared access is `READ`, only on their Fabric route.
It rejects external MCP routes and explicitly excludes `load_skill`,
`read_skill_file`, `get_tool_schema`, `search_tools`, and `advisor_result_read`.
Undeclared tools do not qualify. RAG activities suppress snapshots after a
retrieval exception or workspace-settings fallback without changing their public
result. Meeting listing reports success internally only after an authorized
lookup completes. Slack and Teams require an empty `errors` array; Teams also
rejects vendor error responses and relevance-extractor fallbacks. These producer
checks still admit a successful lookup with no matches.

The shared `extractMcpResultText` projection is
stored as `{ v: 1, text }`; `advisorToolResultStorage` accepts text and metadata,
with no fields for tool arguments or provider reasoning. Store log calls emit
identifiers, tool name, byte size when available, and outcome without content or
caught error messages.

[`advisorToolResultStorage.write`](../packages/database/prisma/queries/advisor-tool-results.ts) checks the conversation owner and tenant and the
turn's association before inserting. A unique `(turnId, sourceKey)` index keeps
one row per logical call; the source key combines the execution id and
workflow-owned recorded-call ordinal. `storeAdvisorResult` reads the attempt
number from `Context.current().info.attempt` inside the activity. Under the
conversation lock, a higher attempt replaces content, byte size and expiry; an
equal or lower attempt changes nothing. The row id and creation time are
preserved. Replacement cap accounting subtracts the old size only while that
row is unexpired. The writer skips content above
1 MiB (UTF-8) or a write that would exceed 16 MiB of unexpired content in the
conversation. A conversation row lock serializes cap accounting. The storage
interface also exposes bounded `list` and row-scoped `read` methods.

The write uses one transaction with a 250 ms acquisition wait, 1 second
transaction timeout, 200 ms statement timeout and 100 ms lock timeout.
`storeAdvisorResult` catches storage failures so the producing activities can
return their existing results to the answer. A rolled-back first write leaves no
snapshot; a rolled-back replacement preserves the previous snapshot. An activity
retry can attempt the same key again. No separate storage retry is scheduled. A lost commit acknowledgement can leave a row,
which the next attempt replaces only if its activity attempt number is higher.

The conversation foreign key deletes snapshots on conversation deletion.
[`purgeExpiredRequestSpansActivity`](../packages/temporal/src/activities/request-span-retention.ts) also calls `deleteExpired` independently of
request-span retention settings, in batches of at most 5,000 rows and at most
1,000 batches per daily sweep. Expiry is fixed at two days; physical deletion
waits for a successful sweep or conversation deletion. `deleteExpired` rechecks
expiry when deleting, so a retry that refreshes a row while the sweep waits for
its row lock protects the refreshed snapshot.


Stored-result reuse is decided once at workflow entry by
`advisorResultReuseEnabled` in
`packages/temporal/src/workflows/orchestrator/advisor-result-reuse.ts`:
iterative chat execution, a conversation, the same-run read decision, and
`orch-advisor-result-reuse-v1` must qualify. Its short circuits avoid recording
this marker on other runs. There is no setting. With a false decision,
initialization sends no reuse metadata and model requests carry no catalog
field. Same-run result reads answer unknown `s:` refs locally without a
stored-page activity.

The existing `preloadResourcesActivity` accepts optional `advisorResultReuse`
metadata and returns optional `advisorStoredResults`; no listing activity command
is added. An old activity worker ignores the optional preload input and returns
no listing; a new workflow treats that absence as empty. An old workflow ignores
the optional output. A worker older than the reuse workflow code can skip the
unknown patch marker, but cannot generally reproduce commands after a stored-page
call. Those workflow tasks can fail replay until compatible code handles them.
Drain affected chat runs before rolling workflow workers back. A page activity
missing on an old worker reaches the workflow's unavailable fallback within its
one-attempt, six-second schedule-to-close budget.

Both readers use `authorize` in
`packages/temporal/src/activities/advisor-result-reuse.ts` at read time. It checks
conversation existence with an id-only `agentConversation.findFirst` under
`{ id, userId, organizationId }`, calls `isOrganizationMember` with the same
transaction client, and loads only the current turn's generation under its owner,
organization and conversation filters. Missing scope, ownership, membership or a
numeric generation returns no data. Project guest access alone does not qualify.
The membership helper's optional client preserves its base-client behavior for
existing callers. Both storage queries retain the shared `readScope` predicate:
conversation AND user AND organization, unexpired at query time, with a producing
turn generation below the current turn. Conversation deletion also cascades rows.
Errors, timeouts and unreadable content produce an empty listing or exactly
`{"v":1,"status":"unavailable"}` for a page; a bad listing row rejects the entire
listing through `loadAdvisorStoredResults`.

The listing contains at most 30 rows, newest creation time first and descending
row id as the tie-breaker. Each entry gives a stable `s:<row-id>` ref, tool name,
creation time, stored `sizeBytes` labelled as UTF-8 bytes, and up to 200 UTF-16
characters from the text's beginning. SQL projects a bounded excerpt and the
existing byte-size column. It performs no character-count or regular-expression
scan over full results; JSONB excerpt extraction can still detoast the value
inside PostgreSQL. The activity backs off a trailing surrogate boundary. Attempt
replacements preserve creation time and row id, so they retain ordering and ref.
Rows beyond 30 remain readable with a known ref while access and expiry permit.
`storedResultId` separates these refs from same-answer `r<n>` refs; `readScope`
prevents a known id from crossing conversation or owner boundaries.

Tool-capable iterations pass optional `advisorStoredResults` to
`runAgentIteration` on each call. The activity renders `storedResultCatalog` into
a host-labelled, delimited JSON data block, escapes framing characters inside
strings, and joins it with the per-call `turnNotice` after vision processing and
`withAdvisorCacheBreakpoints`. Only that call's SDK messages receive the suffix.
No `IterativeMessage` contains the listing. Compaction, finalization findings,
completion and preference learning, intent detection, retention and saved
conversation readers continue to receive the original history. Vision and frame
intent detection select user text from that original history.

For example, let turn N start from `[Q0, A0, QN]`. Its first request marks QN as
the rolling history boundary. After round one adds `[call1, result1]` with one
iteration tag, the next request marks QN (the preceding request) and result1
(the rolling boundary). After round two adds `[call2, result2]`, the next request
marks result1 and result2. Each request appends the catalog after those marked
messages. Turn N+1 starts from browser history `[Q0, A0, QN, AN, QNext]`, without
in-turn tool records or per-call notes. Its prefixes through QN match the entries
written through QN during turn N. Entries ending at tool results have the same
cross-turn limitations they have without reuse. For identical system, tools and
history, catalog delivery changes no bytes through any marked boundary, including
QN; it does not claim to repair prefix changes from other sources.

The per-call choice resends `storedResultCatalog(entries).length` UTF-16 characters
outside explicit cache markers on each request that offers the reader, plus two
separator characters when a `turnNotice` is also present. It keeps catalog data
available in later rounds without changing the question or historical messages.
An older iteration activity ignores the optional field and shows no listing; a
new activity receiving no field builds its existing request. A known stored ref
still follows the workflow's existing read decision and scoped page activity.
Synthesis requests with no tools do not need a catalog and send no field.

`readAdvisorStoredResult` uses the same `parseResultReadArgs` and
`pageAdvisorText` helpers as same-run reads: default 16,000 and maximum 24,000
UTF-16 characters, serialized-envelope allowance, and surrogate-safe boundaries.
The page envelope retains `totalCharacters`; listing byte counts do not change
page offsets. Full row text remains inside the activity. `resultReadRecord` keeps
position/status metadata; the existing `recordedResultForPresentation` and
partial-findings exclusions omit page content from output, artifacts and saved
records. The loop's `isResultPage` guard skips large-result summarization, and
read dispatch calls neither a producing tool nor the snapshot writer.

`advisorToolResultStorage.readTransaction` bounds authorization and row access in
one transaction. Listing uses a 100 ms acquisition wait, 350 ms transaction and
callback deadline, 200 ms statement timeout and 350 ms idle-transaction timeout.
Paging uses the same acquisition wait, a 1,300 ms transaction and callback
deadline, 1,000 ms statement timeout and 1,300 ms idle timeout. Both use a 100 ms
lock timeout. The explicit callback deadline rejects stalled callbacks so
rollback can close the scoped client; late queries on that client cannot become
a successful read. Activity fallback deadlines are 500 ms for listing and 1.5 s
for paging. The page proxy has three seconds start-to-close, six seconds
schedule-to-close and one attempt, allowing queue wait separately from execution.

A fallback-timer win or a structured storage time-limit failure logs one
`Read timed out` line with ids and `outcome: "timeout"`. The structured failures
are the ones `isReadTimeLimit` recognizes: no pool connection within the
acquisition wait, the transaction or callback deadline, the statement timeout
and the lock timeout. Other exceptions log `Read failed` with the same id keys
and `outcome: "error"`. That includes an idle-transaction expiry, which arrived
as an error without a code when it was observed locally, and a cancelled query
is labelled a timeout because it shares the statement-timeout code. Error objects, messages and result content are excluded by
the log payload construction and its exact-key tests. Model-message logging uses
`messagesForLog` sizes, `isResultPage` suppresses result previews, and owned
`advisor_result_read` calls log argument counts rather than argument key names.
