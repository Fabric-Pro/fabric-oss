# QA settings

Settings ▸ Testing (the per-project QA policy) and Settings ▸ Environments (its deployment targets).

- **Audience**: engineers working on the QA policy surface; support engineers explaining what a setting changes
- **Owner**: Fabric platform team

Both pages live under Project Settings and ride the SAME client gate as the rest
of the QA surface — `ProjectSettings.tsx` reads
`NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES` once and passes it to both the tab list
and the renderer. If Settings ▸ Testing is missing, the flag is off.

(An earlier revision of this page asserted the opposite. It was wrong, and the
same wrong claim lived in `README.md` until it was corrected there too.)

---

## Settings ▸ Testing

### Test-case generation

Three toggles at the top of the page, stored as `Project` columns rather than on
`ProjectQaSettings`:

| Toggle | Field | Default | What it changes |
|---|---|---|---|
| Generate manual test cases | `generateManualTestCases` | on | Master switch. Off stops all drafting for the project and spends no credits. |
| Apply TDD approach | `applyTddApproach` | off | Cases are drafted and reviewed **before** implementation instead of after. Also makes the feature's QA analysis read the drafted cases — see `feature-qa-tab.md`. Disabled while generation is off, because the ordering has nothing to order. |
| Open bugs for failing tests | `autoCreateBugsFromFailures` | off | A CI failure on a linked case opens a bug automatically. One bug per case; not reopened while one is already open. |

These live on a different table from the rest of the page, which is why they save
**immediately, one at a time**, while everything below saves as a whole form.
That difference is deliberate: it is how they behaved on Settings ▸ AI Assistant,
where they used to live, and changing *when* a setting applies while moving it
would have been a behaviour change disguised as a relocation.

`Project.qaStrategyLevel` — the depth of generated **QA Strategy documents** — is
a different setting and remains on Settings ▸ AI Assistant.

### QA policy

One form, saved as a whole (`ProjectQaSettings`, one row per project).

Reads are **lazy**: a project that has never saved has no row and the API answers
with defaults plus `configured: false`, so viewing the page never writes and the
form can say "currently using Fabric defaults". The row appears on first save.
Every field is optional server-side, so a partial payload preserves stored values.

| Setting | Field | Default | What it changes |
|---|---|---|---|
| Strategy & depth | `strategyDepth` | `AVERAGE` | AI drafting |
| Required test types | `requiredTestTypes` | `[]` — follow the tier | AI drafting |
| Evidence policy | `evidencePolicy` | `SCREENSHOT_REQUIRED` | AI drafting |
| Sceptic roles | `scepticRolesEnabled`, `scepticRoles` | on, all five | AI drafting |
| Index coverage | `indexCoverageEnabled` | `true` | the coverage rings |
| Coverage target | `coverageTarget` | `80` | the coverage rings, and the gate on marking a feature done |
| Confidence threshold | `confidenceThreshold` | `80` | the bar a verdict must clear to be recorded; below it a step is `NEEDS_REVIEW` |
| Default environment | `defaultEnvironmentId` | `null` | which environment a run targets when the dispatch does not name one |
| Default resolution | `resolutions` | `1920x1080`, `1366x768` | the first entry is the viewport a Fabric run uses |
| Default browser | `browsers` | `chromium` | the first entry is the browser a Fabric run launches |
| Evidence retention | `evidenceRetentionDays` | `90` | days a run's screenshots are kept; `0` keeps them indefinitely |
| Rules / implementation notes | `rulesMarkdown`, `implementationNotes` | empty | house rules given to the runner before it drives a case |
| Automatic result sync | `pipelineSyncEnabled`, `pipelineSyncIntervalMinutes` | on, 15 | whether the sweep pulls CI results for this project, and how often |

Every field above now has a consumer. `confidenceThreshold` was the last one that
did not: it shipped with the QA policy, defaulted to 80, and was labelled
"minimum AI confidence before a verdict is recorded" while nothing read it. The
runner now asks the model how sure it is about each step it judges, and a step
answered below the bar records `NEEDS_REVIEW` rather than a verdict nobody should
act on.

Three things worth knowing before changing it:

- **It went live at 80 for every project**, because that is the default every
  project already had stored. `0` turns the gate off and restores exactly the
  previous behaviour.
- **A model that reports no confidence keeps its verdict.** The gate only fires
  on a number the model actually gave. This is deliberate — see
  `docs/qa/agentic-runs.md` § *The confidence threshold* for why the alternative
  is unusable — and the runner logs each time it happens.
- **It is not the auto-accept design that was rejected.** The threshold does not
  decide whether a failure files a bug; an agentic failure still only ever
  creates a finding for a person to promote. It decides whether a verdict is
  recorded at all.

The four run-shaping fields above it are **defaults, not constraints**: a dispatch
that names its own environment, browser or resolution wins, and the stored value
is what fills the gap.

Sceptic role **keys** are stored (`security`, `ux`, `performance`,
`accessibility`, `edgeCase`), not labels, so the copy can change without a
migration. Unknown keys written by a newer build are filtered out before save
rather than being rejected wholesale.

### How the policy reaches AI drafting

`strategyDepth`, `evidencePolicy` and `scepticRoles` are rendered into the
**test-case drafting prompt**. `describeQaPolicy` turns the stored enums into
instructions a model can act on — "HARD" means nothing to a model, "cover the
happy path, every negative path, boundary values and concurrency" does — and
feeds them to a `{{{qaPolicy}}}` slot in the seeded template.

`strategyDepth` contributes **two** sentences, from two records that must be read
together (`packages/ai/lib/prompts/test-case-drafting.ts`):

| Record | Axis | Example (`EASY` — Light) |
|---|---|---|
| `DEPTH_GUIDANCE` | how thoroughly to explore a criterion | "Keep it light: the happy path and the most important negative case per criterion." |
| `DEPTH_TEST_TYPES` | which test types may be written at all | "Write functional/acceptance cases ONLY. Do not write integration, end-to-end, security…" |

The second record exists because the tier previously changed only the adjectives.
Settings ▸ Testing advertised a per-tier test-type mix that nothing enforced, so a
project set to Light still drafted end-to-end and security cases and still paid for
them. Each tier now states an explicit **exclusion** as well as an inclusion: a
model given only an inclusion list treats it as a floor and adds the rest back.

### Required test types — the tier's answer, made visible and editable

`DEPTH_TEST_TYPES` decided which kinds a project got, but only inside a prompt
string: a team could read "Standard" on the settings page and had no way to see —
let alone change — what it meant. `requiredTestTypes` on `ProjectQaSettings` is
that answer as data, with `@repo/utils/qa-test-types` owning the six kinds, the
per-tier defaults and the resolution rule.

**Empty means "follow the tier", not "require nothing".** That is why the column
defaults to `[]` and why the migration backfills nothing: writing every existing
project's tier set into the column would freeze them at today's meaning of their
tier, so a later change to what Standard requires would silently skip every
project that predates the column.

`describeQaPolicy` renders an explicit list **instead of** the tier sentence, not
beside it — two sentences about which types to write is how a prompt comes to
contradict the settings page that produced it. A project that has not touched the
control takes the tier branch and gets a byte-identical prompt to the one it got
before the setting existed, which `describeQaPolicy` is tested for directly.

`performance` is in no tier's default. It stays selectable, matching the standing
guidance that a performance case is written where a criterion names one.

The stored enum remains `EASY | AVERAGE | HARD` while the page reads Light /
Standard / Enterprise. The tiers were always these three; only the words on screen
were the engineering ones, and renaming the column would rewrite every project's
row to say what it already says.

### Depth vs. sceptic roles — the tier is a baseline, not a ceiling

`scepticRoles` is an independent control that **defaults to all five on**. A flat
per-tier exclusion therefore contradicted the lens clause on a *default* project
set to Light: "do not write security cases" followed four sentences later by
"apply a security lens".

The resolution is ordering plus wording, not coupling:

- The tier sentence says the model must not reach for those types **on its own
  initiative** — a statement about default behaviour, not a prohibition.
- The exception rides **with the lens clause**, which `parts` appends last:
  "these lenses are deliberate exceptions to the scope above".
- With no lenses enabled the clause is absent entirely, so the tier sentence is
  never left referring to lenses that are not there. `describeQaPolicy` is
  tested for exactly this — an unqualified tier sentence must contain no
  occurrence of "lens".

**Depth caps the roles** (product ruling, 2026-07-31). `resolveScepticRoles`
drops a role whose dimension the project's effective test types exclude, so
setting Light does what the tier says rather than being overruled by three
roles that default to on.

Read *effective*, not *the tier's default*: ticking `security` under Depth &
scope keeps the Security Reviewer at any depth, because an explicit choice
outranks the fallback. `scepticRolesSuppressedByDepth` exists so the settings
page can name a role its depth is currently silencing — a chip shown as on while
it produces nothing is the failure this replaced.

### An off-tier case is proposed, not dropped and not counted

The tier is now checked against the outcome, not only stated in the prompt.
`OFF_TIER_COVERAGE_TYPES` mirrors `DEPTH_TEST_TYPES` as data: on `EASY`, a case
the model classified `INTEGRATION` or `E2E` is created **`PROPOSED`** rather than
`DRAFT`.

That reuses machinery rather than adding any. `PROPOSED` already means "an AI
suggested this, a human decides", and is already excluded from coverage totals
(`NON_COVERAGE_STATES`), so the tier gets teeth with no new state, no new UI and
nothing discarded.

The two alternatives are both worse, and were both rejected:

- **Dropping the case** discards work a customer's credits already paid for, on
  the strength of the model's own self-classification.
- **Leaving it `DRAFT`** lets an end-to-end case join a Light project's suite and
  count towards its coverage, which is exactly what the tier exists to prevent.

Two deliberate exemptions:

- A case attributed to a **sceptic lens** is never off-tier. Enabling that lens is
  the documented exception to the tier; judging it a violation would contradict
  the instruction the model was given.
- An **unclassified** case (`coverageType: null`) is never off-tier. The check
  fails safe — an absent answer is not evidence of a violation, and treating it as
  one would demote ordinary cases whenever a model declined to classify them.

`AVERAGE` and `HARD` exclude nothing at this level: both cover the whole pyramid,
and what separates them is the security / accessibility dimension, which is not a
`coverageType` at all.

### The dimension axis

`coverageType` answers "how far up the stack", not "what is it looking for". So a
second axis, `OFF_TIER_DIMENSIONS`, checks the case's quality dimension
(`FUNCTIONAL | SECURITY | ACCESSIBILITY | PERFORMANCE`). `EASY` and `AVERAGE`
both defer security, accessibility and performance to an explicit request;
`HARD` asks for all of them.

The two axes are evaluated independently and each fails safe on its own: a model
that classifies the level but declines the dimension is still checked on the
level, and an absent answer never demotes. A lens-authored case outranks both.

The dimension is **not persisted**. It exists so the tier can be checked against
the outcome. `coverageType` earns a column because the coverage matrix renders
it; nothing renders the dimension, and a column with no reader is a schema change
for nothing.

### What is still instruction rather than enforcement

Worth being precise about, because the QA depth settings requirement 2 is worded as an absolute ("Then
it produces only functional/acceptance test cases"):

Nothing **rejects** a case. An off-tier one is demoted to `PROPOSED`, which keeps
it out of coverage but still creates it. So the guarantee is "an off-tier case
cannot silently become coverage", not "the system cannot emit one".

One thing remains instruction-only, and it cannot be checked from the output as it
stands. (The security / accessibility dimension used to be listed here too; it is
now checked — see the dimension axis above.)

- **Thoroughness.** `DEPTH_GUIDANCE` asks for more or fewer negative paths and
  edge cases per criterion. There is no output field that says how thoroughly a
  case was explored, and inventing one to grade the model against itself would
  cost a field and buy very little.

Both match how the rest of the policy works — evidence policy and sceptic lenses
are instructions too — so this is consistent rather than an oversight.

`STRATEGY_DEPTH_INFO` in
`apps/web/modules/saas/projects/components/qa-settings/qa-settings-constants.ts`
is the reader-facing rendering of these same two records. Change them together —
a bullet that promises something the prompt does not say is the defect this
pairing was introduced to remove.

Because that prompt is a bound DB copy rather than inline text, changing the
template alone reaches fresh installs only. The accompanying migration
(`20260726030000_sync_test_case_drafter_prompt_qa_policy`) is what makes the
policy take effect on an already-seeded environment.

`indexCoverageEnabled` and `coverageTarget` set the target the coverage rings on
the QA tab are measured against. With index coverage off, the rings
render without a target.

### Pipeline sources

Below the policy form, each connected code repository can carry a **QA branch
override** — the branch CI results are pulled from, defaulting to the repository
default. Deliberately separate from `defaultBranch` so QA and code indexing can
watch different branches. See [pipeline results](./pipeline-results.md#branch-selection).

### Inbound result webhook

The same page can create one signed webhook endpoint for near-real-time pipeline
results. The secret is generated by Fabric, shown exactly once, encrypted at
rest and never readable again. The card shows the endpoint, secret hint, expiry,
last delivery and last error, plus provider-specific header instructions.

Rotation always asks for an overlap window. The previous secret remains valid
for 5–1440 minutes (60 by default) so provider retries already in flight are not
cut off. Expiry can be moved or cleared; revoke disables the endpoint. Create,
rotate, expiry update and revoke each emit a project audit event with safe
metadata only.

The endpoint verifies raw-body HMAC signatures, a five-minute timestamp window,
delivery-id and body-digest deduplication, and a public-route rate limit before
ingestion. Invalid authentication and unknown endpoints have the same silent
response. Webhooks publish run metadata immediately; polling fetches detailed
test results and stays enabled as the reconciliation fallback. Full wire details are in
[Pipeline results](./pipeline-results.md#webhook-delivery-plus-polling-fallback).

## Settings ▸ Environments

`ProjectEnvironment` rows: a type (`STAGING` / `QA` / `PRODUCTION`), a name and a
base URL. Create, edit and delete are all supported from the UI.

Deleting a target runs in a transaction that also clears `defaultEnvironmentId`
on any QA policy pointing at it, so no dangling reference survives. The delete is
confirmed first, and the confirmation names that side effect.

### Editing a target

Each row can be edited in place: type, name and base URL. This exists because a
target's **id is its identity** — the QA policy and the run config reference
environments by id — so the previous workaround for a typo in a base URL was to
delete the target and add it back, which mints a new id and silently breaks those
references. A destructive round trip was the only way to do a non-destructive
thing.

Only one row holds a draft at a time, so an unsaved edit cannot follow the reader
to another row, and a refetch cannot clobber typing. Cancel discards without
touching the server. Editing requires `PROJECT_SETTINGS_EDIT`, the same gate as
create and delete.

Sign-in credentials are edited from the same row — see below.

### Sign-in credentials

Each environment can carry the credential a Fabric-driven run needs to sign in.
It is entered from the environment row (`EnvironmentCredentialForm`), stored by
`setEnvironmentCredential`, and read by exactly one caller — the runner, through
`resolveEnvironmentAuth`. Nothing else decrypts it.

The form shipped with the runner that consumes it, deliberately: collecting a
customer's production password while nothing used it would have taken the whole
trust liability for none of the benefit.

The model is that an environment carries the credentials a Fabric-driven run needs
to get past a login screen: a form sign-in (username + password), a
bearer token, or a custom header. `authKind: NONE` — the default, and every
existing row — stores no secret at all.

The secret is encrypted at rest with the same AES-256-GCM helper the connected
repositories use (`encryptApiKey`, keyed by `ENCRYPTION_KEYS`), so there is one
implementation to audit rather than two.

**Storing credentials for a `PRODUCTION` environment is permitted.** That is a
product decision taken 2026-07-26 — it is the customer's call — and it is worth
being blunt about what it means: Fabric then holds credentials that sign in to a
customer's live system, which is a materially larger trust ask than a repo read
token. `resolveEnvironmentAuth` returns an `isProduction` flag so a caller
deciding whether to warn or refuse never has to re-query to discover where it is
pointing.

The module is built around one rule: **a secret goes in, and only a redacted
description comes back out.**

| Read path | Returns |
|---|---|
| `listEnvironmentAuthSummaries` (what the UI renders) | The kind, the username, the header name, *whether* a secret exists, and when it was last written. Never the value; never decrypts. |
| `resolveEnvironmentAuth` (the runner only) | The plaintext. The **only** path that decrypts. Its result must never be logged, returned over the wire, or stored on a run record. |

Three behaviours that are easy to get wrong and fail quietly:

- Switching `authKind` to `NONE` **wipes** the secret. "Needs no sign-in" and
  "still has my password lying about" must not be the same state.
- Omitting the secret on a write **keeps** the stored one, so editing a username
  does not silently clear the password. An empty string or an explicit `null`
  clears it.
- A secret that will not decrypt — rotated key, corrupt row — reads as
  **absent** rather than throwing, so the caller hits its existing "no usable
  credential" path instead of crashing a run. It is logged as
  `qa.environment.credential_undecryptable` (the fact, never the value),
  because otherwise a customer's production credential can stop working with
  nobody seeing it until a support ticket arrives.

> **Auditing is the caller's job.** The queries have no actor and record
> nothing. The procedure that writes or uses a credential must audit it — this
> is stated as an obligation because an earlier draft of the code comments
> claimed it already happened, which was untrue.

`ENVIRONMENT_PUBLIC_FIELDS` in `environment-credentials.ts` is the hand-written
list of columns safe to serialise. Use it — **not** the generated whole-model
`ProjectEnvironmentSchema`, which mirrors every column and therefore now
includes `encryptedAuthSecret`.

`defaultEnvironmentId` is **deliberately not a foreign key**: environments are
edited independently, and a deleted target must degrade to "no default" rather
than cascade-delete a project's whole QA policy.

## Authorisation

Reads require `PROJECT_SETTINGS_READ`, writes `PROJECT_SETTINGS_EDIT`, through
`tenantProtectedProcedure` + `requireProjectPermission`. Tenancy columns on both
models are copied from the parent project and never taken from caller input.

## Source locations

| Area | Path |
|---|---|
| UI | `apps/web/modules/saas/projects/components/qa-settings/` |
| Copy and option sets | `.../qa-settings/qa-settings-constants.ts` |
| Procedures | `packages/api/modules/projects/procedures/qa-settings/` |
| Queries and defaults | `packages/database/prisma/queries/projects/qa-settings.ts` |
| Webhook route | `apps/web/app/api/webhooks/qa/[projectId]/route.ts` |
| Webhook storage | `packages/database/prisma/queries/projects/qa-webhooks.ts` |
| Policy → prompt | `packages/ai/lib/prompts/test-case-drafting.ts` (`describeQaPolicy`) |

All copy on both pages is inline English in the components; there are no i18n keys
for this surface.

---

## Requirement trace: QA depth settings

Checked against the card's text, not a summary of it — the method that found two
misses on the pull-request review work and two here.

| Requirement | State |
|---|---|
| requirement 1 — set the testing depth tier | **Met** — Strategy & depth (EASY / AVERAGE / HARD) |
| requirement 1 — set required test types | **Met by different means** — see below |
| requirement 1 — set target environments | **Met** — Settings ▸ Environments, plus `defaultEnvironmentId` |
| requirement 1 — set sign-off requirements | **Met** — Settings ▸ Testing ▸ Sign-off writes `requiredQaSignOffs`; 0 disables, capped at 10. It was recorded as met while the field existed only in the schema and the API input, with no control anywhere in the app — so the gate was enforced and unreachable at the same time |
| requirement 2 — light ⇒ functional/acceptance only, no integration/E2E/security | **Met** — EASY narrows the prompt AND an off-tier case arrives Proposed rather than counted |
| requirement 3 — enterprise ⇒ functional + integration + E2E + security + accessibility | **Met** — HARD |
| requirement 4 — 2 sign-offs required ⇒ enforced before the feature progresses | **Met** — the transition gate in `update-story.ts`, tested |
| requirement 5 — a saved change applies to the next run, no restart | **Met** — settings are read per run, never cached |
| Scope — configurable document-refresh frequency (per-deploy, daily, weekly) | **Met** — ON_DEPLOY + DAILY/WEEKLY/BI-WEEKLY/MONTHLY |
| Scope — browser/device requirements | **Met** — resolutions, browsers |
| Scope — credential and access rules | **Met** — per-environment sign-in credentials |
| Success — 3 tiers | **Met, different names** — see below |

### "Required test types" is satisfied by two controls, not one list

The card imagines a single list where you tick functional / integration / E2E /
security / performance / accessibility. Fabric splits that across the two controls
that actually drive drafting:

- the **depth tier** governs the test-pyramid levels — functional, integration,
  end-to-end;
- **Required test types** (the sceptic roles) governs the quality dimensions —
  security, performance, accessibility, UX.

They are separate because they behave differently: depth is a scope ceiling a case
can exceed only as a *Proposed* case, whereas enabling a role is a deliberate
request that overrides the tier at any depth. One combined list would have to
pretend those two behaviours are the same, and a reader ticking "security" on an
Light project would not be able to tell which one they had just asked for.

The section is now **labelled "Required test types"** so a reader holding the card
finds the thing it names. This is a deliberate deviation from the card's shape,
recorded rather than silently resolved.

### Tier names

The card says light / standard / enterprise. The product has:

| Card | Product | Drives |
|---|---|---|
| light / standard / enterprise | EASY / AVERAGE / HARD (`strategyDepth`) | Test-case drafting, and the PR review lens |
| — | LIGHT / STANDARD / STRICT (`qaStrategyLevel`) | QA Strategy documents, per-feature QA analysis |

Three tiers exist in both, and nothing is called "enterprise". Left as-is:
renaming a stored enum to match a card's prose costs a migration and two
vocabularies to keep in step, and the mapping above is cheaper and does not rot.

## Requirement trace: test-run management

The card is one sentence — five steps — so the trace is one row each.

| Step | State |
|---|---|
| Select a test scope in the portal | **Met** — case selection on the Cases segment is reused by the run panel (`selectedCaseIds`); CI scope via the triggerable-pipeline picker |
| Create a test run job | **Met** — `agenticRuns.dispatch` for a Fabric-driven run, `pipelineResults.trigger` to start the customer's own CI |
| Wait for completion | **Met** — the `qa-agentic-run` Temporal workflow, with in-flight statuses polled in the panel |
| Analyse results | **Met** — `pipelineResults.analyseFinding` produces a suspected cause and kind, with the changed files it reasoned over recorded as evidence |
| Display the outcome in the Fabric UI | **Met** — the Runs segment: both run sources in one history with per-source marks, plus the run-detail sheet |

## Requirement trace: repository access and CI/CD

| Requirement | State |
|---|---|
| Create **or** connect the client's test repository | **Met via connect** — repository integrations (GitHub / GitLab / Azure DevOps). Fabric does not *create* a repository; the card offers either |
| Configure a CI/CD pipeline to run tests and send reports back | **Met** — `pipelineResults.ciConfigTemplate` emits a committable workflow, plus an inbound webhook and scheduled sync |
| Root-cause analysis on failures | **Met** — the same `analyseFinding` path: advisory only, button-triggered, and it never files a bug on its own |

## Requirement trace: test-case generation and TDD flow

| Requirement | State |
|---|---|
| requirement 1 — QA Settings shows both toggles with the stated defaults | **Met** — Generate manual test cases ON, Apply TDD approach OFF |
| requirement 2 — generation OFF ⇒ no cases and no credits spent | **Met** — suppressed before a drafting job is claimed, not after |
| requirement 3 — TDD OFF ⇒ without-TDD flow | **Met** — cases drafted after the feature review |
| requirement 3 step 2 — TDD ON ⇒ Test Cases Generated first | **Met** |
| requirement 3 step 3 — Requirements reviewed/updated from the drafted flows | **Partial — reviewed, not updated.** Folded into step 5's single pass; a warning the drafted cases exposed is marked, but no requirement text is rewritten. See below |
| requirement 3 step 5 — Feature review from Requirements AND Test Cases | **Met** — `tddTestCasesClause`, loaded only under TDD |
| requirement 3 step 6 — Test case updates from the implemented flows | **Met** — `reviseTestCaseSteps` |

### Steps 3 and 5 are one analysis pass, not two

The card lists them separately: step 3 reviews the **requirements** against the
drafted case flows; step 5 reviews the **feature** against requirements and cases.
Fabric runs one QA-analysis pass that, under TDD, reads both — because both
questions need the same two inputs, and a second pass would spend a second set of
credits re-reading them.

The cost of merging them is that the two outputs blend, and step 3's contribution
is the one that gets lost. A warning the drafted flows **exposed** is worth more
than one the spec earned on its own, because that feedback edge is the entire
reason for drafting cases before implementation. So the clause asks the model to
prefix such a warning with `Drafting revealed:` and name the case that exposed it —
and to attribute it that way *only* when the case is genuinely the evidence, since
a prefix on every warning carries no information.

Recorded as a deviation from the card's shape rather than resolved silently. If a
distinct step-3 artifact is ever wanted — an updated requirements *document* rather
than a warning on the analysis — that is a separate change, and this note is where
to start.

## Requirement trace: pipeline results

Nine functional requirements, all met. The schema cites the card directly in two
places, which is how the last two were confirmed rather than assumed.

| Requirement | State |
|---|---|
| FR1 — fetch test/pipeline results from connected PM tools (ADO) | **Met** |
| FR2 — fetch CI results from connected repositories (GitHub, GitLab) | **Met** |
| FR3 — each entry shows name, status, branch, timestamp | **Met** |
| FR4 — results associated with the feature or test case where linkage exists | **Met** — the linkage cascade, with unmatched tests kept in their own list rather than dropped |
| FR5 — no results ⇒ a distinct empty state, not an error | **Met** |
| FR6 — a PM tool that cannot return runs ⇒ an unsupported indicator | **Met** — the sentence is composed server-side, because the distinction depends on server configuration and a second copy in the browser is a second thing to keep true |
| FR7 — connection unavailable ⇒ stale-data indicator with the last successful fetch | **Met** — `lastFetchedAt`, commented in the schema as "last SUCCESSFUL fetch — drives the stale badge" |
| FR8 — flag-gated per environment | **Met** — rides the QA feature gate; an environment without it fails closed |
| FR9 — incremental fetch, no full re-fetch per load | **Met** — a per-(project, provider, pipeline) cursor carrying a `lastRunExternalId` high-watermark that advances only on success, plus a resumable `pageToken` |

Out-of-scope items in the card that are correctly absent: no load/DAST/security
result ingestion, no test-case authoring through this path, and the bi-directional
case sync is extended rather than replaced.

**Not verified by me:** the non-functional target "QA tab load with cached results
under 2 seconds". No measurement was taken, so it is unproven rather than met.


## Rulings worth recording

**Devices and browsers are DEFAULTS, not a matrix.** The settings store a list,
and a run uses the first entry unless the run configuration overrides it. The
controls are labelled "Default browser" and "Default resolution" so they describe
what they do. Running every configured combination is a different product — it
multiplies run cost and time, and needs per-combination results and a new cost
conversation. Decided 2026-07-31.

**"Generate manual test cases" gates DRAFTING only.** With it off, Fabric will
not draft new cases and will not spend a credit discovering that. It does NOT
block proposing revised steps for a case somebody wrote by hand, or generating a
Playwright script for one: a team that writes its own cases may still want help
revising and automating them, and blocking that would remove AI assistance from
exactly the teams who opted out of AI authorship. Decided 2026-07-31.

**The coverage target BLOCKS Done, and the block takes a reason.** Superseded the
2026-07-31 ruling that it was advisory, on 2026-08-01.

That ruling framed the choice as gate-or-don't-gate, and both answers were wrong.
Left advisory, `coverageTarget` was a number nothing read: a project could ask for
80% and close every feature at 10% with nothing anywhere noticing, which makes a
control that reads as a guarantee. Made an absolute gate, it would strand low-risk
work for a reason far less clear-cut than a missing sign-off.

So it refuses the move to Done below target **unless a reason is recorded**, and
the reason is stored on the feature with who gave it and when
(`coverageOverrideReason` / `…ById` / `…At`). A team that ships under target
repeatedly can see that it did and why — which neither a silent number nor an
immovable wall would have given them.

Three behaviours worth knowing:

- A target of `0` — the value for a project that never configured one — short
  circuits before coverage is even computed.
- A feature with **no acceptance criteria** reports 100%. A spike or chore
  legitimately states none, and reporting 0% would block it behind a target it
  can never reach.
- The gate is on the **transition** into Done, like the sign-off gate. Raising a
  project's target does not freeze every feature already shipped.

Coverage counts **criteria covered, not cases written** — ten cases all naming
criterion 1 is not ten coverage. It is computed on the server, because a figure
the client supplies is one the client can be wrong about once something refuses
an action based on it. `requiredQaSignOffs` remains the stricter gate and is
checked first.

**Drift detection is FLOW-INDEPENDENT.** The drifted-cases section renders whether
or not test-first ordering is on, though the originating scope placed that step
inside the test-first flow only. A case that no longer matches its specification is
worth knowing about however a team sequences its work, and gating the section on
the test-first switch would hide real drift from every project that never turned it
on. Decided 2026-07-31.

**The confidence threshold withholds a verdict; it does not file anything.** See
the section above for what it does and the four reading decisions behind it. Worth
separating from the auto-accept design that was rejected: an agentic failure still
only ever creates a finding for a person to promote. Decided 2026-07-31.

### Step 3, and why "Updated" is a person's edit

The card's with-TDD flow reads *"Requirements Reviewed / Updated — based on
generated test-case flows"*. Fabric does the reviewing: under test-first, the
drafted cases are fed into the analysis and anything they exposed is flagged and
chipped as `Drafting revealed`. The updating is left to a person, and the panel
now says so in a line under those warnings rather than leaving the handover
implied.

That is a decision, not a limitation we could not get past. A tool that rewrites
acceptance criteria from its own warning is grading its own work: the next
analysis reads the criteria it just wrote, finds them covered, and reports
success it manufactured. The same reasoning already governs test-case drift,
where the code says an AI may propose a change to the suite and never make one.

**If we want more, the shape is clear and this is the note saying so:** Fabric
could draft the criteria edit and present it for confirmation, the way the drift
flow proposes steps and waits for Accept or Reject. The place it would offer that
is the same line, and nothing about the current behaviour blocks it. Say the word
and it becomes a proposal-with-confirmation instead of a sentence.
