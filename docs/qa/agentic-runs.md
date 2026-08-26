# Fabric-driven test runs

How Fabric executes a test case itself — driving a real browser through the case's
own steps against one of the project's environments — and what it records.

- **Audience**: engineers working on the QA runner; support engineers explaining why a run blocked, refused, or cost what it cost
- **Owner**: Fabric platform team

This is the half of QA where Fabric *produces* results rather than reading them.
[Pipeline results](./pipeline-results.md) covers the other half: what the
customer's CI reports. Both land in the same run history and the same findings,
because a run's verdict is stored the same way whichever side produced it.

## What a run is

A dispatch takes a set of test cases and uses one of two runners:

- **Agentic (Mode A)** opens a browser, signs in if the environment carries a
  credential, and walks the case's ordered **Action + Expected** steps. A model
  decides what to do at each step and judges whether the expectation held.
- **Scripted (Mode B)** interprets the case's saved declarative JSON action plan
  through a trusted Playwright runner in an isolated sandbox. Customer-authored
  data is never executable. It makes **zero model calls** while running and has
  an exact 300-second case timeout.

The unit is the **case**, not the suite. Each case gets its own browser context,
so one case failing to sign in does not decide anything about the next.

## Dispatching

From the QA tab's **Runs** segment: select cases on the **Cases** segment, then
**Run selected cases**. The dialog picks the runner, environment, browser and
resolution; anything it does not name falls back to the project's QA policy —
the default environment, the first entry of `browsers`, the first entry of
`resolutions` (see [QA settings](./qa-settings.md)).

A frequently-used combination can be saved as a **run configuration**
(`TestRunConfiguration`: a name, a runner, an environment, a browser, a
resolution).

A configuration deliberately does **not** store a case list. A saved selection
would go stale the moment somebody adds a case, and a run that quietly tests less
than the reader believes is worse than no saved configuration at all.

The dispatch requires `TEST_CASE_UPDATE` — running a case writes results, so it
is not a read. Mode B additionally requires `PROJECT_SETTINGS_EDIT`, because its
trusted runner may use the selected environment credential.

## Statuses, and why each one earns its place

`AgenticRunStatus` distinguishes outcomes that are easy to collapse and expensive
to confuse:

| Status | Meaning |
|---|---|
| `QUEUED` | Accepted and handed to Temporal; no browser open yet |
| `RUNNING` | At least one case is being driven |
| `PASSED` | Every case reached a verdict and none failed |
| `FAILED` | At least one case failed — a verdict about the software, not the runner |
| `BLOCKED` | The run completed but at least one case could never be attempted, and none failed |
| `NEEDS_REVIEW` | Cases ran, nothing failed, and at least one verdict fell below the project's confidence threshold |
| `CANCELLED` | A person stopped it, or the workflow died |
| `REFUSED` | The run never started, because the cost estimate exceeded the cap |

`BLOCKED`, `NEEDS_REVIEW` and `REFUSED` all exist to stop "nothing was
established" from reading as a pass. The first real run on staging came back
`PASSED` with 0 passed and 1 blocked — every case had died at sign-in and the run
still showed green. That is the failure these statuses rule out, and it is pinned
by tests that assert the derivation directly.

### The precedence, and the trap in it

Worst first: `CANCELLED` → `FAILED` → `BLOCKED` → `NEEDS_REVIEW` → `PASSED`. A run
holding a real failure is a failed run whatever else it holds; a case that never
ran outranks one that ran inconclusively; and a green badge over a verdict the
model would not stand behind is exactly the claim the threshold exists to stop.

`BLOCKED` also absorbs the "nothing was established at all" case — a run whose
cases were every one of them skipped for having no steps. That catch-all is
written as `passed === 0`, and it is a trap: when `NEEDS_REVIEW` was added, the
proxy evaluated first and swallowed it, so a run where *every* case needed review
reported `BLOCKED` and the new status was unreachable except alongside a passing
case. The derivation now lives in `agenticRunStatusFor`, exported and tested for
exactly that shape, rather than in a nested ternary at the call site.

### `NEEDS_REVIEW` is Fabric's alone

It is a run and step status, not a `TestResult`. That enum is also a test case's
stored *current result*, read by coverage, the traceability matrix and every PM
sync, and none of them should have to learn a value only one producer can emit. A
case awaiting review therefore ingests as `BLOCKED` in the shared vocabulary —
`toIngestResult` does the translation at that one boundary — while the agentic run
beside it keeps the precise state. Anything assigning a case result into a
`TestResult` field must go through that helper.

## The cost cap refuses; it does not warn

Before dispatch, the run is estimated and compared against a per-run cap —
`FABRIC_QA_AGENTIC_RUN_COST_CAP_USD`, defaulting to `$5`. Over the cap, nothing
starts: the run is stored `REFUSED` with the estimate, the cap and a
`refusalReason` written in the words the user is shown, so the decision can be
argued with rather than guessed at.

It is a deployment setting rather than a project one, deliberately — a spend
ceiling that the spender can raise is not a ceiling.

Two independent bounds sit underneath it: at most **500 cases** in one dispatch,
and at most **40 browser operations per case**, which bounds wall-clock even when
a case's steps send the model in circles.

The estimator is calibrated to err **high** — measurements put it at roughly
1.3–1.5× actual. That is intended: a cap is only worth having while its estimate
is conservative.

Mode B is estimated and billed at `$0` model cost. Creating its reusable plan can
use repository embedding lookup and one model-assisted generation call, but
executing that saved plan does not.

## Creating a reusable Mode B script

Open a test case and use **Create script**. There are three authoring paths:

1. **Agent run + repository** — choose any prior eligible Mode A execution for
   this case. Fabric gives the generator that run's executed observations plus
   relevant, secret-scanned excerpts from the repository code index. Older runs
   stay selectable after newer ones finish.
2. **Repository only** — use the case's intent and relevant indexed repository
   excerpts, without any prior agent observations.
3. **Manual** — write or paste the JSON plan yourself; this makes no model call.

The first two paths can spend embedding and generation tokens once to create an
editable plan. Every later Mode B run executes the stored plan without asking a
model again. The contract is a closed action vocabulary:

```json
{
  "version": 1,
  "steps": [
    { "action": "goto", "path": "/sign-in" },
    {
      "action": "fill",
      "locator": { "by": "label", "value": "Email" },
      "value": "qa@example.com"
    },
    {
      "action": "assertVisible",
      "locator": { "by": "role", "role": "heading", "name": "Dashboard" }
    }
  ]
}
```

Allowed actions are `goto`, `click`, `fill`, `press`, `selectOption`, `check`,
`uncheck`, `assertVisible`, `assertText`, and `assertUrl`. Navigation paths must
be same-origin relative paths. There are no imports, selectors, callbacks,
network primitives, or arbitrary JavaScript.

Every actual change is stored as a complete, append-only
`TestCaseScriptRevision`: timestamp, author snapshot, origin, selected source run
and full script. The case editor can diff any revision against the current
editor and restore it. A restore creates a new `REVERT` revision; it never
deletes the versions that came after the selected one. Source-run and revision
lists are paginated, so older executions and versions remain selectable.

## What a run records

- **Per-step observations** (`TestAgenticStepLog`) for Mode A — what the model
  saw and what it concluded, in order, including the step that ended the case.
- **A deterministic sandbox verdict** for Mode B, with model calls fixed at zero.
- **Screenshots for Mode A**, when the project's evidence policy asks for them.
  Mode B currently records its deterministic verdict without screenshots. Mode A
  images are uploaded privately under the tenant's own storage prefix and handed back
  through a signed URL valid for **300 seconds**, re-checked per request against
  the tenant that owns the run.
- **Cost and model calls**, so a run's price is attributable rather than
  aggregate.
- **A finding for each failure**, sharing the fingerprint, recurrence counting and
  triage surface with CI-reported failures.

A skipped or blocked case says **why** rather than reporting a bare absence.

## A failing run never files a bug

An agentic failure creates a finding; promoting it to a bug is a person's action.
This is a product ruling, not an oversight.

`confidenceThreshold` is a separate question and is no longer inert: it does not
decide whether a failure becomes a bug, it decides whether a verdict is recorded
at all. See *The confidence threshold* below.

The contrast with CI is deliberate: `autoCreateBugsFromFailures` does open bugs
from *pipeline* failures, because a red CI run is a repeatable machine-reported
fact. A browser-driving model's judgement is not yet held to that bar.

## The confidence threshold

`project_qa_settings.confidenceThreshold` (0–100, default 80) is the bar a
verdict must clear to be recorded. Below it, the step records `NEEDS_REVIEW`
instead of `PASSED` or `FAILED`, and the case and run carry that upward.

The runner asks for it: `AssessDecisionSchema` carries an optional `confidence`,
and `ASSESS_JSON_CONTRACT` spells out the 0–100 scale for the text-fallback path.
`stepStatusFor` applies the gate and `normaliseConfidence` reads the number.

Four decisions in that reading, each of which is the difference between a useful
gate and an unusable one:

- **Absent confidence keeps the verdict.** "I did not say how sure I was" is not
  "I was not sure". Treating silence as zero would mean one provider dropping an
  optional field sends every step of every project to review at once — and the
  threshold defaults to 80 on every project that has ever existed, so this ships
  live everywhere the day it deploys. The runner logs
  `qa.agentic_run.assessment_confidence_missing` instead, which is the only way
  to discover that a project's threshold is quietly doing nothing.
- **A 0–1 answer is scaled up.** Both conventions are in the wild and a prompt
  cannot stop a model picking the other one. Read literally, `0.9` against a
  threshold of 80 would send a *confident* step to review. An exact `1` is
  genuinely ambiguous and is read as certain — failing toward recording the
  verdict, i.e. toward the behaviour before the gate existed.
- **`0` disables the gate outright**, for a project that wants the old behaviour.
- **A failed assessment counts as confidence 0.** When the assess call itself
  throws, the runner used to record `FAILED` — a verdict the model never gave.
  With a threshold set that is now `NEEDS_REVIEW`; with the gate off it still
  reports `FAILED`, exactly as before.

An unperformed operation stays `BLOCKED` regardless: there is no judgement to be
unsure about when nothing was done.

## Credentials

An environment may carry a sign-in credential — a form login, a bearer token, or
a custom header. It is encrypted with the same AES-256-GCM helper the repository
tokens use, and exactly one caller decrypts it: the runner, at the point of
signing in.

For the **form** kind, the password reaches one function and stops there. It is
never placed in a model prompt, never written to a step observation, and never
returned over the wire. In Mode B the resolved credential is passed only to the
trusted interpreter. The saved plan is validated JSON and cannot read process
state, Playwright internals, credentials, or stdout. Sandbox output is bounded
and exact credential values are redacted before it leaves the worker.
See [QA settings](./qa-settings.md#sign-in-credentials) for the storage contract.

Dispatch snapshots the target URL, non-secret authentication configuration, and
the exact script revision id into the workflow. The encrypted secret itself
never enters Temporal history; it is resolved only inside the activity. Secret
rotation is allowed, but changing the target, sign-in URL, auth kind, username,
or header name blocks the queued run and asks the user to dispatch again.

## Durability

The run is a Temporal workflow. Long runs proceed in **batches**, carrying only
counters and the remaining case ids across `continueAsNew`, behind the patch
`qa-agentic-durable-batching`.

Per-batch verdicts are staged in `TestAgenticCaseResult` and drained into a single
ingest at the end, so the Runs list still shows one run per dispatch. The staging
table exists because step logs hang off a result row that only exists after that
final ingest — there is nowhere else to put per-batch detail. Removing it
rediscovers this the hard way, through a replay-validation failure.

Cancellation is honoured across the batch boundary, and a cancelled run keeps the
steps it already executed rather than discarding its own work.

The 15-minute deployment sweep also reaps abandoned envelopes: a run left
`QUEUED` for 15 minutes, or `RUNNING` without progress for 45 minutes, becomes a
terminal `BLOCKED` record. The list therefore cannot poll a dead workflow
forever.

## Verifying a run by hand

1. Give an environment a base URL and, if the app needs a login, a sign-in URL and
   a credential. Save it — a run refuses until a default environment is **saved**,
   and that form needs its explicit save.
2. Select one case that is known to fail and one known to pass. Dispatch.
3. **Expect**: counters advancing mid-run; per-step observations quoting the live
   page; a screenshot per step in Mode A if the evidence policy asks for one; a finding for
   the failure; and **no bug opened**.
4. Re-run the same failing case. **Expect** the existing finding's occurrence
   count to increase — not a second finding.
5. Lower `FABRIC_QA_AGENTIC_RUN_COST_CAP_USD` below the estimate and dispatch
   again. **Expect** `REFUSED`, naming the estimate and the cap.
6. Generate a Mode B script from the older of two Mode A runs. Edit and save it,
   open **History**, inspect the author/timestamp diff, restore the generated
   revision, then dispatch in Scripted mode. **Expect** model calls and model
   cost to remain zero for the run.

A dispatch made within a minute of a worker deploy can hit a replica still serving
the old image, which looks exactly like a fix failing. Re-dispatch a few minutes
later before concluding anything.

## Reading the evidence

Each step that captured a screenshot renders it **in the run detail**, under the
step it belongs to, with the observation beside it. It is not a link labelled
"screenshot": finding the frame where a run went wrong used to mean opening
every step in turn, and the image is the fastest thing on the page to read.

Beside each one are two controls that do different jobs. **Open full size** is
the same short-lived signed link, for looking at the whole frame. **Download**
is a second signed link carrying a `Content-Disposition`, so the saved file is
called `TC-014-step-3.png` rather than the storage key, which is a UUID. That
matters the moment somebody attaches evidence to a bug report: a folder of
UUIDs is indistinguishable a minute later.

Both links expire after five minutes, which is deliberate — the image is a
customer's own application, sometimes signed in. A panel left open past that
shows a short line saying the link expired and to reopen the run, rather than a
broken image with no explanation.

## Evidence at rest, and its retention

A Mode A screenshot is stored as a **key, not a URL**. Links are minted signed
and short-lived at read time, so a stored link would be a leak with an expiry
date. Objects are written privately under the tenant's own storage prefix, and
every read re-checks that prefix against the tenant that owns the run — a
prefix collision is rejected rather than resolved.

**Retention is a window, not a cascade** (product ruling, 2026-07-31). Evidence
outlives its run, its case and its project, and expires on
`ProjectQaSettings.evidenceRetentionDays` — 90 days by default, `0` to keep
indefinitely. Deleting a test case must not erase the proof of what it once did,
and an auditor asking what a run actually showed cannot be answered by whether
somebody has since tidied up the case.

`qa-evidence-retention` sweeps daily at 04:45 UTC, half an hour after the
attachment purge so the two object-store sweeps do not contend.

### Why a ledger table exists

`TestRunEvidence` records every stored object. It looks redundant beside
`TestAgenticStepLog.evidenceKey`, and is not, for two reasons that only show up
when you look at the data:

1. **An evidence key names no run.** It is
   `{tenant}/qa-runs/{projectId}/{testCaseId}/step-{n}-{ms}.png`, so every run of
   the same case writes under one prefix, separable only by a millisecond suffix.
   Listing by prefix answers "this case, every run it ever had".
2. **The only other pointer dies with its owner.** `evidenceKey` hangs off
   `TestResultEvent`, which cascades from `TestCase`, which cascades from
   `Project`. Permanently deleting a project makes Postgres drop every row naming
   those objects with no application code running — the pointer disappears and
   the data does not.

Hence a table with **no foreign keys at all**, including on `organizationId` and
`userId`. That is the design, not an oversight: any relation would cascade the
row away and recreate the orphan it exists to prevent. `user_owned` RLS compares
column values and has no interest in whether the referenced row survives.

### How the sweep behaves

- **Object first, then the row**, the one inversion of the row-before-object
  rule (matching `attachment-retention-purge`). Only rows whose object delete was
  confirmed lose their ledger entry; an errored one is retried next run. A second
  delete of an absent object is harmless, an untracked object is not.
- **Per-project windows, resolved in code rather than joined.** A project that
  has never saved its QA settings has no row and takes the 90-day default — a
  join would silently skip exactly those projects, which is most of them.
- **Keyset pagination on `id`**, and the cursor advances on the page's last row
  whatever happened to it, so a page whose deletes all fail still moves rather
  than looping.
- **Bounded**: 2,000 confirmed deletes per run and 100,000 pages. Both are
  logged when hit.
- The QA feature gate lives in the activity, not the schedule, so turning the
  flag on takes effect on the next tick with no redeploy.

**One gap worth stating.** The sweep can only see evidence captured after the
ledger shipped. Screenshots already in the bucket have no ledger row and need a
one-off reconciliation — listing the bucket and inserting rows for what is found
— before they can ever be swept.

## Source locations

| What | Where |
|---|---|
| Workflow | `packages/temporal/src/workflows/qa-agentic-run.ts` |
| Activities | `packages/temporal/src/activities/qa-agentic-run/` |
| Run lifecycle, status derivation, findings | `packages/temporal/src/activities/qa-agentic-run/run-lifecycle.ts` |
| One case, in the browser | `packages/temporal/src/activities/qa-agentic-run/run-case.ts` |
| Dispatch, list, cancel, configurations | `packages/api/modules/projects/procedures/agentic-runs/` |
| Queries, and the stale-run reaper | `packages/database/prisma/queries/projects/agentic-runs.ts` |
| Models | `TestAgenticRun`, `TestAgenticCaseResult`, `TestAgenticStepLog`, `TestRunConfiguration`, `TestCaseScriptRevision` in `packages/database/prisma/schema.prisma` |
| UI | `apps/web/modules/saas/projects/components/test-cases/pipeline/AgenticRunsPanel.tsx`, `RunConfigurationDialog.tsx` |

## Not built

- **Scheduled or triggered agentic runs.** A run happens because somebody asked
  for one. The only QA schedule pulls CI *results*; nothing dispatches a Fabric
  run, so a saved "nightly regression" configuration is nightly only if a human
  remembers.
- **Finding severity and steps-to-reproduce.** A finding carries its
  fingerprint, recurrence, suspected cause and correlated files, but not the two
  fields a triager sorts by.
- **Merging or dismissing a finding.** Fingerprints are computed at insert and
  there is no backfill, so findings recorded before a fingerprint change stay
  split — one fault can show as several rows, each reading "Seen 1 time".
