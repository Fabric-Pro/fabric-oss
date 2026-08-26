---
title: "A guard belongs on the copy that gets read"
date: 2026-08-18
category: security-issues
module: api projects documents supplied-context prompt-injection
problem_type: security_issue
component: assistant
severity: high
symptoms:
  - "Pasted source text was neutralized on the project-context row but stored raw on the document body"
  - "The document body is the copy a later run retrieves and re-interpolates into the generation prompt; the context row beside it is deliberately excluded from retrieval"
  - "A test asserted the context row was neutralized and none asserted the body, so the raw copy shipped uncaught"
root_cause: logic_error
resolution_type: code_fix
related_components: [temporal, rag, documents]
tags: [prompt-injection, neutralization, document-body, context-row, rag, storage-guard, fizzy-2190]
audience: engineers writing user-supplied text to storage that a later model run reads back
owner: web app team
---

# A guard belongs on the copy that gets read

## Problem

A requirement said to neutralize user-supplied text *before storing it*, not only before handing it to a model, and gave its reason: a later run retrieves the stored row raw, so protection applied on the way out covers one run and leaves every later one exposed. The implementation stored that text twice and put the neutralization on the copy nothing reads.

## Symptoms

Pasted source content became two rows. One was a project-context row. The other was the document body.

The neutralization landed on the context row — and that row was deliberately excluded from retrieval, because the document beside it holds the same words and embedding both would put them in the corpus twice. The document body, which *is* embedded, retrieved, and re-interpolated into later prompts, was stored raw.

Nothing was red. A test asserted the context row was neutralized and passed. A test asserted the text reaching that run's prompt was enveloped and passed. Neither covered the body, so the suite reported the property as guarded.

## What Didn't Work

Reading the requirement against the diff. The requirement said "the stored row"; the code neutralized a stored row; the two matched. What the match did not show is that the row the requirement named and the row that reaches the model were not the same row.

Reasoning from the storage decision alone was also insufficient in the other direction — the decision *not* to embed the context row was correct, and looks like a hardening measure. It is what made the asymmetry, and the asymmetry is what let the guard land on the wrong side.

## Solution

Neutralize the copy that gets read, and every other copy that is cheap to cover:

```
// Before — asymmetric, and the guard is on the unread side.
sourceRow    = neutralize(userText)   // kept, excluded from retrieval
documentBody = userText               // embedded, retrieved, re-prompted

// After — the guard follows the read path, not the requirement's noun.
sourceRow    = neutralize(userText)
documentBody = neutralize(userText)
```

Only delimiter-forming sequences are mangled, so nothing a reader would notice is lost and the body is still the user's own words.

The test that closes it asserts on the copy that is read, and fails when the raw value comes back:

```
const body = writtenDocument.content;
expect(body).toBe(neutralize(hostileInput));
expect(body).not.toContain("## Retrieved Context");
```

## Why This Works

The question a guard has to answer is not "did I protect the stored copy" but **which stored copy is the one read back into the dangerous position**. Protecting that one is what closes the hole; protecting the others is hygiene.

The audit is mechanical, and skipping it is what produced the defect:

1. List every place the value is written.
2. For each, ask what reads it, and whether that read reaches the sink the guard exists for.
3. Confirm the guard covers every copy on that list — not the first, and not the one the requirement's wording happened to name.

## Prevention

Run the audit whenever a guard exists because of what a value can do *later* and the value is written more than once. Escaping, sanitization, redaction, encryption at rest, tenant labelling all have this shape.

The tell is a decision elsewhere in the same change that makes the copies asymmetric — "this one is not embedded", "that one is internal only", "the other is never exposed". An asymmetry is precisely what makes guarding the wrong side possible, and it usually arrives as a hardening decision, which is why it does not read as a risk.

Two independent reviewers found this from different directions — one tracing prompt-injection reachability, one tracing what the storage decision implied — and no test caught it. When a property is asserted about one of several copies, the assertion's subject is worth stating in the test name, so the next reader sees which copy is covered.

## Related

- `docs/solutions/design-patterns/prompt-context-fan-in-must-join-not-assign.md` — a different defect in the same subsystem: how sources combine, rather than which copy is guarded.
- `docs/solutions/security-issues/a-sanitizer-that-deletes-can-reassemble-what-it-removed.md` — why the neutralizer mangles rather than deletes.
- `docs/solutions/architecture-patterns/reversing-a-safety-invariant-narrow-it-do-not-delete-it.md` — the sanctioned-path idiom this reuses.
