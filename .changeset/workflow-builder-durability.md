---
"fabric-app": patch
---

Workflow-builder runs no longer die at the heartbeat timeout, start under the wrong name, or spin forever on a join they cannot reach

Three durability faults in the visual workflow engine, found together while
tracing why API-started runs never left PENDING.

**Long nodes were killed and re-run.** The workflow declared a 30-second
heartbeat timeout on every node activity, and no node ever heartbeated. The
declaration is a promise to check in; without one Temporal treats the activity
as dead at the timeout and retries it. An HTTP step is allowed 30 seconds on its
own, an AI generation or browser session routinely takes longer, and the
approval gate polls for up to five minutes — so any of those was cut off and
started again, duplicating whatever side effect it had already produced, and an
approval could never be granted in time. Node execution and the approval poll
now run inside a heartbeat ticker (`withHeartbeatTicker`, in the activity
liveness helpers) that checks in every ten seconds and stops when the work
settles, however it settles. The timeout stays, at sixty seconds, so a worker
that has actually died still fails fast. Outside an activity the ticker is a
plain call, so unit tests that invoke activities directly are unaffected.

**Two trigger surfaces started a workflow that does not exist.** The v1 REST
trigger started `workflowExecutionWorkflow`; the MCP gateway tool started
`workflowBuilderExecution`. Neither name is registered — the workflow is
`workflowBuilderExecutionWorkflow` — so Temporal accepted the start, the run
failed on its first task, and the caller saw PENDING forever. Both paths also
swallowed the error on the theory that a worker would pick the row up later;
nothing sweeps a PENDING execution, so nothing did. The MCP tool was worse: it
created no execution row at all and returned an id it had invented on the spot,
which `fabric_get_workflow_execution` then could not find. Three id schemes were
in use across five start sites, so the v1 cancel addressed a run that did not
exist and the webhook path's runs could not be cancelled from anywhere.

There is now one place that knows how to hand a builder run to Temporal:
`startWorkflowBuilderExecution` in `packages/api/modules/workflows/lib`, with
`builderWorkflowIdFor(executionId)` as the single id scheme and
`cancelWorkflowBuilderExecution` beside it. It carries the registered type, the
builder task queue, the run ceiling (six hours; only two of the five paths had
one) and the request correlation memo. The oRPC procedure, the v1 trigger and
cancel, the webhook route, the MCP tool and the Fabric AI chat confirmation all
go through it. The MCP tool creates the execution row through the same query
the others use, checks the tenant's concurrency cap first, and returns the row's
id. Every path records a failed start on the row as FAILED, and the v1 trigger
answers 502 for it instead of 202. The v1 trigger also passed its input under a
key the workflow never read; it now arrives as `triggerData`.

**A join after a condition could hang a run.** When a condition runs one branch,
a join node fed by both branches has a dependency that will never execute. The
original scheduler re-queued it behind a 100 ms timer forever — until Temporal's
history limit killed the run — and the newer wave scheduler dropped it silently,
so the run history never said why the node did not run. Both now detect that no
queued node can make progress, write the unreachable nodes as SKIPPED with the
missing dependency named, and complete the run. The new log writes are commands,
so they sit behind `patched("builder-requeue-guard")`: histories recorded before
this replay unchanged.

The workflow already logged only node-config keys rather than the config itself,
so nothing needed to change there.

Two starters had been left out of the tenant's in-flight cap that the
oRPC, webhook and MCP paths already apply: the v1 trigger and the
chat-confirmed start behind the Fabric assistant. Both now refuse with 429
before a row exists. The chat-confirmed start also used to swallow an
unavailable or failing engine and answer with a "queued" success, leaving a
PENDING row nothing would ever pick up; it now records the row as FAILED and
returns 503 or 502, and marks a successful start RUNNING with the engine run
id, the same contract the other starters have.

One more follow-up from review. On every starter (oRPC, chat-confirmed, v1, webhook and MCP) the
engine start and the database write that records it shared one `catch`, so a
run that had started but whose row could not be updated was reported as "not
started" and marked FAILED, inviting a retry that would start a second run
with the same side effects. The two steps are now separate: a start that
fails is recorded and reported as a failure; a start that succeeds is always
reported as started, and a failure to record it is logged (the workflow id is
deterministic from the execution id and the run writes its own status). The
chat-confirmed starter also stored the engine run id where every other
starter, and the cancel path, use the workflow id; it now stores the same
value.

