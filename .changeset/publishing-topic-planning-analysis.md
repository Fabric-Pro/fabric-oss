---
"fabric-app": patch
---

Publishing Suite: generate a Planning & Analysis worksheet for a topic, and surface its open questions on the topic page

Phase 2A-2 of the Topic Item Page (Fizzy #1851). An editor can now generate an
AI planning worksheet for one publishing topic — angle, why it is worth
publishing, key details, recommended authors and voice, audience fit,
recommended/needs-confirmation/deferred content types and supporting assets,
source signals, risks, and the decisions that still need a human answer.

**What it reads.** Only what the topic's own `provenance` names, every query
re-scoped by `projectId` as well as by id: the named stories, documents and
transcripts, plus the bodies of the named GitHub pull requests (capped at 20
fetches, 4000 chars each, degrading to the bare coordinate on any failure).
Nothing is read by date window, so the model is never handed material unrelated
to the topic. Per-kind id caps (25) bound the prompt against a provenance blob
that names hundreds. Releases are deliberately NOT fetched: `TopicProvenanceSchema`
carries no release identifier and there is no `Release` table, so a window scan
would feed the model releases that may have nothing to do with the topic —
recorded as Phase-1A debt rather than papered over.

**Persistence.** New `PublishingTopicPlanningAnalysis` table, versioned per
topic, with a partial unique index on `status = 'GENERATING'` so only one run
can be in flight, a deadline (`executionTimeoutAt`) so a dead worker cannot lock
the topic forever, a tenant XOR CHECK, and a CHECK that a GENERATING row always
carries its deadline. `startPlanningAnalysisAttempt` locks the Project row
`FOR UPDATE` and derives the tenant tuple from the locked row, closing the
tenant TOCTOU that `createManualPublishingTopic` exists to fix; both terminal
writes re-validate under the same lock and compare-and-set on `GENERATING`, so a
reclaimed attempt cannot resurrect itself over a newer one.

**Two rows, not one.** `getPlanningAnalysis` returns the latest attempt AND the
latest READY analysis. A failed or in-flight regeneration therefore cannot blank
a good analysis — the panel keeps showing the previous version, labelled, which
is precisely when a reader wants it.

**Question identity is derived, not invented.** Question ids are hashed from
`(topicId, decisionKind, subject)` rather than from wording, so a regeneration
that rephrases a question keeps its identity — the property 2A-3's answers will
depend on. Questions are also derived from the analysis's own
`needsConfirmation` / `requiresApproval` buckets and merged with the ones the
model raised, so a confirmation requirement stated in a bucket can never end up
with no question attached to it (FR39).

**Editable prompt.** The worksheet prompt is a seeded SYSTEM prompt filed under
a new "Publishing Suite" area in the Prompt Library, resolvable per user, project
and organization. Its agent key and default body live in one shared constant that
the seed, the catalog and the activity all import, so the four places that must
agree cannot drift. When a bound prompt will not render, the run falls back to
the default body and says so on the page — the one fact about a run a reader
cannot otherwise recover from its output.

Also: the Publishing Suite project ratchet (derive tenancy from the loaded
Project row; treat request `organizationId` as a guard, never a scoping key) is
extracted to one helper now that two procedures need it, and AI spend for this
surface is tagged `publishing-planning-analysis` rather than folded into the
daily suggestion cron's line item.

**Two lifecycle fences added after adversarial review of the branch.** The
terminal writes now compare the attempt's STORED tenant tuple against the locked
project's current one and refuse to write when they differ, so a project that
transfers owner mid-run cannot have output generated under the old tenant
published into the new one; the attempt opener reclaims such a row immediately
rather than making the topic wait out its deadline for a row that can never
complete. This mirrors the cross-tenant supersede `dispatch-suggestion.ts`
already performs on the sibling table. Separately, the read now reports a
GENERATING attempt past its deadline as expired and the panel treats it as
retryable — the only code that reclaims a stranded row runs inside the next
attempt, so a button disabled on `status === GENERATING` alone would have locked
a topic permanently whenever a worker never started or a workflow hit its
execution timeout.

**Deploy notes:** needs `pnpm --filter @repo/database apply:rls` (the new table's
RLS policy) and the prompt seed to be run after migration.
