---
title: "A Markdown parse guard is only as good as the shapes you timed — measure the production parser, keep a timing table, and re-check on read"
category: security-issues
date: 2026-10-16
module: proposal artifact analysis report (packages/utils report-text guard, temporal worker scan, web renderer)
problem_type: security_issue
component: full_stack
severity: high
symptoms:
  - "Model-written Markdown under the length cap passed the plain-text guard and then took the remark/micromark parser 1–17 s, in the worker and in the browser"
  - "Each review round found a new guard-passing shape: unclosed inline HTML openers, unbalanced brackets, lazy continuation lines, autolink punctuation runs, escape-dense paragraphs"
  - "Timing tests that looked comfortable under vitest were measuring micromark's development build, several times slower than production"
root_cause: logic_error
resolution_type: code_fix
tags: [markdown, remark, micromark, quadratic, cwe-407, dos, untrusted-input, model-output, guard, test-design, react-markdown]
related_components: [background_job, frontend, database]
---

# A Markdown parse guard is only as good as the shapes you timed

## Problem

A stored, model-written Markdown report (up to 60,000 UTF-16 code units, derived from untrusted sources) is parsed twice: by remark in a Temporal activity to find citation markers, and by react-markdown in the browser when a member opens it. A length cap does not bound the parse: micromark and its GFM extensions have several constructs whose cost grows with the square of a run, a paragraph or a document. The plan was a parser-free, linear guard (`reportTextNeedsPlainText`) that decides, before any parse, whether the text renders as Markdown or as escaped plain text.

## Symptoms

Three review rounds each found inputs well under the cap that passed the guard and then parsed slowly (production micromark build, this session's measurements):

| Shape | Parse time before the rule |
|---|---|
| `<?` or `<!--` openers repeated in one paragraph | ~3.3 s at 60k |
| An unclosed `[` followed by ~59k characters of words | ~10.4 s |
| A quote or list item continued on 30,000 unprefixed (lazy) lines | ~10–17 s |
| A bare `www.` link followed by thousands of `.` or `?` | ~1.1–1.7 s |
| Escapes and entity references dense in one long paragraph | ~1.3–1.5 s |
| 6,000 nested `>` on one line | stack overflow (`RangeError`) |

Rules per construct kept leaking because the guard approximated the parser's block and inline structure with a line scanner: a shape the scanner classified one way (a new list item, a closed bracket) the parser classified another (a lazy continuation, an open label).

## What Didn't Work

- **Per-paragraph counters reset at every line that looks like a list item.** `2.` under a plain line, a bare `*`, or a `- ` indented four spaces continue the previous paragraph in CommonMark; resetting there reopened the quadratic case. The reset now fires only on lines that surely open an item (0–3 spaces, a bullet or exactly `1.`/`1)`, then content), checked against the real parser with a seeded fuzz.
- **Exempting fenced code from the counters.** A naive fence tracker disagrees with the parser (an HTML comment or an indented fence hides the opener), so hostile text after a fake fence escaped every rule.
- **Trusting vitest timings.** Vitest resolves micromark's `development` export condition; the same text parses 5–10× slower there than in the worker or the production web bundle. Limits tuned against those numbers were too strict; timing assertions written against production numbers would flake in CI.
- **A cap on matched markers only on the server.** The worker scanned the first 200 citation markers, but the browser plugin turned every later marker of a listed source into an interactive chip, so 11,000 `[S1]` rendered 11,000 popover components.

## Solution

`packages/utils/lib/proposal-artifact/report-text.ts` keeps one linear pass with a named, exported budget per measured cost driver (constants at lines 26–130): nesting depth, table rows and cells (per table and in total), block lines, total non-blank lines, lazy continuation lines after a container opened, line length, emphasis delimiters, brackets and a bracket-walk budget, `<!`/`<?` openers, punctuation runs inside a bare URL, and a "text join" budget for escape- and entity-dense paragraphs. Three supporting rules close the gaps the guard cannot:

1. **Order.** Cut to the cap, run the guard, and only then parse; any parser throw also sets plain text (worker `toStoredReport`).
2. **Re-check on read.** `parseStoredAnalysisReport` recomputes `plainText` with the current guard on every read (`packages/database/prisma/queries/projects/proposal-artifact-report.ts:363`), so a stricter guard also protects rows stored before it.
3. **Cap rendered elements at the server's scan limit.** The web citation plugin creates at most `REPORT_CITATION_SCAN_MAX_MARKERS` chips per document (`apps/web/modules/saas/projects/components/proposal-artifact/report-citations-remark.ts`).

## Why This Works

The guard does not try to parse; it charges each cost the parser is known to pay, at the granularity the parser pays it (per paragraph, per container run, per URL, per document), and refuses past a budget whose worst passing case was measured. The re-check on read decouples the guard's evolution from stored data, and the render cap bounds the one cost the guard cannot see (component count, not parse time).

## Prevention

- Keep a **timing table of the worst passing shape per rule** as a regression test (`packages/utils/__tests__/proposal-artifact-report-citations.test.ts`, "parses %s within a second", fastest of three parses). Add a row for every new rule and every bypass a review finds; build hostile fixtures as single long lines and as many short lines, since the two stress different paths (see [redos-in-preview-markdown-strip](redos-in-preview-markdown-strip.md)).
- **Measure limits with the production build** (`NODE_ENV=production`, default export conditions) and leave the dev-build test bound with several-fold headroom.
- **Re-run the timing table on any micromark / remark-gfm / react-markdown upgrade**; the limits are calibrated to the versions in the lockfile, and a parser change can move every cost.
- Treat a parse guard as **defence with a known residual**: an unprobed construct may still be super-linear. Where the cost matters, also bound the work itself (render caps, mount-on-open, an error boundary that falls back to escaped text).
- Fuzz the guard against the real parser (random prefixes plus a long tail) before trusting a new reset or exemption rule.
