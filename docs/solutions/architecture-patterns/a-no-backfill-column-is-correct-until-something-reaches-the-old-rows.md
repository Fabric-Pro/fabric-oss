---
title: "A no-backfill column is correct until something reaches the old rows"
date: 2026-09-21
category: docs/solutions/architecture-patterns
module: meeting-digest
problem_type: architecture_pattern
component: database
severity: high
applies_when:
  - "A migration adds a nullable column with no backfill because the code that populates it runs on every new row from now on"
  - "A key is DERIVED from a row's content on one side of a join but the join itself matches on the STORED value on both sides"
  - "A feature is added that deliberately reaches rows predating a schema change — a catch-up, a sweep, a reprocess, a backfill trigger"
  - "A pipeline marks work done with a stamp, and its own selection predicate only picks up unstamped work"
tags: [migration, backfill, nullable-column, derived-key, catch-up, idempotence, temporal, meeting-digest]
---

## Context

A consolidated To Do list binds a to-do to a meeting action item by
`(transcriptId, itemKey, occurrenceIndex)`, where `itemKey` is a hash of the
item's normalized text. The migration added `itemKey` to
`project_meeting_action_item` as a nullable column and deliberately did not
backfill it. The reasoning was written into the migration and was correct:

> `itemKey` on project_meeting_action_item is nullable with no default, so
> adding it takes no table rewrite and no backfill; the existing row builder
> populates it from the same helper going forward.

Nothing in the change reached rows that predated the column, so nothing
observed the nulls. The decision cost nothing and bought a migration with no
table rewrite.

Then a later unit in the same branch added `todos.catchUp`: a procedure the To
Do page calls on open, which starts the owner matcher for meetings whose
to-dos were never built. Its entire purpose is to reach the rows that predate
the feature. That is the moment the migration's reasoning expired, and nobody
re-read it — the migration and the catch-up procedure were separate units,
each defensible on its own.

The failure was quiet and total for historical meetings. The matcher derives
the key it writes onto a to-do from the item's **text**, while the list read
joins the two on **stored** equality and discards a null-keyed item
(`AND a."itemKey" IS NOT NULL`). So a historical meeting produced to-dos whose
key was correct, sitting beside action items that still said null. Those rows
rendered as orphaned work, an item completed months earlier came back open, and
completing it from the page moved the to-do without moving the meeting digest.
The matcher then stamped the transcript as matched, which removed it from
catch-up's selection permanently.

An adversarial cross-model review found it. No test failed, because every test
fed the matcher items from a modern extraction, which carry a key.

## Guidance

### 1. A no-backfill decision has an expiry condition — write it down as one

"Populated going forward" is a statement about *who reaches these rows*, not
about the column. It stays true exactly as long as nothing reads the old rows,
and it says nothing about what happens when something does. Record the
condition, not just the choice:

```sql
-- `itemKey` is nullable with no default, so adding it takes no table rewrite
-- and no backfill; the row builder populates it from the same helper going
-- forward. This holds while nothing reaches rows written before this
-- migration. Anything that deliberately does — a catch-up, a sweep, a
-- reprocess — must repair the key before binding to it.
ALTER TABLE "project_meeting_action_item" ADD COLUMN "itemKey" TEXT;
```

A reviewer reading the second version while adding a catch-up has the
contradiction in front of them. A reviewer reading the first has to reconstruct
it.

### 2. If a key is derived on one side, make the other side get it in the same pass

The asymmetry is the defect, not the null. One side computed the key from
content; the other expected to find it stored. Both halves were individually
right — the deriving side must derive, because extraction deletes and recreates
the item rows, and the joining side must join on stored values, because
re-hashing every action item of every in-scope meeting in JavaScript is what
the stored column exists to avoid.

Repair where the two first meet, before anything binds:

```ts
// packages/temporal/src/activities/meeting-digest/match-action-item-owners.ts
for (const entry of live) {
	if (entry.item.itemKey !== null) {
		continue;
	}
	const { count } = await db.projectMeetingActionItem.updateMany({
		where: { id: entry.item.id, organizationId, itemKey: null },
		data: { itemKey: entry.itemKey },
	});
	keysBackfilled += count;
}
```

The `itemKey: null` in the `where` is doing three jobs at once, and each one
matters:

- a Temporal retry re-runs the loop and matches nothing, so it is idempotent;
- a concurrent extraction that wrote a fresh key wins over this repair rather
  than losing to it;
- a change to the key's version constant cannot be laundered into a silent
  per-row rewrite — that is a migration recomputing every key, which is what
  the binding's own docblock requires.

Prefer this over a data migration that hashes in SQL. The key's definition
lives in one TypeScript helper; a second implementation in SQL is a
drift-by-construction, and the two only have to disagree once.

### 3. A stamp plus a stamp-filtered selection is an at-most-once pipeline

`todosMatchedAt`/`todoMatchVersion` says "this transcript is done", and
`todos.catchUp` selects transcripts where that stamp is unset or superseded.
Together they mean **any defect committed before the stamp becomes
permanent**: there is no later pass, because the stamp is what removes the row
from the only thing that would look again.

That property is what turns an ordinary bug into a data-correctness bug, and it
is worth naming explicitly whenever a "done" mark and a "pick up what isn't
done" query appear in the same feature. Before adding the mark, ask what
reaches the row after it is set. If the answer is nothing, every write that
precedes it needs to be right the first time, and the mark itself has to be
conditional on the input the run actually read — see
[a terminal-status guard blocks the retry that starts from it](a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md)
§1 and §3.

## Why This Matters

Both halves of this defect passed review on their own. The migration's
reasoning was explicit, sound, and written down. The catch-up procedure was
correct, capped, ordered newest-first, and tested. The defect existed only in
the relationship between them, and the relationship is not a file anyone owns.

That is the general shape: a decision whose correctness depends on a condition
elsewhere in the system, plus a later change that quietly falsifies the
condition. Per-unit review cannot see it, because each unit is fine. What finds
it is asking, of every unit that reaches old data, which assumptions about old
data were made before it existed.

The severity elevation is the same mechanism recorded as §5 of the
terminal-status-guard learning — severity is a property of a line *and its
consumers*, so a change that adds a consumer re-prices every prior finding
about that signal. This case extends it one step: a change that adds a consumer
also re-prices decisions that were never findings at all, including ones
deliberately documented as safe.

## When to Apply

Re-read a migration's stated reasoning, not just its SQL, whenever a change in
the same release reaches rows the migration chose not to touch. In this
repository the reaching shapes are: a catch-up procedure, a Temporal sweep
workflow, a re-extraction, a daily-brief pass, and any admin reprocess.

Treat these as the trigger to look:

- the migration comment contains "going forward", "new rows", "no backfill", or
  "populated by the row builder";
- a read filters on `IS NOT NULL` for a column added nullable;
- a key or digest is computed in application code but stored and joined on.

## Examples

The test that would have caught it is the one that stops assuming the modern
shape. The fixture defaulted `itemKey` to the key its own text hashes to, which
is what extraction stores today, so every test described a post-migration
world:

```ts
// Before: every test is a modern extraction, and the null path is unreachable.
function item(text: string, tentativeOwnerName: string | null, order = 0) {
	return { id: `ai-${order}`, orderIndex: order, text, completedAt: null, tentativeOwnerName };
}

// After: the era is a parameter, and a test can describe a pre-migration row.
function item(
	text: string,
	tentativeOwnerName: string | null,
	order = 0,
	itemKey: string | null = computeTodoItemKey(text),
) {
	return { id: `ai-${order}`, orderIndex: order, text, completedAt: null, tentativeOwnerName, itemKey };
}
```

Defaulting it to `null` instead would have been worse: it would have made every
unrelated test exercise the repair path and hidden the guard that keeps the
repair from overwriting a real key. The era belongs in the fixture's signature
so a test can state which one it means.

## Related

- [A terminal-status guard blocks the retry that starts from it](a-terminal-status-guard-blocks-the-retry-that-starts-from-it.md)
  — the same change carried two more defects, and both were instances of that
  learning rather than new ones: an `assignedManually` check evaluated in
  JavaScript against a snapshot read before the slow step instead of in the
  `where` (§1), and a success stamp addressed by row id alone rather than by the
  revision the run read (§3). Its §4 ("evaluate the predicate, do not assert its
  shape") was then violated by the *fix* for those two — the first version of the
  new test asserted the `where` clause's shape, which only proves what was typed.
  Worth reading before writing any guarded write in this repository.
- [A generated migration diffs the schema, not your change](../developer-experience/a-generated-migration-diffs-the-schema-not-your-change.md)
  — why this migration was trimmed by hand, which is also why its reasoning was
  written as prose a later reader has to re-check rather than enforced by a tool.
