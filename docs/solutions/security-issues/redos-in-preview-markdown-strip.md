---
title: "A line-bounded regex can still be quadratic on one long line — cap untrusted input before stripping, and test ReDoS with single-line fixtures"
date: 2026-07-20
category: security-issues
module: web ui — stripMarkdown preview helper
problem_type: security_issue
component: frontend_stimulus
severity: medium
symptoms:
  - "A crafted proposal/meeting summary freezes the reviewer's browser tab for seconds when a list of proposals renders"
  - "A regex over unbounded `@db.Text` runs synchronously on the main thread during list rendering"
  - "A ReDoS regression test passes fast yet the production regex still blows up on a different input shape"
root_cause: logic_error
resolution_type: code_fix
related_components: [documentation]
tags: [redos, regex, dos, catastrophic-backtracking, markdown, untrusted-input, main-thread, test-design, react]
---

# ReDoS in the preview Markdown-strip helper

- **Audience**: frontend engineers writing regex over user- or LLM-authored text
- **Owner**: web app team

## Problem

`stripMarkdown` (`apps/web/modules/ui/lib/strip-markdown.ts`) reduces Markdown to plain text
for `line-clamp-2` previews of feature-proposal summaries. Its underscore-emphasis regex was
quadratic (ReDoS) on adversarial input, and the "fix" applied first — bounding the pattern to a
single line — closed only half the hole. The surviving quadratic was reachable from
attacker-influenced, unbounded `@db.Text` content rendered on the reviewer's browser main thread.

## Symptoms

- A single crafted proposal whose summary is one long line of space-separated underscore tokens
  (`_a _a _a …`) froze the tab for seconds when the proposals inbox rendered.
- Measured on the offending regex: 128 KB of single-line input → ~6.4 s of synchronous
  main-thread work (clean O(n²): each input doubling ≈ 4× time).
- The input (`PendingBacklogProposal.summary`, `ProjectMeetingTranscript.summary`) is `@db.Text`
  (unbounded) and derived from LLM analysis of Teams/meeting content — i.e. attacker-influenced.

## What Didn't Work

**First fix — bound the underscore regex to a single line.** The original pattern used
`[\s\S]*?` (crosses newlines); it was changed to `.*?` to match the sibling asterisk rule:

```js
// before: quadratic across the WHOLE body on many stray underscores
text = text.replace(/(?<![\w])(___|__|_)(?=\S)([\s\S]*?\S)\1(?![\w])/g, "$2");
// "fix" #1: bounded to one line — but still quadratic WITHIN one long line
text = text.replace(/(?<![\w])(___|__|_)(?=\S)(.*?\S)\1(?![\w])/g, "$2");
```

This removed the multi-line blowup but not the single-line one: `.*?` only caps the scan to a
*line*, so a payload with no newlines reintroduces the exact O(n²).

**The regression test gave false confidence.** The test that shipped with fix #1 built its
pathological input as `"_a\n".repeat(20000)` — every third character is a newline, so `.*?`
capped each scan to ~2 characters. It passed in ~5 ms and *looked* like ReDoS coverage, but it
never exercised a long single-line body, which is the surviving quadratic. The adversarial code
reviewer caught this after `ce-simplify-code` had already applied fix #1.

## Solution

Cap the input length before the regex passes run. Previews only ever show ~2 lines, so a few KB
is far more than enough, and the cap makes cost constant regardless of payload size:

```js
export function stripMarkdown(input: string | null | undefined): string {
	if (!input) return "";
	// Callers only show the result in a 2-line clamp, so a few KB is plenty —
	// and it bounds cost to a constant regardless of a hostile payload.
	let text = input.length > 4000 ? input.slice(0, 4000) : input;
	// … regex passes …
}
```

Measured with the cap: 128 KB single-line input → ~6 ms (was ~6.4 s).

## Why This Works

The blowup is structural, not a tweakable regex detail. The underscore pattern's closer carries
a word-boundary lookahead `(?![\w])`, and the capture must end in non-space (`(.*?\S)`). For
space-separated tokens (`_a _a _a`) every `_` is followed by a word char, so **no opener can ever
pair** — the engine tries all `O(n)` extension lengths for each of the `O(n)` openers, all
failing: `O(n²)` per line. The asterisk sibling `(\*\*\*|\*\*|\*)(.+?)\1` has no such closer
constraint, so its openers pair and *consume* — linear. That asymmetry is why only underscores
blew up, and why making the regex "smarter" is the wrong lever. Bounding `n` at the input
boundary is the robust fix; the regex complexity no longer matters once `n` is a constant.

## Prevention

1. **For untrusted, unbounded input processed synchronously on the main thread, cap the input
   length before any regex — don't rely on making the regex safe.** A length cap is O(1) insurance
   that survives future regex edits; a "safe" regex is one refactor away from being unsafe again.
   This applies wherever the *display* need is bounded (previews, clamps, badges) but the *source*
   is not (`@db.Text`, LLM output, pasted content).
2. **ReDoS regression tests must use the input shape that actually triggers the quadratic —
   usually a single long line with NO newlines.** A `"\n"`-separated fixture silently caps per-line
   scan cost and passes green while the production hole stays open. Assert a hard time budget
   (`< 200 ms`) AND include a single-line variant, not just a multi-line one.
3. **Treat a lazy quantifier followed by a can-fail anchor/lookahead as a ReDoS smell** —
   `(.*?\S)\1(?![\w])` where the closer frequently fails to match forces a full rescan per opener.
   When you see one over untrusted input, reach for an input cap rather than trusting the engine.
4. **A behavior-preserving simplification pass is not a security pass.** Fix #1 came from
   `ce-simplify-code` (efficiency lens) and looked complete; the *adversarial* reviewer, prompted
   to find a concrete exploit input, is what surfaced the survivor. Run the adversarial lens on any
   change that touches regex-over-untrusted-input, even after a clean simplify pass.
