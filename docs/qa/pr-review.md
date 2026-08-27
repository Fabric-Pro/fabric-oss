# Pull-request review

How Fabric reads a pull request and what its two review lenses make of it.

- **Audience**: engineers working on the PR-review surface; anyone deciding whether to trust a finding
- **Owner**: Fabric platform team
- **Shipped in four phases** (#2407, #2411, #2413, #2414)

The user-facing page is [Pull Requests](../../apps/web/content/docs/features/testing/pull-requests.mdx).
This page covers the parts a reader of that page does not need and a maintainer does.

---

## Shape

```
Person names a PR ──► Fabric fetches metadata + diff  ──► PullRequestReview
   (never a webhook)      (project's own repo credential)      (diff bounded, truncation MARKED)
                                                                    │
                                    ┌───────────────────────────────┴──────────────┐
                                    ▼                                              ▼
                        QA lens (a MODEL judgement)                 Architecture lens (COMPUTED)
                        diff + features + criteria                 Tarjan over Atlas IMPORTS edges
                        + linked case titles                                       │
                                    │                                              │
                        groundFindings drops what                      cycles the CHANGE is in
                        the model could not have known                            │
                                    └──────────────► PullRequestReviewFinding ◄────┘
                                                     (lens-scoped, advisory)
                                                              │
                                                    a person Accepts / Dismisses
                                                     (files nothing, ever)
```

## The two lenses are different KINDS of thing

This is the distinction to hold on to, because it decides how much each finding
is worth and what gates apply.

| | QA lens | Architecture lens |
|---|---|---|
| Source | A model reading the diff | Tarjan over Atlas's import graph |
| Can be confidently wrong | Yes | No — a cycle exists or it does not |
| Costs credits | Yes | No |
| Needs | An AI provider | An Atlas analysis |
| Provenance recorded | Model name | None — nothing to attribute |
| False-positive rate | Must be measured | Not applicable |

### The one rule it checks

| Rule | Derived from | Why it is decidable |
|---|---|---|
| Circular imports | Tarjan over the import graph | A cycle exists in the graph or it does not |

That is the whole list, and the reason the list is short is worth keeping.

Two layer rules were checked here for one release cycle and withdrawn before they
reached anyone: *a package may only import what it declares*, and *a library may
not import an application*. Both read as facts about the repository under review.
Neither was.

The declarations came from the filesystem of the server running Fabric, not from
the project being reviewed — the reader took no project id. A package directory
absent from that server's own workspace therefore read as "declares nothing"
rather than as "cannot check", so **every** cross-package import in it was
reported as undeclared. Any reviewed repository laid out as a monorepo got a
review made almost entirely of the checker's own confusion. The guard meant to
prevent this asked whether the declaration map was empty, which it never was.

The direction rule failed the same test for a subtler reason: it reads no
declarations at all, but it hardcodes `packages/` and `apps/` and asserts what
those two directories mean. That is this repository's convention. A project whose
`packages/` holds applications would have been told its correct imports were
HIGH-severity violations.

A cycle survives the objection that killed both: it is a property of the reviewed
project's own graph, with no second repository involved and no convention assumed.
The general rule this leaves behind — **a lens may only report what the reviewed
repository itself states** — is the one to apply to any rule proposed for this
lens in future. A rule that needs a manifest somebody maintains by hand is out for
the older reason too: it goes stale the first time keeping it current is
inconvenient, and reports its own opinion from then on.

**The architecture lens must never ask a model whether a cycle exists.** If prose
is ever wanted there, it may only *word* a cycle the code already proved. "Does
this module import that one" is precisely the question a model answers confidently
and wrongly, and a wrong architecture finding is expensive: somebody goes looking
for a cycle that is not there.

## Grounding: the false-positive control is code, not prompt wording

`groundFindings` (`packages/ai/lib/prompts/pr-review-qa.ts`) checks every QA
finding against facts already held, and is the reason the list is worth reading.

| The model claims | What happens | Why |
|---|---|---|
| A path not in the diff | **Drop the finding** | It asserted a location and got it wrong — the observation is about code it never saw |
| An unknown feature identifier | **Strip the link**, keep it | An unattached observation about the diff still stands |
| A criterion past that feature's criteria | **Strip the ref**, keep it | It points at a traceability row that does not exist |

It runs whatever an org does to the `pr_review_qa` prompt in the Prompt Library.
How many were discarded reaches the reader *and* the audit row — a run that drops
most of its output is the earliest sign the prompt or model has drifted, and that
is invisible from the finding list alone.

## Things a maintainer will otherwise get wrong

**`qaAnalysedAt` / `architectureAnalysedAt` are nullable on purpose.** Null means
"never run"; a timestamp with zero findings means "ran, found nothing". Collapsing
them turns an un-run lens into a clean bill of health. The panel always says which.

**Re-running a lens discards prior ACCEPTED/DISMISSED judgements.** Deliberate:
they were judgements about previous wording over a previous commit's diff, and
carrying them onto new text would show a verdict nobody gave. `replaceLensFindings`
deletes, inserts and stamps in one transaction so "analysed" and the findings can
never disagree.

**Findings are NOT `TestFinding`.** That model is a failing test — keyed on a
fingerprint from a test's identity, requiring a `testName`, and `RESOLVED` there
means "the test went green". A review observation's whole point is that there is
no test. Phase 1 briefly claimed otherwise in a code comment; both are corrected.

**`listFeaturesForPrReview` orders least-covered first, and the caller caps the
list.** The ordering is therefore load-bearing: it decides which features the model
ever sees. Reversing it would have the lens reason about the best-covered features
while the untested ones fall off the end.

**Two bounds, and only one of them bites.** Storage holds 400 KB of diff; the model
sees 200 KB. Across 25 consecutive merged PRs in this repo the median diff was
16 KB and the largest 182 KB, and none came within half of the storage bound. The
model bound started at 60 KB by guess and was truncating 6 of those 25 — see
`PR_REVIEW_MODEL_DIFF_BYTES`.

**There IS a webhook now, and it does not register itself.** This section used to
say the webhook was deliberately not built, citing ADR-011. That is stale: the
2026-08-13 rebuild added one. ADR-011 is not contradicted, because Fabric still
registers nothing on a customer's repository — somebody pastes the endpoint into
their own repository settings, and `prReviewAutoReviewEnabled` is off until a
project asks. A person-initiated read and review remains the other half.

**One endpoint, addressed to a project.** The shared one is retired.

`POST /api/webhooks/github/pull-request/{projectId}`, authenticated against that
project's own `ProjectQaWebhook` secret — the same secret, rotation window and
expiry the CI-results webhook uses.

The retired path — `/api/webhooks/github/pull-request`, no project in the URL —
now answers `410 Gone`. It verified one deployment-wide `GITHUB_WEBHOOK_SECRET`,
and the setup instructions hand that value to every customer admin who connects a
repository. So a signed delivery proved only that somebody holding the deployment
secret sent it, while the repository URL inside was chosen by whoever sent it:
anyone who had ever configured the feature could name another tenant's repository
and have Fabric read that tenant's source, spend their credits, and comment in
their pull request under their own credential.

**A guard was tried first, and is recorded here because the reasoning generalises.**
Refusing a delivery whose matches span more than one tenant cut the reach from
every tenant to one. It cannot do better: a secret shared across tenants does not
identify a sender at all, so "exactly one tenant matched" is not evidence that the
delivery came from that tenant. Bounding the blast radius of an unauthenticated
trigger is not the same as authenticating it — the fix has to remove the inference,
not narrow it, which is what putting the project in the URL does.

`410` rather than the 200-for-everything rule the live endpoint follows. That rule
exists so a WORKING webhook is not throttled or disabled for answering 4xx to
deliveries that were never ours. A deliberately dead path wants the opposite: fail
visibly in the sender's own deliveries tab, so somebody moves it.

## The false-positive rate, measured

Twenty-two merged pull requests from this repository were run through the QA lens
against a project whose features are this product's own. Ten produced findings;
twelve produced none. Every one of the **44 findings was judged by hand** against
the pull request's actual diff and the tests it shipped — the question asked of
each was not "is this a reasonable thing to say" but "does the pull request
already contain a test for exactly this".

| | Findings | False positives |
|---|---|---|
| Sign-offs gate a feature's Done transition | 7 | 0 |
| Meeting action-item links | 4 | 1 |
| Document refresh on deploy | 3 | 0 |
| Off-tier case becomes a proposal | 2 | 1 |
| Meeting back-references read live | 2 | 0 |
| Read a pull request and show its diff | 5 | 0 |
| Architecture lens, layer rules | 4 | 0 |
| Confirm before unlinking a meeting | 4 | 1 |
| Testing surface redesign | 7 | 1 |
| The QA lens itself | 6 | 0 |
| **Total** | **44** | **4 — 9%** |

Comfortably inside the <20% the work was measured against, and the four are worth
naming because they share one shape — **the behaviour was tested at a different
layer than the one the finding pointed at**:

- a "does not retrigger matching" claim against a component, where the decision it
  names is covered by `skips a meeting already matched at the current version` in
  the activity beneath it;
- a "lens-authored cases are exempt" claim, contradicted outright by
  `does not demote a lens-authored security case` in the same file's test;
- a "no case verifies the section-specific status text" claim, contradicted by
  `names the section a changed field belongs to`;
- a copy change to a translation string reported as untested behaviour.

None invented a file, a line, or a feature — the grounding filter makes that
class impossible, and it showed: `dropped` was 0 on all 22 runs, so nothing the
model produced had to be thrown away as ungrounded.

**The complementary number is not measured.** This is a false-*positive* rate. The
twelve empty results were not audited for behaviour the lens should have flagged
and did not, so nothing here bounds the false-negative rate. Most of those twelve
shipped tests of their own, which makes an empty answer plausible — but plausible
is not measured, and it should not be read as one.

A latency note, because it misleads: a run reporting nothing returns in 1.5–3
seconds even on a 167 KB diff, while a run reporting seven findings takes 12–20.
That gap is output length, not a failed call — prefill is fast and `{"findings":[]}`
is a handful of tokens. An empty result that came back quickly is still a real
verdict.

## Built for this, though nothing asked for it

Recorded because these are shared now, and the next person will wonder where they
came from.

**`@repo/utils/acceptance-criteria`** — one acceptance-criteria parser. There were
two (`parseAcceptanceCriteria` for the traceability matrix, `countAcceptanceCriteria`
for the drafter's cap), held together by a parity test that existed *because they
had already drifted*. A differential run over 11,154 generated blobs found them
still disagreeing on 2,098, in both directions. The PR-review lens would have been
a third implementation, so they became one. This was a **fix**, not only a
refactor: the matrix already rendered the parser's answer, so on those shapes the
drafter was told an "AC N" numbering that did not match the rows a reader lands on.

**`@repo/utils/import-cycles`** — `findImportCycles`, iterative Tarjan, dependency
free. Reports one strongly-connected component *once* with the shortest path round
it, rather than the exponentially many distinct cycles through a tangle. Shortest
is also stable, so two runs do not look like two problems. 12 tests, including the
diamond (shared dependencies are **not** a cycle — the likeliest false positive)
and a 20,001-node chain that would overflow a recursive implementation.

**`tooling/docs-screenshots/`** — the public docs' screenshots are rendered from
committed HTML mocks, because `apps/web/content/docs` is published and a capture of
a running Fabric carries a real organization, project and repository name that
cannot be retracted once indexed. The renderer fetches real Inter/JetBrains Mono so
the type matches, **fails** if Inter did not load, fails if a mock has no registered
shot, and warns when a mock's tokens have drifted from `theme.css`. Never publish
anything from `.claude/ui-validation/` — those are staging captures with real names.

**A test on the QA sign-off transition gate** (`update-story.ts`). The gate is on
the *transition* into Done, not on the value being Done, and nothing asserted that.
Simplifying it back to a value check would silently refuse every edit to an
already-shipped feature once a project raised its threshold. Proven by reverting:
the DONE→DONE case fails against the value-gate and passes against the transition-gate.

## The other half: reviewing this repository's own pull requests

Everything above is the **product**: Fabric reviews a pull request in a
customer's connected repository and shows findings in their project. A separate
set of requirements asks for something different — that *this* repository's own
pull requests get reviewed automatically in CI. Both now exist, and confusing
them is the single easiest mistake to make here.

`.github/workflows/pr-review-checks.yml` runs on every pull request into
`master` and leaves one comment, updated in place rather than appended to. It is
advisory by construction: not a required check, its review step cannot fail the
run, and an unresolved comment never blocks a merge. A failure of the tool
itself is reported in the comment and in the job log.

It asks **no model at all**. There is no model credential in Actions, and the
reasoning that shaped the architecture lens applies with more force to a gate
that speaks on every pull request: a reviewer that is confidently wrong costs an
afternoon, and one that cries wolf gets muted. The rules live in
`tooling/pr-review-checks/check.mjs`, and each earns its place by being
decidable and by not duplicating a gate that already exists.

| Rule | Why it is decidable | Why not already covered |
|---|---|---|
| `unsafe.now()` or `recordAudit()` in workflow code | Both are stated as rules in `packages/temporal/README.md` | Nothing enforces either |
| A model call with no `maxOutputTokens` | The call either states a budget or it does not | Replay validation and lint both ignore it |
| Schema changed, `tenant-db.ts` did not | Two paths in the changed set | A missing registration has reached master before |

Findings are limited to lines the pull request introduced. Reporting
pre-existing problems in any file a change happens to open is exactly how a
review bot trains people to skim past it.

**Two rules were tried and rejected by running them, not by reasoning.**
Flagging `Date.now()`, `new Date()` and `Math.random()` in workflow code
produced 28 findings across 72 files, every one of them correct code: the
Temporal TypeScript SDK makes all three deterministic inside the sandbox, and
this repository's guidance says to use `Date.now()`. If a future change wants a
determinism rule here, that is the one it must not re-add.

An oRPC handler missing its permission gate is deliberately absent:
`packages/api/__tests__/permission-coverage.test.ts` already fails the build for
it.

## Deployment: what somebody has to set

**Nothing in the app's environment.** This used to require
`GITHUB_WEBHOOK_SECRET`, and that requirement is what made the shared endpoint
unfixable: one value, held by every customer admin who configured the feature.
Each project now carries its own secret in `ProjectQaWebhook` — created and
rotated from Settings ▸ Testing, so no operator is in the loop.

**The endpoint** is `POST /api/webhooks/github/pull-request/{projectId}`,
subscribed to `pull_request` only. It answers 200 for anything that is not ours —
a repository the project has not connected, an event that changes no code, a
draft — because a 4xx teaches GitHub to retry, then throttle, then disable a
delivery that is working correctly. What does answer 4xx is a real
misconfiguration somebody must act on: 401 for a signature mismatch, a missing or
expired secret, or a secret the deployment can no longer decrypt; 429 over the
rate limit; 413 over 1 MB.

**Write access on the connection that posts.** Reading a pull request needs read;
commenting needs write. For a GitHub App connection the App must declare
**Pull requests: Read and write** *and* every installation must approve the
change — granting it on the App alone leaves existing tokens on the old access,
which is a failure that looks like a code bug. For a PAT connection, reconnect
with a token that carries it.

**Per project**, `prReviewAutoReviewEnabled` gates the whole path and defaults to
false. It is read before any work is scheduled, so a project that never opted in
costs one query per delivery.

## Requirement trace: pull-request review

Checked against the card's own acceptance criteria, not against what was built.

| Requirement | State |
|---|---|
| requirement 1 — QA perspective (coverage, criteria) in the output | **Met** — verified live, six findings citing criteria |
| requirement 1 — architecture perspective, *dependency risks* | **Met** — circular imports plus the imports a project declares forbidden, both computed from its own graph |
| requirement 1 — architecture perspective, *design-pattern compliance* | **Met** — a project declares the imports its architecture *requires* (`=>`), and a file matching the pattern that imports nothing matching it is a finding. Nothing is inferred; see below |
| requirement 2 — a flag with a specific recommendation when coverage is absent | **Met** — every finding states what a case should assert |
| requirement 3 — lens disabled in settings ⇒ no output from it | **Met** — per-lens switches, refused before any work is spent |
| requirement 4 — description, affected file/line, remediation | **Met, with a stated limit** — description and remediation are enforced: `recommendation` is its own column and a finding without one is dropped, exactly as one without a title is. **Line is absent on every architecture finding, and that is correct rather than missing**: the import graph records that one file imports another, not which line did it; a cycle is a property of a whole file's imports; and a required-import violation is about an import the file does NOT have, so there is nowhere in it to point. QA read the hardcoded `null` as a defect, which is fair — the trace claimed file AND line were met without stating the limit. Ordering was a real defect and is fixed: `orderBy severity: "asc"` on a String column sorted HIGH < LOW < MEDIUM, so a MEDIUM finding rendered below a LOW one in the app and in the customer's comment |
| Scope — integrates with QA depth (light ⇒ lighter review) | **Met** — reads the same `strategyDepth` as the drafter, and the tier now reaches the prompt. It was computed and dropped before, so a light project got a full-depth review that was merely trimmed by the cap |
| requirement 5 — CI triggers the review on every pull request to master, no manual step | **Met for the PRODUCT; this row used to cite the wrong evidence** — it scored the requirement against `pr-review-checks.yml`, which is this repository's own CI job and asks no model, so it says nothing about whether a customer's pull request gets reviewed. The product evidence is the `pull_request` webhook: `opened`, `reopened`, `synchronize` and `ready_for_review`, no manual step per pull request. Two honest limits: setup takes two manual acts (an admin creates the project's webhook secret and adds the webhook, a project switches auto-review on) — one fewer than before, because retiring the shared endpoint removed the operator's environment variable from the path — and the automatic path is GitHub-only — GitLab and Azure DevOps are read and commented on, but only when a person asks |
| requirement 6 — the reviewer comments on the pull request, or says no issues found | **Met** — CI's computed checks leave one comment, updated in place. The model-backed lenses can now be posted to the same pull request on request (`postComment`), also as one comment edited in place, and also saying so when nothing is outstanding |
| requirement 7 — an unresolved comment does not block the merge | **Met** — not a required check, and the comment carries no state to resolve |
| requirement 8 — a reviewer failure does not block the merge and is visible | **Met** — the review step is `continue-on-error`, and the comment names the failure and points at the job log |
| Success — false-positive rate <20% | **Met by hand-measurement; now measured continuously too** — 4 of 44 findings (9%) across 22 pull requests, each judged by hand. The continuous figure used to be the DISMISSAL rate presented as this one, which it is not: three of the four dismissal reasons record that a CORRECT finding went unactioned. Dismissing now asks why, only `INCORRECT` counts, the panel states the rate against the 20% target, and the judgements live in a ledger so re-running a lens no longer erases the denominator |

**Design-pattern compliance is checked against rules the project wrote, never
inferred.** "Compliance" needs a statement of which patterns a codebase requires,
and the objection that held this back was that nothing recorded them: a model
asked to judge pattern compliance without a statement invents a standard and
reports deviations from it, which is the confidently-wrong failure this lens
exists to avoid.

The statement is now the project's own. A rule written `src/routes/** =>
src/auth/guard.ts : every route checks the session` says a file matching the left
pattern must import something matching the right one, and the import graph
settles whether it does. Two properties carry over from the forbidden-import
rules beside them: no model decides anything, and a project that declares no
required rule gets no findings from this. The trade is unchanged and deliberate —
a pattern nobody writes down is a pattern nobody enforces.

## Related

- [QA settings](./qa-settings.md) — the per-lens switches live in Settings ▸ Testing
- [Pipeline results](./pipeline-results.md) — CI failures, a different findings surface entirely
- [Test cases](./test-cases.md) — what a coverage finding is measured against

## Design-pattern compliance

The architecture lens reports two things, and both are properties of the
reviewed project rather than of this one.

**Circular imports** come from Tarjan over the project's own import graph.

**Forbidden imports** come from rules the project declared, under Settings ▸
Testing ▸ Pull-request review lenses, one per line:

```
src/ui/** -> src/db/** : the UI must not reach the database directly
# blank lines and # comments are allowed
```

`parseArchitectureRules` reads them and `findArchitectureViolations` checks the
graph. No model is asked anything, which keeps this lens inside the constraint
its own source file states: prose may WORD a violation the code proved, never
decide one exists.

### Why the record has to be the project's

"Compliance" presupposes knowing which patterns a codebase requires, and for
somebody else's repository no such record exists. The old `layer-rules.ts`
invented one — it hardcoded `packages/` and `apps/` and read dependency
declarations from Fabric's own filesystem — and produced findings whose only
real content was those assumptions. It is quarantined for that reason.

A project that declares nothing gets no findings. That is the honest answer, and
the trade is deliberate: a rule nobody writes is a rule nobody enforces, which
costs less than a checker reporting a convention it invented.

### What the checker will not do

- **No glob dialect beyond `*`, `**` and `?`.** Brace expansion and negation
  would widen the surface for a rule to match files its author did not intend,
  and a rule that quietly matches the wrong thing produces exactly the
  confidently-wrong finding this lens exists to avoid.
- **Only violations the change introduced.** A rule the repository has been
  breaking for a year is the repository's problem; attaching it to one pull
  request buries what that change did. Same narrowing the cycle check makes.
- **One finding per import**, even where several rules forbid it.
- **MEDIUM, never HIGH.** This is a convention the team chose, not a defect, and
  a rule written last week should not outrank a circular import in the same list.
- **No line number.** The graph records that one file imports another, not which
  line did it.
- **A malformed rule does not stop the lens.** The settings page names the bad
  line where somebody can fix it; refusing to run would lose the cycle findings
  too.
