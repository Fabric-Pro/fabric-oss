# ADR-015: Agentic Case Results Are Staged in a Table, Not Carried in Workflow State

- **Status**: Accepted
- **Date**: 2026-07-29
- **Deciders**: Engineering team
- **Audience**: Engineers working on the QA agentic run workflow, or tempted to delete `TestAgenticCaseResult`
- **Owner**: Fabric platform

## Context

A Fabric-driven run executes up to 500 cases. Each produces a verdict and a step
log. Temporal workflows have a hard constraint here: workflow history is capped,
and accumulating per-case detail in workflow state until the end of the run
walks straight into the gRPC payload limit — the same limit that has already bitten
this codebase elsewhere.

The standard remedy is `continueAsNew`: process a batch, carry forward a small
summary, start a fresh execution. That works for the *counts*. It does not work
for the *detail*, and the reason is a schema fact rather than a Temporal one:

> **A step log hangs off a result row that only exists after the final ingest.**

So during the run there is nowhere to put per-batch detail. Carrying it in
workflow state is the thing `continueAsNew` exists to avoid. Dropping it means
the step log — the single most useful artefact when a case fails — does not
exist.

## Decision

**Per-batch verdicts and step detail are written to a staging table,
`TestAgenticCaseResult`, and drained into a single ingest when the run
finishes.** The workflow carries only what it needs to continue; the detail
lives in Postgres from the moment it is produced.

The `continueAsNew` batching is guarded by the patch `qa-agentic-durable-batching`.

## Consequences

**Good.** Workflow history stays small regardless of case count, so a 500-case
run is not structurally different from a 5-case one. Detail is durable the
moment it exists — a run that dies mid-way has already persisted the cases it
completed. The final ingest is one transaction, so a reader never sees a
half-written run.

**Bad.** There is now a table that is meaningless outside an in-flight run, and
it needs draining and cleanup. A cancelled or abandoned run leaves staged rows
that something must reclaim — which is what the stale-run reaper does. It is a
second write path for data that has a permanent home, so a schema change to
results has to be made in two places.

**The trap this ADR exists to prevent:** `TestAgenticCaseResult` looks like a
redundant intermediate table, and deleting it looks like a clean simplification.
It is not. Removing it rediscovers the constraint the hard way, through a
replay-validation failure, because the step-log foreign key cannot be satisfied
until the final ingest has run.

## References

- `docs/qa/agentic-runs.md` — batching, cancellation, and the reaper
- `packages/database/prisma/schema.prisma` — `TestAgenticCaseResult`, which carries the same warning
