---
title: "A surface must not report absence it did not verify"
date: 2026-08-26
category: design-patterns
module: api/projects/contexts temporal/lib rag/project-contexts database/queries
problem_type: design_pattern
component: full_stack
severity: high
applies_when:
  - "A read surface (export, listing, retrieval) decides an item is unavailable and says so to a user"
  - "Content lives in child rows rather than on the row a surface iterates"
  - "A status column named for one pipeline is consulted by a different surface"
  - "A cleanup path reports success without confirming the thing it deleted was reachable"
  - "A delete removes the rows that hold the identifiers a retry would need"
tags: [silent-absence, derived-content, child-rows, status-fields, export, vector-cleanup, negative-assertions, vacuous-tests]
related_components: [project-contexts, download-export, conversation-capture, qdrant, temporal]
---

# A surface must not report absence it did not verify

## Context

Fizzy #2228 opened as "Download All excludes Teams chat content." The reported cause — Microsoft Graph permissions — was wrong. Investigation found four separate defects that share one shape, and the shape is the learning.

In each case a surface told the user something was absent, and the statement was false. None of them failed loudly. All four passed their tests.

| Surface | What it said | What was true |
|---|---|---|
| Batch export | "Content unavailable" | 19 of 22 skipped items held their text in Postgres |
| Batch export | "no messages captured yet" | The conversations were captured, embedded, and served to the assistant |
| Project delete | success | Organization vectors were never touched |
| Channel unlink | success (on retry) | Conversation vectors stayed indexed permanently |

## Guidance

**A status field belongs to the pipeline that names it.** The export gated text on `extractionStatus` — a field describing *embedding* progress, not content presence. When an AI credit balance ran out, a dozen items failed terminally, and the export reported them as "still processing" forever. The two questions are different: *do we hold this text* and *did the RAG pipeline finish*. Conflating them means any outage in one silently truncates the other.

```ts
// Wrong — a field about embedding decides whether text is exportable
if (!ctx.content?.length) skip("Content unavailable");
if (ctx.extractionStatus !== "COMPLETED") skip("Context not ready");

// Right — presence decides inclusion; status only annotates
if (!exportText.length) skip(deriveReason(ctx));
const annotation = isTerminal(ctx.extractionStatus) ? "" : " (may be incomplete)";
```

**Derived content does not reach a surface for free.** When a row's real content lives in child rows, every surface that reads it needs an explicit assembly step. This repo learned it once with `ProjectContextUrlPage` — a crawled link needed a dedicated unit before the batch export could see it — and then repeated it with conversation bundles: the branch captured them, embedded them, wired retrieval and the MCP read, and left the export reading the parent's always-empty `content`. Capturing content is not the same as making it visible; enumerate the surfaces.

**Name a resource through the resolver its writers use.** Two activities deleted vectors from a hardcoded `"project_contexts"` while every writer resolved `project-contexts` or `project-contexts-org-<id>`. The names never matched, the delete 404'd, and the 404 was classified as success — so organization tenants silently kept their vectors. A cleanup path must also never resolve through a helper that *creates* what it resolves, or a missing resource becomes unobservable at the moment you most need to observe it.

**Deleting rows before the thing they point at makes failure unrecoverable.** Unlink deletes context rows before their vectors, deliberately, so an in-flight embedder can read row-absence as "this is going away." But the ids the vector filter needs die with the rows: a transient vector-store failure leaves the user retrying into an empty early return that reports success. Keep the ordering if something depends on it — but persist the identifiers first, in the same transaction as the delete, and drain them on retry and from a sweep.

## Why This Matters

Every one of these shipped green. A test that asserts absence passes for two very different reasons — the behavior correctly reported nothing, or the behavior never ran. The batch export's test suite had a case for a channel with *no* captured bundles and none for a channel with them, which is exactly why the missing assembly survived eleven implementation units and five adversarial rounds on the plan.

Four independent reviewers found the export gap simultaneously; none of the eleven agents that built the feature did. Isolated context is why: each was correct within its own boundary, and the seam between "capture" and "export" belonged to no one.

The user-facing cost is worse than a crash. A crash is investigated. A confident false negative is believed — "Download All says there's nothing there" becomes "the integration is broken," and a delete that reports success ends the conversation about whether the data is gone.

## When to Apply

Reach for this when a change adds a new place content can live, a new reason an item might be skipped, or a new cleanup path — and specifically when:

- content is written to a child table and any surface iterates the parent;
- a status column is read by code outside the subsystem that writes it;
- a delete, purge, or unlink reports success to a user;
- a test's assertion is that something is *not* there.

## Examples

**Prove a negative assertion is not vacuous.** Break the behavior, watch the test fail, restore it. Applied to this branch it killed a whole class of false confidence:

```
remove the cleanup from the catch      -> 5 tests fail
delete without settling the upload     -> 1 test fails
ignore the streaming-started flag      -> 1 test fails
mask the original error                -> 4 tests fail
```

A cleanup test that still passes with the cleanup removed proves nothing. The same check caught a mutation probe of my own that looked like a rejected insert and was actually an insert that never ran (`INSERT 0 0` — the subquery matched no rows).

**Enumerate the readers before claiming a surface is covered.** One grep answered whether the export could see captured conversations:

```bash
grep -rn 'getCapturedConversationMarkdown' packages apps --include='*.ts' | grep -v node_modules
# one production caller: the MCP gateway. No download procedure imports it.
```

**Let the database hold what a convention cannot.** Tenant agreement between a parent and its children was enforced only by the query layer, which a raw writer bypasses — and Postgres does not evaluate a parent's row-level-security policy through a foreign key. A generated `ownerKey` column both tenancies collapse into, plus a composite `MATCH FULL` foreign key over `(parentContextId, projectId, ownerKey)`, makes ownership disagreement unexpressible. Note the trap this avoids: putting `userId` and `organizationId` in the key directly cannot work, because under the XOR one is always NULL and `MATCH SIMPLE` satisfies such a key trivially — a constraint that never once fires.
