---
title: "A comment that overclaims a guarantee is worse than no comment"
date: 2026-09-11
category: conventions
module: mcp api web
problem_type: convention
component: documentation
severity: medium
applies_when:
  - "Writing a comment that explains why some unsafe thing cannot happen"
  - "An invariant is held by convention or by a test rather than by the compiler"
  - "A feature flag, type, or guard is described as protecting more than it does"
  - "Reviewing a change whose tests are green and whose behaviour is correct"
tags: [comments, invariants, type-safety, feature-flags, adversarial-review, documentation]
related_components: [mcp-gateway, mcp-hosted, readiness-evidence, feature-flags]
audience: engineers writing comments that justify why something is safe
owner: platform team
---

## Context

Fizzy #2457 passed fourteen review personas, an eight-validator wave, three simplification lenses and two rounds of scoped review. An independent adversarial gate run by a different model family then found two defects that all of them had missed — and neither was a defect in the code.

Both were **comments that claimed a stronger guarantee than the mechanism provided**.

The first sat on an optional field used to decide whether a request gets recorded as a CLI connection. It read, in effect, *"the type is what stops a browser session being recorded"*. That was false. The field hung off a flat interface whose `credential` discriminator was a plain string union with no relationship to it, so assigning a key identity onto a session-credential result type-checks fine. The rule was held by convention plus two test suites. Nothing in the compiler was involved.

The second appeared after a fix that moved a rollout gate from the output of a query to its reads. The comment concluded that flag-off code therefore did not touch the new tables — which was true of the readiness read path it was written beside, and false of the branch, because the runtime's write path consults no flag at all and was never meant to.

In both cases the code was correct, the tests were green, and the behaviour matched the intent. Only the explanation was wrong.

## Guidance

**State what actually holds the invariant. If it is a convention or a test, say "convention" or "test" — never imply the compiler.**

The reason is not pedantry about wording. A comment asserting that something is structurally impossible **tells the next reader they do not need to check**, and that is exactly the reader you needed to keep alert. A refactor that would obviously be dangerous under "held by convention" looks harmless under "the type forbids it".

Three rules:

1. **Name the mechanism.** "The session branches omit this field by convention; the connection-record suites are what pin it" is a sentence someone can act on. "The type stops it" is a sentence someone relies on.
2. **Scope the claim to what you verified.** If you isolated one read path, say that path. A claim about a deployment needs evidence about the deployment, not about the function you happened to edit.
3. **Name the real fix when you defer it.** "A discriminated union so the session variant cannot carry an identity is the fix, and is deliberately deferred" turns an unnoticed gap into a known one — and stops the next reader from assuming the gap was never seen.

## Why This Matters

Every other quality gate on this branch checks **code against intent**. Tests assert behaviour. Type-checking asserts shapes. Reviewers read a diff and ask whether it does what it says.

None of them check **intent against explanation**. A comment cannot fail a test. It is the one artifact in the repository with no automated verification at all, and the only thing that catches a wrong one is a reader who stops to ask whether the stated reason is actually true — which is precisely what a confident comment discourages.

That is why both instances here were found by an independent adversarial pass and by nothing else, after nine other kinds of review. It is also why the cost is delayed: an overclaiming comment does no damage on the day it is written. It does damage on the day someone refactors the thing it described, having been told there was nothing to be careful about.

## When to Apply

- **Any comment of the form "X cannot happen because Y"** — check that Y is really what prevents X, and that Y is not a habit you are describing as a rule.
- **After narrowing or moving a guard** — the comments around it usually still describe the old scope. Moving a gate from output to reads changes what can truthfully be said about it.
- **When deferring a structural fix** — the deferral belongs in the comment, or the next reader will re-derive the problem from scratch or, worse, not notice it.
- **When a reviewer says "this is safe because of the type"** — confirm it, especially for optional fields on non-discriminated interfaces, where absence is a convention rather than a constraint.

## Examples

Before and after, on an optional field whose absence is load-bearing:

```ts
// Before — asserts the compiler is the mechanism. It is not.
/**
 * With the identity simply absent on those branches there is no id to write, so
 * the compiler refuses the write before any runtime check has to be remembered.
 */

// After — names the real mechanism, and the deferred fix.
/**
 * That omission is a CONVENTION, not something the compiler enforces — say so
 * plainly, because believing otherwise is what would let it rot. Both hosts hang
 * `keyIdentity` off a flat `AuthResult` whose `credential` is a plain string
 * union, so a session-credential result carrying an identity type-checks today.
 * What actually holds the line is the pair of connection-record suites. Making
 * `AuthResult` a real discriminated union is the fix and is deliberately deferred.
 */
```

And on a claim whose scope had quietly widened:

```ts
// Before — true of this function, false of the branch.
// ...which is what lets a gated-off deployment run without the table existing.

// After — scoped, with the exception named and its reason given.
// ...so a gated-off organization's READINESS never depends on the table existing.
// That is a claim about this surface, not about the deployment. The MCP runtime
// writes reach records on every authenticated request WITHOUT consulting the
// gate, deliberately, so the branch as a whole still requires migration-before-code.
```
