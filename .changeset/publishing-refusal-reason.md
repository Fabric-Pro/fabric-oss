---
"fabric-app": patch
---

Say why a publishing draft was not committed instead of calling every refusal a supersession

A terminal write to a Publishing Suite generation row can be refused for three
different reasons, and all three arrived at the caller as the same bare
`{ persisted: false }`:

- the CAS lost, because a deadline sweep reclaimed the attempt and a newer one
  owns the content type — a supersession, and routine;
- the attempt row is gone altogether, which has no tenant tuple to have changed
  and so cannot honestly be reported as a transfer;
- the project was archived or soft-deleted while the attempt was in flight, so
  the tenant lock refuses it;
- the stored row's tenant tuple no longer matches the project's.

All fifteen call sites — five generation activities, five failure markers and
five API start-procedure rollbacks — logged the first one's wording for all of
them. The rollbacks discarded the result entirely, so a refused rollback left a
GENERATING row with nothing recorded about why. "Attempt superseded" tells an
operator that a newer run took over, so they go looking for it; when the real
cause was somebody archiving the project mid-generation there is no newer run to
find, and the search ends in confusion rather than in an answer. That is worse
than a line that said nothing.

`completeTopicDraft`, `failTopicDraft`, `completePlanningAnalysis` and
`failPlanningAnalysis` now return a discriminated `DraftCommitOutcome` carrying
the reason, and all fifteen call sites report it through one shared
`logDraftRefusal` helper, which lives in `@repo/database` beside the type
because both consumers — `@repo/temporal` and `@repo/api` — are downstream of it. The helper also decides the LEVEL: a supersession is
the deadline sweep working and stays at info, while the other two mean somebody
acted on the project while a generation was running and are raised to warn —
`tenant_changed` is not reachable by any production code path today, so seeing
one at all is news and burying it alongside routine sweeps is how it would go
unnoticed.

The reason also travels OUT of each activity as an optional `refusalReason`, so
the workflow's own log line stops calling an archived project a supersession.
The status the activity returns is deliberately unchanged. A workflow that
branches on a renamed status value would fail replay for any execution already
in flight (TMPRL1100), so the reason travels as a new field rather than as a new
enum member.

Also fixed, same class of defect and found while measuring this one: the
orchestrator's token-budget message formatted its numbers with the HOST's
locale. `iteration-budget.test.ts` asserts `12,000/10,000` and fails on any
machine whose locale is not en-US — this one produces `12 000/10 000` with
narrow no-break spaces, which reads as a different value and does not match a
search for the number. The locale is now pinned, matching
`ai-chat-attachment.ts`.

Tests: two new cases pinning `project_ineligible` (an archived project and a
soft-deleted one, which share a reason because the lock's eligibility rule is
one predicate), six existing refusal assertions strengthened to name which
fence refused, and a new suite for the shared helper covering the level rule,
a distinct sentence per reason, the structured `reason` field, and an AST-based
family guard that every one of the ten call sites routes through it. Three
negative controls: collapsing two reasons onto one sentence, sending every
refusal to info, and deleting one call site — each fails exactly the cases that
name it.

Not included, reported separately: eight further `toLocaleString()` calls with
no locale, of which two are the same operator-facing-number shape (the audit
export row cap, in `packages/api`).
