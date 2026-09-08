---
title: "A terminal-status guard blocks the retry that starts from it"
date: 2026-09-07
category: docs/solutions/architecture-patterns
module: project-documents
problem_type: architecture_pattern
component: background_job
severity: high
applies_when:
  - "A write guard exists to stop double-processing a row, and users can also intentionally restart work from that same status (regenerate, retry, resubmit) rather than only reach it as an end state"
  - "A dependency, failure, or blocking probe accumulates state across a resource's entire history instead of scoping to the current attempt's own time window"
  - "Two writers can race to claim ownership of the same background-job attempt, and a guarded write's zero-count outcome must be told apart between 'superseded by a newer attempt' and 'has not landed yet'"
  - "Reviewing a status-based `where` clause on an `updateMany` guard before assuming `notIn: [terminal states]` is the safe default"
tags: [temporal, compare-and-set, terminal-state, freshness-guard, regeneration, race-condition, generation-queue, ownership-signal]
---

## Context

A change added a queue step in front of AI document generation: hold the document in a
`QUEUED` status while the context it depends on is still being built, then start the run.
The write that stamps `QUEUED` was guarded `status: { notIn: ["COMPLETE", "FAILED"] }` —
"don't queue a document that already finished."

Regeneration *begins* from a terminal status. The regenerate control is offered only on
`COMPLETE` and `FAILED` documents, so the guard named the only rows the operation ever runs
on. Every regeneration had its queue mark refused, and the feature was invisible on its only
reachable path.

It failed silently. A guarded `updateMany` that matches nothing returns `{ count: 0 }` and
throws nothing: no exception, no constraint violation, no failed activity, clean workflow
history, green suite — including a unit test asserting the broken behaviour as intended.
The class marker is a feature that is *absent* rather than *broken*, on a code path whose
write is conditional.

Two sibling defects in the same change shared the root shape, and a third emerged from the
first repair. All were caught in review; none reached production.

## Guidance

### 1. Guard on the attempt's identity, not on lifecycle status

`status` is shared across attempts. Every regeneration passes through the same `COMPLETE`,
`QUEUED`, `GENERATING`, `FAILED` values, so a status predicate can never express *this
attempt's row* — only *a row in this phase*, which is true of rows belonging to attempts you
have never heard of and false of rows belonging to yours.

Mint one identity per attempt before starting the workflow and thread it through every
writer. For the first write of an attempt — before any row carries the identity yet — the
same idea takes a freshness form:

```ts
// packages/database/prisma/queries/projects/documents.ts
const generationStartedAt = options.generationStartedAt ?? new Date();
const { count } = await db.projectDocument.updateMany({
	where: {
		id: documentId,
		// `updatedAt` is `@updatedAt`, so every write to the row moves it — including
		// the terminal one a fast-failing workflow makes between the start and this
		// mark, which is the write this guard is meant to lose to.
		updatedAt: { lt: generationStartedAt },
	},
	data: { status: "QUEUED", generationStartedAt, generationProgress: 0 /* … */ },
});
return { applied: count > 0, generationStartedAt };
```

A row last touched before this attempt began is fair game whatever status it holds; a row
touched after belongs to a newer writer and must not be clobbered. That is what the author
meant. `status: { notIn: [...] }` means something else — *do not run on documents in these
phases* — and the gap between the two is the defect.

### 2. Scope every refusal predicate to the attempt, not to the resource's history

The dependency probe's "did a prerequisite fail?" arm counted failures across the project's
entire history. One historical failed extraction — months old, long superseded — refused
every future generation in that project, permanently, with a refusal message that was
technically accurate about a row nobody remembered.

A predicate that *refuses* needs a tighter bound than one that merely *waits*:

```ts
// packages/database/prisma/queries/projects/generation-dependencies.ts
const failureCutoff = toCutoffDate(generationStartedAt) ?? liveCutoff;
```

Two cutoffs, because the two arms ask different questions. `liveCutoff` bounds *outstanding*
(is anyone still working on this?); `failureCutoff` bounds *failed*, which refuses the run
outright, so only a failure recorded since this attempt was requested is this run's problem.

Ask of any refusal predicate: what is the oldest row that can satisfy this, and is refusing
because of it defensible?

### 3. A guarded write that authorizes a decision returns an outcome, not a boolean

`count === 0` is not an answer. It is every reason the row did not match, collapsed into one
number. `where` clauses conjoin, so a zero count means *at least one* predicate failed and
never says which. Read as "the row was not eligible" it looks like a decision; it is the
absence of information.

The ownership flip that gates the model call returns the three answers hiding inside that
zero:

```ts
export type GenerationRunStartOutcome = "started" | "superseded" | "not-yet-visible";

export async function markDocumentGenerationRunning(
	documentId: string,
	startedAt: Date,
): Promise<GenerationRunStartOutcome> {
	const { count } = await db.projectDocument.updateMany({
		where: { id: documentId, status: "QUEUED", generationStartedAt: startedAt },
		data: { status: "GENERATING", generationQueueReason: null },
	});
	if (count > 0) {
		return "started";
	}
	// Nothing was written, and WHY decides whether the run may continue.
	const row = await db.projectDocument.findUnique({
		where: { id: documentId },
		select: { generationStartedAt: true },
	});
	if (!row) {
		return "superseded";
	}
	const current = row.generationStartedAt?.getTime() ?? 0;
	return current > startedAt.getTime() ? "superseded" : "not-yet-visible";
}
```

`superseded` is fatal. `not-yet-visible` is a two-process ordering gap the caller waits out —
the dispatcher stamps `QUEUED` *after* `workflow.start()` returns and cannot invert that
order, so a worker that picks the run up immediately reaches the flip before its own queue
mark has landed:

```ts
// packages/temporal/src/workflows/project-document-generation.ts
for (
	let attempt = 0;
	ownership === "not-yet-visible" && attempt < QUEUE_WRITE_VISIBILITY_ATTEMPTS;
	attempt++
) {
	await sleep(QUEUE_WRITE_VISIBILITY_DELAY_MS);
	ownership = (await startGenerationRun({ documentId, startedAt: generationStartedAt })).outcome;
}
if (ownership !== "started") {
	throw ApplicationFailure.nonRetryable(/* … */, SUPERSEDED_FAILURE_TYPE);
}
```

Collapsing those two into one boolean is what turned the first ownership fix into a
run-killer: a healthy run saw `count === 0`, concluded it had been superseded, and threw.
The workflow died, the dispatcher then wrote `QUEUED` onto an untouched row, and the document
sat "waiting" forever with nothing left to advance it.

### 4. Derive the guard's test from the trigger condition, not from the guard

The unit test written alongside the original guard asserted that the writer "reports a no-op
when the row was already COMPLETE or FAILED". It was derived from the same mental model that
produced the guard, in the same sitting, and it passed. A test written from the specification
that contains the bug is a second copy of the bug with a green checkmark on it.

Tests for guarded writes earn their value by coming from a *different* source than the guard —
the trigger condition, the state machine, the call site:

- **Evaluate the predicate, do not assert its shape.** Mock `updateMany` to apply the `where`
  clause to a fixture row and assert on `applied`. `expect(where.status).toEqual(...)` only
  proves you typed what you typed.
- **Assert the absence of the wrong guard.** `expect(where.status).toBeUndefined()` in the
  regeneration case pins *why* the row qualifies — being older than the attempt — and fails if
  someone reintroduces a status predicate that reads as tidier.

### 5. Re-read downgraded findings when a change starts consuming the signal

The dispatcher/worker ordering gap was found in an earlier review pass and rated **cosmetic**.
That was correct at the time: nothing acted on the flip's return value. Making the workflow act
on it promoted the same unchanged code to a run-killer.

Severity is not a property of a line; it is a property of a line and its consumers. When a
change adds a consumer for a signal, prior findings about that signal need re-reading at the
new severity.

## Why This Matters

A guarded write fuses a query and a mutation, then discards the query's result. That is
convenient exactly until a caller needs to *decide* on the outcome — at which point the caller
is branching on a number that cannot distinguish the cases it is branching between.

Every defect here is a different reason hiding inside the same zero: the row was terminal
(correct state, wrong guard); the row did not exist yet from this process's point of view
(correct guard, wrong conclusion); the row belonged to someone else (the only case the guard
was actually for). The repair is not a better predicate. It is refusing to authorize anything
on a signal that cannot tell them apart.

The two lessons compose. Once the guard key is an attempt identity rather than a shared status,
the reasons for a zero count become distinguishable by a single read — which is what makes the
three-way outcome possible at all.

## When to Apply

- Before writing any status predicate into a guard on a write that *begins* an operation. Find
  the UI or API condition that triggers it and check the guard admits that state. Guards are
  written forward — "what must I not clobber?" — and that framing never surfaces the entry
  state, because the entry state is not something you are protecting against.
- When a terminal status has a legitimate re-entry path. `terminal wins` is the right guard
  when the status is terminal *forever* (a cancel that can never be un-cancelled). It is the
  wrong guard the moment a regenerate, retry, or resubmit action can re-enter from it.
- When a probe or blocking check reads state the resource accumulated over its whole lifetime,
  and the check can refuse rather than merely wait.
- When two processes can write the same row and one of them decides whether work proceeds.

## Examples

The inverse case is documented separately and is worth reading alongside this one:
`cancelling-temporal-backed-jobs.md` guards *non-terminal* statuses so a true terminal state
always wins over a completing run. That guard is correctly status-scoped, because its terminal
status has no legitimate re-entry. Its generalization — "any time you add a terminal status a
concurrently-running worker must not overwrite" — is sound for cancellation and is the trap
described here when applied to a status users can deliberately restart from. Confirm which kind
of terminal status you have before reusing either pattern.

Deploy ordering is a related decision that turned out not to need a guard at all. `patched()`
gates the *replay of existing history*, not the caller's code version, so it does not protect a
new worker from an old dispatcher. Making the new path skip implicitly when its input is absent
(`if (skipDependencyWait || !generationStartedAt)`) made deploy order irrelevant instead.

## Related

- Mirror image: `docs/solutions/architecture-patterns/cancelling-temporal-backed-jobs.md` —
  the same compare-and-set mechanism where status-scoping *is* correct
- Same technique against a TOCTOU bug in this module:
  `docs/solutions/architecture-patterns/scheduling-an-interactive-ai-engine-deletes-its-safety-model.md`
- A green test encoding wrong behaviour as the contract:
  `docs/solutions/conventions/a-test-double-must-mirror-the-contract-not-the-convenience.md`
- Origin: Fizzy #2199 (dependency-aware generation queue)
- Implementation: `packages/database/prisma/queries/projects/documents.ts`,
  `packages/database/prisma/queries/projects/generation-dependencies.ts`,
  `packages/temporal/src/workflows/project-document-generation.ts`,
  `packages/api/modules/projects/lib/dispatch-document-generation.ts`
