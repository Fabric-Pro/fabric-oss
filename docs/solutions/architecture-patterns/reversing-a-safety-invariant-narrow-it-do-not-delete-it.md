---
title: "Reversing a safety invariant: narrow it, never delete it"
date: 2026-07-22
category: architecture-patterns
module: web project stories attachments
problem_type: architecture_pattern
component: full_stack
severity: high
applies_when:
  - "A feature request needs behavior that a deliberate, documented invariant currently forbids"
  - "A schema comment, prompt clause, or tripwire test asserts a blanket safety guarantee you are about to make partly false"
  - "A prior spec deferred the invariant-touching part of a feature to a follow-up, and you are the follow-up"
  - "Adding a second sanctioned path to a resource that previously had exactly zero"
tags: [invariant, ai-isolation, story-attachment, designation, locked-unlocked, prompt-injection, tripwire, vocabulary-audit, projection, idor]
related_components: [stories, ai-assistant, agent-prompts]
audience: engineers changing a documented safety boundary
owner: web app team
---

# Reversing a safety invariant: narrow it, never delete it

## Context

Fabric's `StoryAttachment` system shipped with a deliberate isolation guarantee: attachment content never reaches an AI prompt. It was asserted in three places — a schema comment ("stored SEPARATELY ... so the AI Assistant cannot touch it"), a shared prompt clause telling the model in plain words that it never receives attachment contents, and a tripwire test.

A follow-up asked for the opposite: files marked "context only" should inform AI generation. The predecessor learning ([extend the shipped pipeline without breaking its AI-isolation invariant](reuse-story-attachment-pipeline-preserve-ai-isolation.md)) had already seen this collision coming and deferred it deliberately, with a prescription for whoever picked it up: *refine, don't delete, the isolation rule*.

This documents what executing that reversal actually required — and the two boundary defects it exposed, both of which existed before the change and were only visible because the change forced someone to look.

## Guidance

**1. Audit the existing vocabulary before treating the request as greenfield.**

The request described a new `context_only` boolean. The repository already had `StoryAttachment.designation` (`LOCKED` | `UNLOCKED`), with `UNLOCKED` documented in code as *"context-only, discardable"*, a "Context only" select in the create dialog, a post-upload toggle, and a count badge that already counted correctly. Seven of the eight stated requirements were shipped under a name the request did not use.

Building it as described would have added a migration, a second flag meaning nearly the same thing, and two overlapping toggles in one panel. **The audit is what turned a large feature into one genuinely-missing capability.** Grep the schema for the *concept*, not the requester's word for it.

**2. Narrow the invariant's wording to what stays true — and expect the safe half to get broader.**

The prompt clause said: *"You do NOT receive attachment files or their contents."* Shipping that sentence unchanged alongside inline delivery would tell the model to disbelieve text it was just handed.

It was scoped to `LOCKED` rather than deleted. The counter-intuitive part: the **anti-fabrication rule moved the other way and got broader**. It now covers every attachment whose text is absent from context — LOCKED ones, *and* context-only images and video that the user sees marked "context only" but the model never receives. A narrowing on one axis created a wider obligation on another.

**3. Update every artifact that asserts the old guarantee, including the ones that still pass.**

The tripwire test guarded one file (`resolve-story-media-for-agent.ts`) and kept passing, because the new path is a different file. But its name — "attachments AI-isolation invariant" — now advertised a guarantee the system no longer made. A green test asserting a stale blanket rule is worse than no test: it is a guarantee someone will rely on.

It was rewritten to state what it still guards (the media resolver is not a *second* path), what deliberately changed, and where the rule that did *not* narrow is now enforced.

**4. Route the new capability through exactly one sanctioned path.**

Attachment text reaches the model through a single resolver that applies three gates in order — live rows, `UNLOCKED` only, text-bearing MIME only — and builds its entries with the shared envelope builder that owns delimiter neutralization. Two surfaces consume it and neither reimplements it: the maturation path imports it directly, and the AI Assistant reaches it through a procedure, because the langgraph agent deliberately omits database, storage, and config from its package so it cannot cross tenant boundaries.

One path is what makes the gates auditable. Two paths mean a fix applied to one and missed on the other.

## Why This Matters

An invariant is load-bearing precisely because people stop re-deriving it. Deleting one is silent: nothing fails, and the next reader finds a codebase that no longer explains why it is shaped the way it is. Narrowing it — in the schema comment, the prompt clause, and the test name — keeps the boundary legible and tells the next person exactly which half still holds.

The two defects below were both **pre-existing**. Neither was caused by this change; both surfaced because reversing an invariant forces an audit of the surrounding boundary.

## When to Apply

Whenever a request needs behavior a documented invariant forbids. The move is never "delete the assertion and move on," and it is also never "refuse the feature." It is: find every artifact that states the old rule, work out which half survives, and rewrite each one to say that — then add the capability through a single gated path.

## Examples

**The projection defect.** `list-attachments` built its response as a spread minus one field:

```ts
const { storageKey: _omit, ...rest } = r;
return { ...rest, downloadUrl };
```

That made the query's `select` the *only* barrier between a row and the browser. Fine while every column was metadata — but this change added cached document text to the row, and any future widening of the select (or a switch to a bare `findMany`) would have shipped it to the client silently. The fix is a closed projection: name the response fields, so exposing a new one takes an edit.

```ts
return {
  id: r.id,
  filename: r.filename,
  mimeType: r.mimeType,
  sizeBytes: r.sizeBytes,
  designation: r.designation,
  createdAt: r.createdAt,
  downloadUrl,
};
```

**The input-org ratchet.** The repo's SOC 2 ratchet test rejected the new procedure. It was right, and the reasoning generalizes: the procedure had three authorization layers proving the *project* belonged to the claimed organization, but none proving the *caller* held the permission **in** that organization — and `resolveOrganizationId` returns the client's string unexamined. A sibling procedure written before the ratchet existed has the same shape; passing three plausible checks is not the same as passing the right one.

```ts
.use(requireInputOrgPermission(Permissions.STORY_UPDATE))
.use(requireProjectPermission(Permissions.STORY_UPDATE))
```

**Deferred rather than answered.** Spreadsheets are excluded from AI context via a named constant with a comment saying so, even though the extractor for them exists. An unexplained absence reads as an oversight and gets "fixed" by the next reader; a named exclusion reads as a decision.
