# ADR-012: A JUnit-Normalised Core with Thin Per-Provider Fetchers

- **Status**: Accepted
- **Date**: 2026-07-29
- **Deciders**: Engineering team
- **Audience**: Engineers adding a CI provider to QA, or changing status mapping
- **Owner**: Fabric platform

## Context

Three providers ship today (GitHub Actions, GitLab CI, Azure DevOps) and more
are plausible. Their result APIs have nothing in common: GitHub exposes a
workflow run whose test results are inside a downloadable artifact ZIP; GitLab
exposes a pipeline with jobs and its own report endpoint; Azure DevOps has a
first-class Test Management API with Test Runs and Test Results and its own
vocabulary (`Completed`, `Aborted`, `NotApplicable`).

Their **status vocabularies** are not merely different, they disagree in shape:
GitHub `success`/`failure`/`timed_out`, GitLab `success`/`failed`/`canceled`
(one `l`), ADO `Completed`/`Aborted`/`InProgress`. There is no shared token to
key on.

The tempting design is a provider abstraction that goes all the way down — a
`Provider` interface with a rich model, each implementation returning fully
formed domain objects. It fails in a specific way: every consumer downstream
(linkage, findings, RCA, the run list, the coverage figures) then has to be
written against a union of provider concepts, and adding a fourth provider means
touching all of them.

## Decision

**Normalise to a JUnit-shaped core at the edge, and keep each provider's fetcher
as thin as possible.**

- A fetcher's only job is: talk to one provider, produce a list of runs and a
  flat list of per-test records, and advance a cursor. It owns the auth, the
  pagination, the artifact download, and nothing else.
- Everything past the fetcher — linkage, ingestion, findings, RCA, the UI —
  speaks one vocabulary: a run, and per-test records with a `TestResult`.
- `mapRawStatusToTestResult` is the single place a provider token becomes a
  Fabric result, and its rule is that **anything ambiguous reads as
  needs-attention** rather than as a pass. A status we have never seen must not
  silently become green.
- The provider's own token is preserved alongside the mapped one (`rawStatus`),
  because the mapping is lossy and a diagnosis needs the original.

## Consequences

**Good.** Adding a provider is one fetcher and one mapper branch; no downstream
consumer changes. The linkage cascade, findings and RCA were written once. The
`TestResult` enum stays small enough to render and reason about. `rawStatus`
means a mis-mapping is diagnosable after the fact rather than being a permanent
loss.

**Bad.** The normalised model is the lowest common denominator, so provider
features with no JUnit analogue have nowhere to live without widening the core —
ADO's richer Test Management concepts are flattened away. A mapping bug is a
single point of failure for every provider at once. `rawStatus` is dead weight
for the majority of rows that mapped cleanly.

**A consequence worth naming:** `providers/jira-xray.ts` contains a tested mapper
with no fetcher and no caller. It is intentionally unwired, not dead code — it
is the proof that the mapper layer is genuinely separable from the fetch layer.
Deleting it as "unused" removes that evidence.

## References

- `docs/qa/pipeline-results.md` — the provider table, the status mapping rules, and the cascade downstream of it
- ADR-013 — the linkage cascade this core feeds
