---
title: "A sanitizer that deletes can reassemble the tag it removed — escape instead, and never let the loop bound be the correctness bound"
date: 2026-07-31
category: security-issues
module: temporal — PM-sync description cleanup (cleanContentForPM)
problem_type: security_issue
component: service_object
severity: medium
symptoms:
  - "A nested fragment like `<ma</markrk>` becomes a live `<mark>` tag after the sanitizer runs"
  - "Bounding a fixed-point strip loop to stop a quadratic blowup silently reintroduces the tag-injection it was defending against"
  - "A regression test for deep nesting passes while the real hole stays open, because a pure nest converges and never exercises the cap path"
root_cause: logic_error
resolution_type: code_fix
related_components: [documentation]
tags:
  - sanitization
  - regex
  - redos
  - html-injection
  - markdown
  - untrusted-input
  - test-design
  - temporal
---

# A sanitizer that deletes can reassemble what it removed

- **Audience**: engineers writing tag/marker strippers over user- or LLM-authored text
- **Owner**: web app team

## Problem

`cleanContentForPM` strips editor highlight tags (`<mark>`) out of a spec before it is
pushed to a project tracker. Removing a tag from the middle of a string **joins its
neighbours**, so one pass over the nested fragment `<ma<mark>rk data-color="x">` deletes
the inner `<mark>` and leaves a perfectly valid `<mark data-color="x">` behind. The strip
therefore has to run repeatedly.

Running it to an unbounded fixed point made it quadratic in nesting depth — each pass
rescans the whole string. Measured on crafted single-line input: 3 ms at 6 KB, 9 ms at
12 KB, 31 ms at 24 KB, **114 ms at 48 KB**. `UserStory.description` is `@db.Text` with no
upstream length validation, and this code runs inside a Temporal **workflow**.

Capping the loop fixed the cost. The cap's fallback — "if we hit the cap, delete every
remaining `<mark` opener so nothing can reassemble" — **reintroduced the original defect**,
because a delete is exactly what splices neighbours together.

## Symptoms

- Verified against the real function: `"<ma</markrk>X</ma</markrk>" + "<ma".repeat(11) +
  "<mark>" + "rk>".repeat(11)` returned `"<mark>X</mark><ma>rk>"` — a live tag produced
  *by the safety net*.
- The `<ma</markrk>` half is inert during the loop (neither pattern matches it) and only
  becomes a tag when the sweep removes the `</mark` in its middle. So the failure is
  reachable only through the cap path.
- The deep-nesting regression test added alongside the cap **could not fail**: a pure
  nest converges to plain text before the cap, so its post-cap residue swept clean by
  coincidence.

## What Didn't Work

**Bounding the loop and adding a blunt delete-sweep.** This is the natural shape — cap the
iterations, then guarantee correctness with one final unconditional pass — and it is wrong
twice over:

```js
// cost bounded, correctness broken
for (let pass = 0; pass < MAX_PASSES; pass++) { /* … */ }
return current.replace(/<\/?mark/gi, "");   // deletes -> splices -> reassembles
```

It also ate legitimate text the surrounding code deliberately preserves: `<marker>`,
`<markdown>`, and `Map<markerId, string>` all contain `<mark`.

**Looping the delete-sweep to a fixed point** (the other obvious repair) terminates, but
reintroduces an unbounded loop — the exact thing the cap existed to remove — and still
eats the look-alike text.

## Solution

Make the fallback **escape rather than delete**. Escaping removes no characters, so
nothing can rejoin, and the result is inert in one pass:

```js
// Cap hit — adversarial nesting only. Neutralize every remaining opener by
// escaping it; this must not be a delete.
return current.replace(/<(?=\/?mark)/gi, "&lt;");
```

Both copies of the helper (the activity and its Temporal workflow-bundle mirror) carry the
change, and a byte-parity test keeps them identical.

The discriminating regression test pairs an **inert fragment** with enough nesting to force
the cap — the shape a pure nest cannot produce:

```js
const inert = "<ma</markrk>X</ma</markrk>";
const forcesCap = `${"<ma".repeat(11)}<mark>${"rk>".repeat(11)}`;
const cleaned = cleanContentForPM(inert + forcesCap);
expect(cleaned).not.toMatch(RAW_MARK_TAG_RE);
```

Note also that `not.toContain("<mark")` is an unusable assertion here — `Map<markerId,
string>` literally contains `<mark`. The assertions use word-delimited matchers that
mirror the production pattern.

## Why This Works

Deletion is a *structural* operation on the string: it changes which characters are
adjacent. Any sanitizer that removes a substring can therefore create a new substring that
did not exist in the input, which is why single-pass deletion is unsafe whenever the
attacker controls what surrounds the removed span. Escaping is *non-structural* — it only
grows the string and never changes adjacency — so a single pass is sufficient and the
result cannot be re-parsed into the thing you removed.

This is the "mangle, don't delete" rule already recorded in `CONCEPTS.md`, applied to a
sanitizer's fallback path rather than to prompt-delimiter handling.

The same session showed the *other* side of this rule: a sibling helper
(`stripInlineDecoration` in `@repo/utils/markdown-heading`) deliberately uses a **single
delete pass and must never iterate**, because its output is compared and then discarded —
mangled debris is the desired outcome there, and iterating is what would reassemble a
forgery. **The two helpers look similar and need opposite treatment, and the deciding
question is not the pattern — it is what happens to the output.** Compared-then-discarded:
delete once. Rendered or persisted: escape.

## Prevention

1. **A sanitizer's fallback must not delete.** If a strip needs repeating because deletion
   can reassemble its target, the terminal case has to be non-structural (escape, or
   replace with an inert sentinel). A "belt and braces" delete is not a safety net — it is
   a second instance of the bug.

2. **Never let the loop bound double as the correctness bound.** Bounding a fixed-point
   loop for cost is right (see
   `docs/solutions/security-issues/redos-in-preview-markdown-strip.md`), but the exit path
   then has to be independently correct. Ask: *if this loop stops early, is the output
   still safe?* If the answer depends on convergence, the bound has introduced a hole.

3. **A regression test for a bounded loop must actually reach the bound, and carry
   something the loop cannot clean.** A fixture that converges before the cap tests the
   loop, not the cap. This mirrors the single-line-fixture lesson in the ReDoS learning:
   both are cases where the obvious fixture exercises the path that already works.

4. **Word-delimit tag patterns, and check your assertions against the look-alikes.**
   `/<\/?mark[^>]*>/` also matches `<marker>`/`<markdown>`; `not.toContain("<mark")` fires
   on `Map<markerId, …>`. Use `/<mark(?=[\s/>])[^>]*>/` and assert with the same shape.

5. **Classify the output before choosing the strategy.** Write the answer in the
   docstring — "this output is compared and discarded" vs "this output is rendered by a
   third party" — because the next reader will otherwise copy the wrong sibling.

## Related

- `docs/solutions/security-issues/redos-in-preview-markdown-strip.md` — the cost half of
  this problem: cap untrusted input rather than trusting the regex, and test ReDoS with
  single-line fixtures. This learning is its correctness counterpart.
- `CONCEPTS.md` — the "mangle, don't delete" rule for delimiters inside untrusted text.
