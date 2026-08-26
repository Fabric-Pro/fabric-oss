---
title: "Prompt context is a fan-in: every producer must join, never assign"
date: 2026-07-22
category: design-patterns
module: temporal workflows web api agents prompt-context
problem_type: design_pattern
component: full_stack
severity: high
applies_when:
  - "Adding a new source of model context beside existing ones (attachments, retrieval, memory, workspace docs)"
  - "A context string is built by several producers in sequence before reaching a prompt"
  - "Adding a bound, guard, or budget to a path you believe is the only one of its kind"
tags: [prompt-context, rag-context, attachments, silent-loss, fan-in, character-budget, extraction, temporal-workflow]
related_components: [ai-assistant, temporal, rag, attachments]
---

# Prompt context is a fan-in: every producer must join, never assign

## Context

Several independent sources write into the single context string that reaches an
AI model: files the user attached this turn, chunks similarity retrieval
returned, workspace documents, memory. They are assembled in sequence, each
appending to what the last one produced.

Adding attachment text as a new inline source exposed two defects of the same
shape, in two files that had never been edited together. Both had been latent
for as long as the code existed, and neither could fire until a second source
was present — which is why neither was noticed.

## Guidance

**When code combines several sources into one context value, every step joins.
A bare assignment in the middle of a fan-in is a defect even when it currently
looks correct.**

The direct-chat workflow seeded its context from the caller, then the document
branch assigned the retrieval result over the top:

```ts
// Before — discards whatever came before it
let ragContext = input.ragContext || "";
if (hasDocuments) {
  ragContext = ragResult.context;        // <- overwrite
}
if (hasWorkspaces) {
  ragContext = ragContext + workspaceRagResult.context;   // <- append
}
```

Three sources, three different combining rules, and the middle one silently
dropped the first. The workspace branch below it had always appended, which is
what made the inconsistency easy to read past on review: the file *looks* like
it accumulates.

```ts
// After — one helper, so a fourth source cannot reintroduce either bug
let ragContext = joinRagContextParts([
  ...(input.inlineAttachmentContexts ?? []),
  input.ragContext,
]);
if (hasDocuments) {
  ragContext = joinRagContextParts([ragContext, ragResult.context]);
}
```

The same shape appeared independently in the orchestrator's HTTP route, which
rebuilt its value from the original message rather than from the accumulated
one:

```ts
// Before: drops anything appended above this line
messageWithDocumentContext = `${message}\n\n${ragResult.context}`;
// After
messageWithDocumentContext = `${messageWithDocumentContext}\n\n${ragResult.context}`;
```

Extracting the join into a named, pure helper is worth more than fixing the two
call sites. It converts "remember to append" — which review has to catch every
time — into a shape where the wrong thing is not expressible.

## Why This Matters

**The failure fires only when two sources are present, which is exactly the
case the feature exists for.** Inline attachment text was discarded precisely
when a document was attached; with no attachment there was nothing to lose. A
bug that is invisible in the common path and certain in the feature's own path
will not be caught by smoke testing, and its symptom — the model answering as
if it never saw the file — reads as a model quality problem rather than a code
defect. That misattribution is the real cost: the investigation starts in the
wrong place.

The bare concatenation in the same workflow (`a + b`, no separator) is the
lesser sibling of the same neglect. It ran two contexts together so the model
met one section's tail and the next section's heading on the same line.

## When to Apply

Reach for this whenever a value is built up across branches before being handed
off:

- Prompt or context assembly with more than one producer
- A caller-supplied seed field that later code may overwrite (`input.ragContext`
  was such a field: unused by every caller, so the overwrite was harmless right
  up until it wasn't)
- Any accumulator whose branches were written at different times

The tell is a variable declared with `let`, assigned a seed, then reassigned
inside a conditional. Read every assignment to it before adding the next one.

## Examples

### The companion lesson: count the paths, don't assume them

The same work set out to bound "the one unbounded text path" and found three.
The reasoning had been: text files are read in the browser, so bound the
browser; knowledge-base ingestion is deliberately unbounded, so leave it. That
accounted for two paths and missed a third — server-side extraction of
PDF/DOCX, where the budget option reached the extraction factory but only the
workbook extractor honoured it. Every other extractor returned whatever it
parsed.

That path was harmless while the surfaces discarded the extracted text. It
became live the moment they started delivering it — the same "latent until a
second thing exists" structure as the fan-in bug.

```ts
// The bound belongs at the procedure that IS the chat path, not inside the
// shared extractors — four ingestion activities use those and must keep
// receiving whole documents.
const budgeted = applyAiChatTextBudget(text, limits.extractedTextBudgetChars);
```

Before adding a guard, enumerate the paths by reading the consumers rather than
by reasoning about the design. "Passing the option" is not the same as "the
option is honoured": check each implementation, because a shared interface makes
the ones that ignore it invisible at the call site.

### The third instance: extending a lifetime creates an obligation

Chips on one surface were cleared the instant the user pressed Send, which made
per-file status impossible to show — that surface uploads *during* send. Keeping
them alive until every file settled fixed the display and created a new duty:
**every** exit from the send handler now has to settle them. Two early returns
sat outside the per-file `try/catch`, so a failed chat creation left the chips
stuck forever, and a failed readiness poll left them showing green while the
error toast said otherwise.

When you extend how long a piece of state lives, enumerate the exits from the
code that owns it. A lifetime that used to end unconditionally now ends only on
the paths you remembered.
