# Pipeline results

How Fabric starts a run in a connected repository's CI, pulls the automated test results back, links them to test cases, and opens bugs for failures.

- **Audience**: engineers working on QA ingestion; support engineers diagnosing a sync that returns nothing
- **Owner**: Fabric platform team

Fabric can **start** a run in a pipeline the customer already has, and **reads**
the results that pipeline publishes — see [Starting a run](#starting-a-run). On
this path Fabric never writes CI configuration, creates repositories, or pushes to
a customer's repository.

Running a case *without* a pipeline — Fabric driving a browser through the case's
own steps — is a separate mechanism, covered in
[Fabric-driven runs](./agentic-runs.md).

---

## Where results come from

Results are pulled from a **connected code repository** (`ProjectRepositoryIntegration`,
Settings ▸ Development), not from the PM-tool connection. A project whose Azure
DevOps is connected only as a PM tool (MCP) has no source for pipeline results.

**This is a decision, not an omission** (taken 2026-07-27). The original
requirement was worded as though the PM connection were the result source. It is
not, and Fabric will not build a PM test-management fetcher: the requirement is
rescoped to "results come from the code repository". Azure DevOps results *do*
arrive —
through the ADO **code-repository** integration with a Test-Management-Read PAT,
which is a different integration from the ADO **PM** connection even though a
customer reasonably reads them as one thing.

What the product owes instead is to say so. A project with no connected
repository whose PM tool *is* connected gets a named explanation in Settings ▸
Testing rather than a bare empty list — "Azure DevOps is connected as a
project-management tool, which cannot return test runs" — because an empty state
that cannot distinguish "nothing connected" from "the thing you connected cannot
do this" sends someone to check a connection that is working perfectly well at
its own job. Composed in `lib/qa-result-source.ts` and returned by the sources
endpoint, so the browser holds no second copy of the distinction.

| Provider | What Fabric reads | Requirement on the customer's pipeline |
|---|---|---|
| GitHub Actions | Workflow runs, then a JUnit XML **artifact** | GitHub has no per-test API. The artifact is found **by name**, matching `/junit\|test\|report\|result/i`. An artifact named `coverage` is invisible whatever it contains. Token needs `Actions: read`. |
| GitLab CI | Pipelines, then the native `/test_report` JSON | JUnit must be declared under `artifacts:reports:junit`. `artifacts:paths` stores the file and produces no report. |
| Azure DevOps | Test Runs, then per-run results | Requires a `PublishTestResults` task. PAT needs **Test Management: Read** — a Code-only PAT lists no Test Runs, and this is the commonest cause of an empty ADO sync. |

A run with no readable per-test detail still ingests as a **run-level record**
(counts only, `results: []`), so its pass/fail is preserved.

`providers/jira-xray.ts` contains a tested mapper with no fetcher and no caller.
It is intentionally unwired, pending a PM decision on which Jira test plugin (if
any) to support. It is not dead code to delete.

## Starting a run

`Run tests` (beside `Sync now` in the runs panel) queues a run in the pipeline
the customer already has. Fabric queues it and stops there: the run executes on
the customer's infrastructure and its results arrive through the ordinary sync
below, so nothing downstream of ingestion is different for a triggered run.

| Provider | What Fabric calls | Credential it needs | Config change needed? |
|---|---|---|---|
| GitLab CI | `POST /projects/:id/pipeline` for a ref | **`api`** — note `read_api`, which is enough for ingestion, can read pipelines but **cannot create one** | No |
| Azure DevOps | Queues a build for a chosen definition via the Build API | **Build (read and execute)** | No |
| GitHub Actions | `POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches` | Write access to Actions — spelled **`actions:write`** (fine-grained token), **`workflow`** (classic token) or **Actions: Read and write** (GitHub App) | **Yes** — the workflow must already declare `workflow_dispatch:` |

The two providers differ in what has to be chosen. GitHub and Azure DevOps run a
**definition** (a workflow, a build pipeline), so one is picked and its id is
required; GitLab runs a **ref**, reading whatever `.gitlab-ci.yml` exists there,
so there is nothing to pick. That split is a discriminated union in
`ci-trigger-dispatch.ts`, not an optional field — a GitHub trigger cannot be
reached without a workflow id.

### When a trigger is refused

Fabric holds read-scoped CI credentials today, and GitHub additionally requires a
change to the customer's own workflow file. Rather than fail generically, each
refusal names its own remedy and is returned as **data** so the UI can render it
persistently — a toast is the wrong surface for an instruction someone has to go
and act on.

| Failure | Means | Remedy shown to the user |
|---|---|---|
| `NOT_DISPATCHABLE` | GitHub 422 mentioning `workflow_dispatch` | Add `workflow_dispatch:` under `on:` in the workflow — Fabric will not do it for them |
| `INSUFFICIENT_SCOPE` | The credential reads CI but cannot start it | Reconnect the repository with the scope named in the table above |
| `NOT_FOUND` | Unknown workflow / definition / ref, or invisible to the token | Check it exists and the token can see it |
| `RATE_LIMITED` | Provider throttling | Retry shortly |
| `PROVIDER_ERROR` | Anything else | The provider's own message, quoted |

Two provider quirks are handled deliberately and are easy to reintroduce:

- **Azure DevOps answers a rejected PAT with `203`** — inside the 2xx range —
  and an HTML sign-in body. A plain `2xx` check therefore lets the login page
  reach `res.json()` and reports `Unexpected token '<'` instead of "check your
  PAT". Both the trigger and the definition-listing path guard for it explicitly.
- **GitHub reuses `403` for throttling as well as for a missing scope.** Rate
  limits are separated by the `x-ratelimit-remaining` header, so a throttle does
  not tell the user to reissue a credential that was never the problem.

### Per-provider setup

Everything a customer has to do on their own side — which credential at which
scope, what their pipeline must declare, how a wrong scope presents, and how to
verify it worked — lives in [`ci-providers/`](./ci-providers/README.md), one page
each for [GitHub Actions](./ci-providers/github-actions.md),
[GitLab CI](./ci-providers/gitlab-ci.md) and
[Azure DevOps](./ci-providers/azure-devops.md). Adding a provider means adding a
page there; the index says what it has to answer.

One trap from those pages is worth repeating here, because it presents as a
Fabric bug and every surface someone would check reports success while it stays
broken: **for a GitHub App, granting a permission does not grant it.** Adding a
permission raises a request an owner must approve *per installation*, and until
they do the installation's tokens keep their old scopes while the App's settings
page shows the permission as granted. Reconnecting the repository does not help,
since reconnection mints a token from the same installation. Read access and
write access are also separate approvals, so a team enabling both goes through
the flow twice unless they grant write up front.

### Scoping a triggered run

The API accepts `inputs` — forwarded as `workflow_dispatch.inputs` (GitHub),
pipeline variables (GitLab) or build parameters (ADO). These are **best-effort
only**: they narrow a run solely where the customer's own pipeline declares
matching inputs *and* its test command consumes them.

**`inputs` is API-only, deliberately — decided 2026-07-26.** The trigger dialog
offers pipeline and ref, and will not grow a key/value editor. A box that accepts
arbitrary keys would look like per-feature scoping while doing nothing at all on
any pipeline that does not already declare matching inputs — which is most of
them. Someone would type `feature=F-123`, watch the whole suite run, and
reasonably conclude the feature is broken. A control that silently no-ops is worse
than no control.

Real per-feature scoping needs Fabric to know which tests belong to a feature
*and* to be able to tell the runner — the linkage cascade gives the first half,
the second is the customer's pipeline to write. So whole-suite is the shipped
product behaviour, not a placeholder. The parameter stays for API consumers whose
pipelines *do* declare inputs.

### Access and audit

`Run tests` requires `TEST_CASE_UPDATE`. Note this is **below** the
`PROJECT_SETTINGS_EDIT` bar that connecting or reconfiguring the same repository
integration requires: the line drawn is *configure vs. use*, so a project EDITOR
can start a run through a credential only an admin could have connected. That is
deliberate — QA engineers and developers are EDITORs, and admin-gating "Run
tests" would put the feature out of reach of the people it exists for.

The compensating control is the audit trail. Because the action spends a stored
customer credential on the customer's own infrastructure, every attempt is
recorded as `project.ci_run.triggered` — including the ones **refused before any
provider was contacted**:

| Outcome | `metadata.failure` |
|---|---|
| Run queued | *(absent; `runId` recorded)* |
| Provider refused | the `CiTriggerFailure` code above |
| Integration not connected to this project | `NOT_CONNECTED` |
| Provider unsupported / URL unusable | `UNSUPPORTED` |
| No usable credential | `NO_CREDENTIAL` |

`NOT_CONNECTED` is the reason the pre-provider paths are audited at all: it is
what someone probing another project's integration id lands on, and a bare 404
would otherwise leave no trace that they asked.

The row records the provider, ref, pipeline id and the *keys* of any forwarded
inputs — never their values. A caller mistake that spends nothing ("choose a
pipeline") is deliberately **not** audited; it is form validation, not an
attempt.

## How a sync runs

Results arrive two ways, and both end up in the same workflow.

`Sync now` (in the runs panel) starts `syncPipelineResultsWorkflow` with the
workflow id `pipeline-results-sync-{projectId}` and `USE_EXISTING`, so concurrent
clicks collapse onto one run.

Per source, the activity resolves credentials, fetches, ingests, runs RCA, and
only then advances the cursor. One failing source records its failure and the
loop continues; it does not sink the others.

### The scheduled sweep

**Per-project control (Settings ▸ Testing → "Automatic result sync").** A project
can turn automatic checking off, and can raise the minimum gap between checks to
15, 30, 60 or 240 minutes.

The sweep itself stays a SINGLE deployment-wide schedule. A Temporal schedule per
project would have to be reconciled as projects are created, archived and
deleted — the same problem `url-source-schedule-reconcile` exists to manage — so
instead the sweep keeps ticking and the *enumerator* honours each project's
setting. That makes the interval a **floor**, not a cadence: "every 60 minutes"
means "no more often than hourly", and after an outage the next tick catches
everyone up rather than every project needing its schedule rebuilt.

Two consequences worth knowing:

- **A project with no QA settings row still syncs.** The enumerator excludes only
  projects explicitly disabled, because a project that has never opened the
  settings page has no row at all and the shipped behaviour for those is to sync.
- **"Sync now" counts.** The floor is measured from the last *successful fetch*
  whoever caused it, so pressing Sync now and then having the sweep fetch again
  a minute later cannot double the load on the provider.

Turning it off does **not** remove the manual path. The on-screen copy says what
off costs — results appear only when someone presses Sync now, and until then the
tab shows the last results Fabric saw, which may be old. That empty-vs-stale
confusion is exactly what the sweep was built to fix, so a toggle re-introduces
it on request and had better say so.

A Temporal schedule, `qa-pipeline-results-sync`, runs **every 15 minutes** and
starts a sweep (`syncAllPipelineResultsWorkflow`) so results arrive without
anyone pressing a button. Before it existed, a team that never clicked `Sync now`
had an **empty** QA tab rather than a stale one — which reads as "no tests" rather
than "not fetched".

The sweep starts the **same** per-project workflow the button starts, under the
**same** workflow id. That is the load-bearing detail: a tick that collides with
someone pressing `Sync now` collapses onto the existing run instead of racing it
into duplicate provider calls. The collision surfaces as
`WorkflowExecutionAlreadyStartedError`, which the sweep counts as `alreadyRunning`
— a healthy outcome, not a failure.

Which projects it visits:

| Included | Excluded |
|---|---|
| `ACTIVE` and `COMPLETED` projects with at least one repository integration that is **not** `DISCONNECTED` | `DRAFT` (not started) and `ARCHIVED` (finished) |

`COMPLETED` is deliberately included: a finished project's CI can still report a
late run, and that result still belongs in its history.

The enumeration is **capped** at 200 projects per tick (hard maximum 500) and
ordered oldest-updated-first, so an estate larger than one tick can cover rotates
through it rather than starving the same tail forever. The sweep's children are
`ABANDON`ed rather than awaited — a slow provider must not hold the sweep open,
and each child reports its own outcome through the sync state the UI already
reads.

Schedule policies worth knowing: `overlap: SKIP` (children can outlive the parent,
so overlapping sweeps would multiply provider calls) and a 15-minute catchup
window (a worker down for hours resumes syncing *now* rather than replaying every
missed tick against provider rate limits).

Both halves are per-project, from Settings ▸ Testing: an on/off switch and an
interval, described under [How a sync runs](#how-a-sync-runs) above. A customer
can additionally configure the signed inbound webhook described below.

### Webhook delivery plus polling fallback

Each project can mint one QA webhook endpoint in Settings ▸ Testing. Fabric shows
the 32-byte secret once; only its encrypted value and last four characters are
stored. GitHub uses its native `X-Hub-Signature-256` HMAC over the raw body.
GitLab, Azure DevOps and other generic senders use:

- `X-Fabric-QA-Provider`
- `X-Fabric-QA-Delivery`
- `X-Fabric-QA-Timestamp`
- `X-Fabric-QA-Signature`, an HMAC over
  `<provider>.<delivery id>.<timestamp>.<raw body>`

The public route is deliberately fail-closed: the raw body is streamed with a
1 MiB ceiling, signatures are timing-safe, timestamps have a five-minute replay
window, and both `(webhook, provider, delivery id)` and
`(webhook, provider, body digest)` are unique. The body digest matters for GitHub,
whose delivery id is not part of its native signed payload: replaying the same
body under a new id is still a duplicate. Invalid signatures, missing auth
headers, unknown projects, and revoked projects all return the same silent
success, so the endpoint is not a project oracle. Only an authenticated request
gets an explicit expired or malformed response.

Requests are limited to 60 per minute per project and trusted client IP (or a
stable header fingerprint when no trusted proxy header is configured). The
limiter fails closed in production when its shared store is unavailable.

Secret rotation accepts an overlap window (5–1440 minutes, default 60). During
that window both current and previous secrets verify; after it, only the current
one does. This prevents an in-flight provider delivery from breaking the instant
a customer rotates. The UI exposes last delivery, last error, expiry, rotation
and revocation, and every secret lifecycle mutation is audited without recording
the secret.

A verified, non-duplicate delivery invokes the same ingestion path as polling.
Native webhook payloads provide run metadata and status immediately; they do not
carry the provider's full test-report artifact, so detailed test counts and
per-case results arrive on the next provider sweep.

**The endpoint has to reapply the branch filter itself, and this is easy to
lose.** The sweep asks the provider only for runs on the watched branch
(`qaBranch`, falling back to the repository default). A webhook cannot ask for
anything — the provider sends every run in the repository — so without an
explicit filter a repo with feature branches, preview deploys and dependabot
fills the pipeline list with runs the sweep deliberately excluded. Comparison is
on the short branch name, because Azure DevOps reports `refs/heads/main` where
GitHub and GitLab report `main`, and comparing raw strings drops every Azure
DevOps run while looking exactly like a provider sending nothing. A delivery for
an unwatched branch is answered **200**, not 4xx: it was valid and correctly
verified, and a non-2xx would have the provider retry and eventually disable the
hook for failing. The scheduled sweep remains
the universal fallback because providers retry imperfectly and customer webhook
configuration can drift. Webhooks improve run visibility latency; they do not
replace reconciliation. A sanitized last-ingestion error and timestamp are
stored on the webhook configuration for operators; raw provider bodies and
credentials are never stored there.

### Incremental fetch, and why the cursor lags deliberately

`TestPipelineSyncState` stores a cursor per `(projectId, provider, pipelineKey)`.
Fetchers ask only for runs above it.

Run ids are allocated when a run **starts**, but results exist only when it
**finishes**, so ids do not finish in order. `advanceCursor` therefore ingests
everything finished but holds the cursor **just below the oldest run still in
flight**. Runs above that barrier are re-listed next time and skipped cheaply by
ingest idempotency — re-reading a run is free; losing one is not.

The backlog is **paged back to the cursor** (`page` on GitHub/GitLab, `$skip` on
ADO), stopping at the cursor, at a short page, or at a 10-page safety bound.
Ordering cannot substitute for paging: asking GitLab for `sort=asc` returns the
project's *first* pipelines ever, which the client-side cursor filter then
discards, freezing the cursor. When the page bound trips, the sync logs
`qa.pipeline.sync.backlog_truncated` so a partial drain cannot read as a complete
one.

`pipelineKey` is the `owner/repo` for GitHub and GitLab, and the **ADO project**
for Azure DevOps — so two repos under one ADO project share a cursor.

### Branch selection

Each connected repo may carry a `qaBranch` override (Settings ▸ Testing ▸
Pipeline sources); otherwise the repository default is used. GitHub and GitLab
pass it to the provider. ADO's Test Runs list has no branch parameter, so the
filter is applied after the per-run detail fetch — the only response carrying
`buildConfiguration.branchName` — and `refs/heads/main` and `main` are treated as
the same branch. A run on another branch still advances the cursor: it is
settled, and not counting it would re-list it every sync.

## Linking a result to a case

`resolveAutomationLink` runs a three-tier cascade, first hit wins:

1. **tag** — an explicit `@TC-###` marker in the test name or classname, matched
   against `TestCase.identifier`. Compared **numerically**, so `@TC-7` matches
   `TC-007`. A tag naming no existing case is deliberately **not** downgraded to
   a title guess — the author asserted a specific case, so the result is
   unmatched rather than guessed.
2. **path** — the case has an `automationFilePath` **and** its `automationRef`
   matches the test name or classname. The precise 1:1 style.
3. **title** — `automationRef` or the case title matches the test's describe/it
   text, with no file qualifier. Weakest, and brittle to renaming.

The tier is recorded on the event and on the stored per-test record, so a
title-only match is visibly weaker than a tagged one. Unmatched results are
counted, and surfaced in the **untracked automated tests** list.

## What ingestion writes

`ingestPipelineRun` runs in one transaction:

- a `TestPipelineRun` row with counts, branch, commit, actor, duration and the
  full per-test breakdown (matched **and** unmatched) in `results`;
- one `PIPELINE` `TestResultEvent` per matched test, batched into a single insert;
- one denormalised update per distinct case.

Two rules govern the denormalisation:

- **Worst wins within a run.** If a case is covered by several tests in one run,
  the worst result lands on `currentResult` — a passing test must never mask a
  failing one.
- **Latest wins across runs.** The update is guarded on `lastRunAt`, so a stale
  re-ingest cannot clobber a newer manual or pipeline result.

**Idempotency and re-runs.** A stored run counts as already-ingested only when it
matches the incoming run on provider status, finish time and result tally.
Anything else is a **new attempt** — both GitHub ("Re-run all jobs") and GitLab
("Retry pipeline") reuse the run id, so keying on the id alone left a flaky test
FAILED forever after it was re-run green. A re-run replaces the run row in place
and re-derives each matched case; earlier attempts keep their history events,
because the test really did run twice.

## Statuses

`mapRawStatusToTestResult` maps raw provider tokens to Fabric's `TestResult`:

| Raw | Fabric |
|---|---|
| passed / pass / success / succeeded / ok | `PASSED` |
| failed / fail / failure / error / errored / broken | `FAILED` |
| notexecuted / notrun / pending / queued / none / empty | `NOT_RUN` |
| skipped / skip / ignored / notapplicable / disabled | `SKIPPED` |
| everything else, incl. aborted, cancelled, inconclusive, timedout | `BLOCKED` |

Anything ambiguous reads as "needs attention" rather than green: an unrecognised
token lands in `BLOCKED`, never `PASSED`.

The three "did not pass" outcomes are deliberately distinct, because they call
for different reactions:

- **`NOT_RUN`** — queued, pending, never reached.
- **`SKIPPED`** — the suite was told not to run it. Nothing is wrong.
- **`BLOCKED`** — attempted and could not proceed.

`SKIPPED` **corrected an inversion** when it arrived: the run's
`skippedCount` used to count `NOT_RUN`, so the number labelled "skipped" in the
UI meant "queued", while genuine skips were mapped to `BLOCKED` and hidden in
`otherCount`. Now `skippedCount` counts real skips and `otherCount` carries
`NOT_RUN` + `BLOCKED`.

Two consequences worth knowing:

- **Pass rate excludes skips.** `executed = total − NOT_RUN − SKIPPED`, so a
  suite is not punished for tests it was deliberately told to skip. The rate is
  defined once, in `computePlanPassRate` / `rollupFromCounts` — do not re-derive it.
- **No backfill.** Results already stored as `BLOCKED` stay `BLOCKED`; there is
  no way to tell in retrospect which of them were skips, and guessing would
  rewrite history. Runs ingested from here on classify correctly.

A person cannot record `SKIPPED` — it describes what an automated suite did, so
it is absent from the mark menu and from the `recordResult` input. Pushed to
Azure DevOps it maps to `NotApplicable`, not `NotExecuted`: ADO draws the same
distinction, and collapsing them would make a suite that skips by design look
permanently un-run.

Raw provider status is preserved **at run level** (`TestPipelineRun.status`) and
shown in the run detail. Per-test raw status is not persisted.

## Bugs from failures (RCA)

Opt-in per project via `Project.autoCreateBugsFromFailures` (Settings ▸ Testing,
under "Test-case generation"), **default off**. When on, `openBugsForFailedCases` opens one
`PIPELINE_FAILURE` bug per failing case, deduplicated on
`UserStory.originTestCaseId` plus a non-terminal state, so a persistent failure
does not file a new bug every sync.

The bug body is a **fixed template** — there is no model call in the RCA path
itself, so *this* path is failure reporting. The model-proposed cause lives on the
finding instead (see below), where a human reads it before deciding to file
anything. What it contains: the case identifier and title, the failing test name
with its match tier, the branch and short commit, a link to the provider run,
and **the assertion CI printed** (`failureMessage`, fenced and truncated at 1500
characters; the full text stays on the run).

That last part used to be missing, which was the difference between a bug
someone could triage and one that only said "a test failed" — the failure text
lives in the run's `results` JSON, so a reader had to leave Fabric to learn
anything at all about the cause.

Still unbuilt: reading the *diff* alongside the failure. The analysis below reasons
over the failure output and its recurrence history, not over what changed in the
code.

An already-open bug is not auto-closed when its case goes green; the body tells
the reader to close it once the test passes.

## Findings — what keeps breaking

A **finding** is one distinct failure tracked across runs; a bug is the decision
to act on it. `recordFindingsForRun` (called from the ingest activity) upserts one
`TestFinding` per distinct failure on a stable fingerprint, so the same assertion
failing for three weeks is **one row with `occurrences: 21`** rather than
twenty-one unrelated-looking red runs. `resolveFindingsNotSeen` closes the ones
a later run stopped reporting.

Promotion to a bug is **always a person's action** (`promoteQaFinding`), never
something ingestion does — most failures are flakes or known breakage, and a
backlog that gets one item per failure stops being read. Promotion is idempotent:
a second click returns the first bug.

Findings appear on both QA surfaces, and like the run list they are scoped:

- **feature QA tab** — only the failures whose matched case is linked to that
  feature. This reaches through `TestFinding.testCaseId` → the case's work-item
  link, so it necessarily excludes findings with **no** matched case.
- **project QA tab** — everything, including the failures Fabric tracks
  no case for. That is deliberate: an unattributable failure has no feature to
  belong to, and the project surface is the only place it can be triaged, so it
  must never be filtered out there.

For the same reason the **untracked automated tests** list is omitted on a
feature tab rather than scoped. A test with no Fabric case has no feature; a
project's untriaged tests listed under one feature's results reads as that
feature's problem.

An empty findings list renders **nothing at all** — good news is not an empty
state to apologise for.

### The AI failure analysis

"Analyse" on a finding row asks a model to propose a **cause**. It reads the
assertion CI printed (the same 1500 characters the bug body carries, so the two
show the same evidence), the matched case's title, and how long and how often the
failure has recurred. It does **not** read the diff.

It writes four advisory columns on the finding — `suspectedCause`,
`suspectedKind`, `analysedAt`, `analysisModel` — and nothing else. It does not
touch `status`, does not set `promotedStoryId`, and opens no bug. **Promotion
stays a person's action** (product ruling, 2026-07-26); `suspectedKind` is
something to show a human, never a trigger. A test asserts the write touches only
those four columns, so this cannot drift into auto-filing by accident.

`suspectedKind` is one of `PRODUCT_BUG`, `TEST_DEFECT`, `ENVIRONMENT`, `FLAKY` or
`UNKNOWN` — the coarse triage question, "is this ours or a broken test?".
`UNKNOWN` is a first-class answer and the prompt asks for it whenever the output
is truncated or generic. The generation schema takes `kind` as a plain **string**,
not an enum, and normalises in code: a strict enum turns "Product Bug" into a
schema-rejection retry loop for a field that is advisory anyway. Anything
unrecognised becomes `UNKNOWN`.

In the UI the block is visually separated, labelled "Suspected cause", and
attributed to the model that produced it — it sits directly beneath the assertion
CI actually printed, and a reader must be able to tell which of the two is
evidence. Losing the model name costs the attribution, never the disclaimer.

The prompt is the org-editable `test_failure_analyst` binding, not an inlined
string: where a team draws the line between "flaky" and "environment" is a house
convention. If it is **not seeded**, the analysis refuses (`PROMPT_UNAVAILABLE`)
rather than falling back to a hidden copy — an analysis from a prompt no admin can
see is what the editable-prompt rule exists to prevent.

Every non-answer is returned as data with a reason, so the UI can say it:

| Reason | What happened |
|---|---|
| `NOT_FOUND` | The finding was resolved or removed between render and click. |
| `MODEL_ERROR` | The provider was unreachable, rate-limited or out of credit. Nothing was written. |
| `PROMPT_UNAVAILABLE` | `test_failure_analyst` is not seeded in this environment. |
| `NO_CONCLUSION` | The model produced no usable cause. Deliberately **not stored** — a blank cause beside an `UNKNOWN` badge is indistinguishable from this feature being broken. |

Re-analysing **overwrites**. The newest occurrence is the one worth reasoning
about, and a pile of stale hypotheses is worse than one current one.

Not audited, deliberately: the directly comparable model call
(`generateQaAnalysis` — also user-triggered, also spends tokens, also writes a
derived field) is not audited either. Auditing one and not its twin would be worse
than auditing neither. If AI actions belong in the ledger, that is one uniform
change across all of them.

## Reading results in the product

Both the QA ▸ `runs` segment and the feature QA tab render the same
`PipelineRunsPanel`, and they differ in two respects:

- the QA tab passes `onSelectCase`, so matched case identifiers in the
  run detail are clickable there;
- the feature QA tab passes `storyId`, so it lists only the runs that **actually
  tested that feature**. The QA tab omits it and shows the whole project.

"Actually tested that feature" means the run produced a result for a test case
linked to it — the `TestResultEvent` join, not a name match. A feature whose
cases have never been reported on shows **nothing**, and says so in its own words
("No CI run has tested this feature yet"), rather than falling back to the
project's runs. That fallback is the tempting change and it is the wrong one: it
makes an untested feature look identically busy to a fully covered one.

There is **no cap** on how far the scope reaches: it is a relation filter on the
run (`resultEvents.some.testCase…`), so `take`/`skip` are real SQL
`LIMIT`/`OFFSET` and the history is genuinely paginated. Both the preview list
and the "View all" dialog — page *and* total — are scoped together, so
"showing 3 of 412" cannot appear above three runs.

> Do not "optimise" this back into collecting run ids from `TestResultEvent`
> first. That version needs `distinct: ["pipelineRunId"]` with
> `orderBy: { occurredAt }`, which Postgres cannot express (`SELECT DISTINCT ON
> (x) … ORDER BY y` is invalid — the `DISTINCT ON` expressions must lead the
> `ORDER BY`). Prisma therefore dedupes in Node, `take` silently stops being a
> `LIMIT`, and every call pulls the feature's entire event history over the wire
> — on each QA-tab mount and each 3s poll tick after a sync. It returns the right
> rows, which is what makes it easy to miss.

- **Run row**: provider mark, `passed/total` badge, failing count, pipeline name,
  branch, who triggered it, duration, relative time with the exact local
  timestamp on hover, and a link out to the provider. A run reporting **no**
  tests renders neutral rather than green.
- **Run detail**: branch, run-by, 8-char commit, duration, started, raw status,
  and every test with its name, classname, normalized status, distinct native
  provider status, failure message and matched case. Searchable, with a
  failures-only toggle; 100 rows per page and never silently truncated.
- **Freshness line**: the last successful fetch time is shown **alongside** any
  failure, never replaced by it — `lastFetchedAt` only advances on success, so it
  is exactly what says whether the runs on screen are minutes or weeks old.

  It stays **project-level on both tabs, deliberately.** Sources are configured
  per project, so there is no per-feature version of "did the sync fail" to scope
  it to. More importantly, "synced 2 minutes ago" sitting above "no CI run has
  tested this feature yet" is not a contradiction — it is the single most useful
  state this tab can convey, because it says *the problem is coverage, not a
  broken pipeline*. Scoping this line to match the run list would destroy that
  reading. It is left alone on purpose; do not "fix" the inconsistency.
- **Untracked automated tests**: distinct unmatched tests across recent runs,
  failing-first. "Create case" seeds `automationRef` and `automationFilePath` from
  the test so the cascade claims it on the next sync, and the read re-runs the
  live cascade so a newly-created case drains its row immediately.

## Getting a pipeline to report in the first place

Most of the failures below are a pipeline that was never configured to publish
results Fabric can read. **Settings ▸ Testing → "Make your pipeline report to
Fabric"** generates the snippet: pick a provider, optionally set the branch, test
command and JUnit path, and copy the file. It sits directly under the pipeline
sources panel, because "which branch does QA read" and "my pipeline publishes
nothing to read" are the same conversation.

Underneath it, `GET /projects/{projectId}/qa/ci-config` returns the CI
configuration for a given provider — the workflow or job block, plus the notes
that matter (artifact naming for GitHub, `artifacts:reports:junit` for GitLab,
the Test Management PAT scope for ADO).

It returns **text for a human to commit**, and the panel says so on screen so
nobody goes hunting for an "apply this for me" button. Fabric deliberately does
not write into a customer's repository: that is their infrastructure, the change belongs in
their review process, and a tool that silently commits CI config is a tool nobody
can trust with a repo token.

The endpoint is permission-gated (`TEST_CASE_READ`) and rides the same feature
flag as the rest of the QA surface. It is what Settings ▸ Testing renders under
"Make your pipeline report to Fabric", and it is reachable through the API too.

## Diagnosing an empty sync

In rough order of likelihood:

1. **Credential scope** — `Actions: read` for GitHub, **Test Management: Read**
   for ADO. A repo-only token is the commonest cause.
2. **Artifact name** (GitHub) — must match `/junit|test|report|result/i`.
3. **`artifacts:reports:junit`** (GitLab) — `artifacts:paths` produces no report.
4. **Branch** — the `qaBranch` override or the repo default; the sync logs the
   branch it used.
5. **Cursor** — a source whose runs all sit below the stored cursor returns
   nothing by design.
6. **Failures are recorded, not thrown** — check `test_pipeline_sync_state` for
   `lastError`, and the structured log: every per-source failure emits
   `qa.pipeline.sync.source_failed` with the project, provider, pipeline key and
   the error. (These used to land only on the sync-state row, so diagnosing a customer's silent sync
   meant reading their screen or their database.)

### "I pressed Run tests and no run appeared"

Expected, up to a point: Fabric only **queues** the run. It then has to finish in
the customer's CI, and the result has to be fetched. So the gap between pressing
the button and seeing a row is *pipeline duration + the next fetch* — which is at
worst the 15-minute sweep interval, or immediately if someone presses `Sync now`.
Routinely several minutes either way.

Beyond that, in order:

1. **Did it actually start?** The dialog reports a refusal in place, and
   `qa.pipeline.trigger.attempted` logs `ok` and the `failure` code for every
   attempt. The `project.ci_run.triggered` audit row records the same.
2. **Wrong branch** — the trigger defaults to the branch QA watches, and the sync
   filters on that same branch. Triggering one branch while QA watches another
   produces a run that exists and is never ingested.
3. **The run finished but published nothing Fabric can read** — that is the
   ordinary ingestion problem above, not a trigger problem; check the artifact
   name / `artifacts:reports:junit` / `PublishTestResults` rules first.

A run still in flight is **not** skipped: `advanceCursor` holds the cursor just
below the oldest unfinished run, so a run triggered now is re-listed and ingested
once it completes.
