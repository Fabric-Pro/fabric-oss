---
title: "File-ownership boundaries in parallel execution produce work-arounds, not just conflicts"
date: 2026-09-11
category: workflow-issues
module: development-workflow api web
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - "Dispatching several agents at once over one checkout, each given a disjoint file list"
  - "Reviewing a branch that was built by a parallel team rather than one author"
  - "A unit needs a change in a file another unit owns, and the plan has no way to express that"
  - "Deciding what a post-implementation simplification pass should actually look for"
tags: [parallel-execution, subagents, ce-work, code-review, simplification, boundaries]
related_components: [ce-work, ce-simplify-code, ce-code-review]
audience: engineers orchestrating parallel agent work, and reviewers of its output
owner: platform team
---

## Context

Fizzy #2457 was implemented by eleven units dispatched as parallel subagents over one shared checkout. Each unit received a disjoint file list, which is what makes concurrent writes safe when the harness offers no isolation — in a shared directory only the last writer survives, so disjointness is the whole mechanism.

Disjointness works. No unit clobbered another, and every unit passed its own tests.

What it also does, and what nobody planned for, is change the *shape of the code a blocked unit writes*. A unit that needs a one-line change in a file it does not own cannot make it. It does not stop and ask — it routes around, and the detour ships.

Three instances landed on this branch, written by three different units, none of which could see the others:

- A unit needed one checklist item excluded from a rollup. It could not touch the resolver, so it **spliced a synthetic `NOT_APPLICABLE` data row** onto the resolver's input, exploiting the fact that the resolver builds a map with `Map.set` in array order and a row appended last silently overwrites a real one. The exclusion then had to be undone with a second filter downstream.
- A unit needed the project's name. It could not add a column to the select in the file that already loaded that row, so it **opened a second query** for the same row by primary key, on a path that runs on every page view and every fifteen-second poll.
- A unit needed the shape of a procedure's output. It could not export the inferred type from the procedure's own file, so it **hand-wrote the type and cast the response**, leaving the only contract on the branch that `type-check` could not verify.

Each detour was locally reasonable, individually invisible in review, and correct by its own tests. Together they were the single largest category of finding in the whole pipeline.

## Guidance

**Treat "new code that imitates an existing mechanism instead of calling it" as the signature of a boundary the author could not cross.**

That is the detection heuristic, and it is cheap to apply. Look for:

- a **fabricated data value** whose purpose is to make a callee behave a certain way — a synthetic row, a sentinel string, a magic id. The author wanted a parameter and could not add one.
- a **second read of something already in hand** — a query for a row another call just loaded, a refetch for one field. The author wanted a column on someone else's select.
- a **hand-maintained mirror** of something the toolchain can derive — a copied type, a duplicated constant, a re-declared enum. The author wanted an export.

None of these look like defects. They look like ordinary code, and every one of them passes review on its own merits. They are only visible as a class, and only once the boundaries are gone.

**So schedule a pass whose job is removing them, and run it after the parallel work, not during.** This is what makes `ce-simplify-code` non-optional after a parallel `ce-work` rather than a polish step: it is the only phase that sees the whole surface at once and is allowed to edit across every unit.

Two practices reduce the damage upstream:

- **When a unit's packet would need a change in another unit's file, put that change in the owning unit's packet instead** — even if it is one line and the owning unit has no other reason to care about it. A column added to a select costs the owning unit nothing; a second query costs the branch forever.
- **Sequence units that share a contract**, and say so in the packet. Here the client unit needed a payload field the server unit had not added yet; run the server unit first and the client unit's work becomes a one-line read instead of a hand-written type.

## Why This Matters

The failure mode is not that the code is wrong. It is that **the cost is invisible at the moment it is paid and permanent afterwards.**

The synthetic row worked because of an undocumented property of a `Map.set` loop — reordering two lines in an unrelated file would have silently disabled a rollout gate. The second query doubled a database round trip on a polled hot path. The hand-written type was accurate on the day it was written and had no mechanism to stay accurate.

None of those would have been written by a single author with the whole file set open. They exist because of how the work was divided, and they survive because each one is defensible in the diff that introduced it.

There is a second-order effect worth naming. Boundaries also hide **connections**, not just detours. On this branch a fix added a new piece of component state to suppress a prompt after a key was issued; the packet named the prompt's files, so the agent never saw that a *second* surface elsewhere could also issue a key. The state was introduced at the wrong level and the bug it fixed remained reachable through the other door. A file list cannot answer "who else can set this?" — that question has to be asked explicitly when a packet introduces state.

## When to Apply

- **Writing packets for a parallel `ce-work`** — check each unit's file list against what the unit actually needs, and move the cross-boundary line into the owning unit.
- **Reviewing a branch built by parallel agents** — search for the three signatures above before reading for ordinary defects. They cluster.
- **Deciding whether to run `ce-simplify-code`** — if the branch was built in parallel, yes, and the three signatures are its highest-value targets.
- **Introducing state in any unit** — ask who else can change it, and widen the packet or lift the state before the unit starts.

Do **not** read this as an argument against parallel execution. Disjoint file ownership is what makes it safe, and eleven units shipped here in a fraction of the serial time. The cost is real, bounded, and removable by one scheduled pass — that is a good trade, provided the pass actually runs.

## Examples

The exclusion detour, and what replaced it:

```ts
// Before — a fabricated row, relying on Map.set overwrite order in the callee.
manualStates: cliNudgeEnabled
    ? stateRows
    : [...stateRows, CLI_ITEM_GATED_OFF],
// ...and then, sixty lines later, a second filter to remove what this inserted.

// After — a parameter on the resolver, plus the deletion of the downstream filter.
excludeKeys: cliNudgeEnabled ? undefined : CLI_ITEM_WITHHELD,
```

The mirrored type, and what replaced it:

```ts
// Before — four hand-written interfaces and a cast, with a comment admitting
// that `pnpm type-check` could not catch drift from the procedure's schema.
const data = queryFn() as Promise<ReadinessData>;

// After — the inferred output type, an established pattern already used in six
// other client components in this repo.
type ReadinessData = Awaited<ReturnType<typeof orpcClient.projects.readiness.get>>;
```

Both replacements removed more lines than they added, which is the usual shape: a detour costs code precisely because it cannot use the thing it is detouring around.
