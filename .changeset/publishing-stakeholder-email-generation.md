---
"fabric-app": patch
---

Draft a stakeholder update email for a publishing topic, and say plainly when nobody confirmed whether the work shipped

Fizzy #1854, Phase 2C slice 2. Activates the Stakeholder Email generation tab on
the Topic Item Page — the last of the four content types. No tab reads "Coming
soon" any more.

**DEPLOY NOTE — the prompt seed is owed on every environment.** The new
`publishing_topic_stakeholder_email` SYSTEM prompt and its binding are
INSERT-ONLY and no workflow in this repo runs the seed. Until someone runs
`pnpm --filter @repo/database seed:prompts` on an environment, generation there
resolves no binding and falls back to the default body — which produces a
perfectly normal-looking draft, so the omission is invisible from the output.
The stored `promptSource` says `DEFAULT_UNBOUND` when that has happened.

No migration: Phase 2B built the draft tables generic over all four post types
deliberately, so this is a prompt, an activity, a workflow, three procedures and
a panel — the shape slice 1 established, which is the whole reason slice 2 is
small.

**One deliberate finding, recorded rather than papered over: there is no
server-side clamp here, because none can be derived from data Fabric holds.**
The Case Study clamps three model claims against the topic's open approval
threads, and it can because the claim and the thread name the same subject —
`CUSTOMER_NAME` asks "may we name the customer" and `customerIdentity` answers
it. `releaseStatus` has no counterpart: none of the eleven decision kinds asks
whether the work shipped, the collected context carries no work-item status, and
the topic's own status is about the CONTENT rather than the feature. The two
candidate substitutes are worse than nothing — clamping on `CLAIM_STRENGTH`
would demote correctly-SHIPPED emails on most technical topics, and inferring
from the work items would re-derive, from a thinner view, what the model already
read. A "Fabric set this" label on a guess costs more than no label, because the
Case Study's clamp earns that authority by being a comparison against a recorded
human decision. So the guarantee here is the LOCKED CLAUSE (which an org prompt
edit cannot remove) plus a panel that words every status as the draft's claim.
If a `RELEASE_STATUS` decision kind is ever added, the clamp becomes derivable
and the "release status is NOT clamped" describe in the activity test is the
first thing that should go red.

What the output schema buys: `releaseStatus` makes the PO's "if the topic is not
actually shipped yet, do not imply that it shipped" rule checkable. As prose it
could only be verified by grepping for the word "shipped", which catches neither
"we've rolled this out" nor a hedged sentence a busy reader skims as a launch.
All four DV13 states are present plus `UNCONFIRMED`, which is NOT a synonym for
`UPCOMING`: one means the context does not say, the other means the context says
it is coming, and only the first forbids shipped-implying language outright.
That distinction is why the panel banners `UNCONFIRMED` alone and the export
caveats it alone — the other four states are carried by the email's own prose,
and a warning on every draft is one nobody reads.

`AUDIENCE_SCOPE` and `CLAIM_STRENGTH` restrict this type on top of the shared
safety-critical set. `CODEBASE_DETAIL` deliberately does NOT: an email to
leadership is not where a codebase detail leaks, and a third entry under "open
questions" on every technical topic would teach the reader to skip the two that
apply. That one-kind difference from the Case Study's set is the only thing that
can tell the two apart, so it is pinned from both sides — in
`publishing-restrictions.test.ts`, in the activity's prompt assertions, and on
the tab strip where the same thread is listed on one 2C tab and absent from the
other.

Extracted while here: the `<<<SOURCE DATA: … >>>` markers and their escape moved
from `publishing-case-study-prompt.ts` into `publishing-source-data-markers.ts`,
re-exported so every slice-1 importer is unchanged. A second fenced prompt with
its own copy of the pair is the defect that file's own header warns about, one
level up — change the marker in one and the other's escape guards a token that
prompt no longer writes, with nothing going red.

Files: `packages/utils/lib/publishing-{source-data-markers,stakeholder-email-prompt,stakeholder-email-body}.ts`,
`packages/temporal/src/activities/publishing-stakeholder-email/*`,
`packages/temporal/src/workflows/generate-publishing-stakeholder-email.ts`,
`packages/api/modules/projects/procedures/publishing-suite/stakeholder-email.ts`,
`apps/web/modules/saas/projects/components/publishing-suite/StakeholderEmailPanel.tsx`,
plus the catalog, seed, job-key, barrel and router registrations.

## Fixed in passing

Every string field in both 2C schemas is now trimmed before its length check.
`inputsNeeded`, `safetyNote` and the case study's four list fields were
`z.string().min(1)` without a trim, so an entry of spaces passed validation and
was persisted; both panels then rendered it as a bullet with nothing in it. Not
purely cosmetic: a non-empty `inputsNeeded` makes a draft count as unclean, so a
blank entry put a caveat block on an otherwise clean export containing a bullet
that named no caveat. Both readers now trim and drop empties, which `audience`
already did and the lists had never been brought along to. The case study half
is already in master and is fixed here. Reported by an automated reviewer.

The shared marker pattern's gap is bounded. Unbounded, its last alternative
started at every occurrence of the marker words and scanned the rest of the
line for a closing run, costing O(n^2) on a value that repeats them - measured
183ms at 12,800 repetitions against 3.1ms bounded. The input is a transcript, a
project document or a pull request description, so it is exactly the
attacker-influenced string the module exists to make safe; a fence that hangs
the worker on hostile input is not a fence. Behaviour is unchanged on every
real marker and on the doctest, here-string and merge-conflict cases the
pattern is deliberately narrow to avoid mangling. Flagged by CodeQL on the
public mirror, where it blocked the merge.
