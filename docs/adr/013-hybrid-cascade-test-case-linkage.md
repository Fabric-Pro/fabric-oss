# ADR-013: Automated Tests Link to Cases Through a Three-Tier Cascade, and a Named Tag Never Falls Back

- **Status**: Accepted
- **Date**: 2026-07-29
- **Deciders**: Engineering team
- **Audience**: Engineers working on QA ingestion, coverage figures, or findings
- **Owner**: Fabric platform

## Context

An ingested CI run yields test records like
`AuthSpec.resets_the_password`. A Fabric project holds authored cases like
`TC-014 — "Resets the password"`. Coverage, findings, RCA and per-feature
scoping all depend on deciding which record belongs to which case.

Neither extreme works:

- **Exact identifiers only** (the test must name `TC-014`) is correct but
  demands the team retrofit every existing test before Fabric shows them
  anything. Adoption dies at that step.
- **Fuzzy matching only** (compare names) works on day one and is wrong
  intermittently forever. Its failures are the worst kind: a test silently
  attributed to the wrong case makes coverage read *higher* than it is, which is
  precisely the number people trust.

## Decision

**Match through three ordered tiers, most explicit first, and stop at the first
tier that resolves:**

1. **Tag** — the test names a case identifier explicitly (`TC-014`).
2. **Path** — the case records an `automationFilePath` that the test's file matches.
3. **Title** — the test name resembles the case title.

And the ruling that gives the cascade its value:

> **A tag that names a case which does not exist is NOT downgraded to a title
> guess. It is left unmatched.**

Someone who wrote `TC-014` in their test made a claim. If `TC-014` was deleted or
renamed, the honest answer is "this test points at nothing" — a fixable,
visible problem. Falling through to a title guess converts an explicit,
diagnosable error into a silent mis-attribution, and does it specifically to the
teams who did the most work to be precise.

## Consequences

**Good.** A project sees useful linkage on the first sync with no changes to
their test suite, and can tighten it incrementally by adding tags where accuracy
matters. Precision is opt-in and rewarded: once a test is tagged, no heuristic
can override it. Unmatched tests are surfaced rather than hidden, so the gap is
actionable.

**Bad.** Three tiers mean the answer to "why did this test match that case"
depends on which tier fired, and that has to be recorded and shown or the
linkage is unexplainable. Tier 3 will still mis-match sometimes — it is a
heuristic, and it is doing the job people actually onboard with. The no-fallback
rule surprises people: a typo'd tag produces *nothing* rather than a plausible
guess, and that reads as broken until you know the rule.

**Rejected: matching on the run, not the test.** Cheaper, and useless — a run
covers many cases and gives no per-case verdict.

## References

- `docs/qa/pipeline-results.md` — the three tiers and the unmatched-tests surface
- ADR-012 — the normalised records the cascade runs over
