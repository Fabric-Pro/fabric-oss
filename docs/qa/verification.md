# Verifying the QA pipeline against a real provider

The end-to-end checks that unit tests cannot make, and the order to run them in.

- **Audience**: whoever verifies a QA release on staging
- **Owner**: Fabric platform team

Run these **on staging**. Never against production.

---

## Why this order

Each step's failure explains the next step's failure. Running them out of order
turns one broken credential into four mysterious symptoms. Stop at the first
red — a later step passing after an earlier one failed usually means it read
stale data.

## 0. Preconditions

| Need | Why it matters |
|---|---|
| A staging project with a **connected code repository** (Settings ▸ Development) | Pipeline results come from the repo integration, never the PM-tool connection. A project whose ADO is connected only as a PM tool has no result source at all. |
| That repo's CI **publishing JUnit XML** | Fabric reads what the pipeline publishes; it cannot run tests. If nothing is published there is nothing to sync, and every later step reports "empty" for the same reason. |
| `FABRIC_FEATURE_TEST_CASES` on | Gates the whole surface. |
| A token with the scope for the provider you are testing | See the table in [pipeline results](./pipeline-results.md) § "Starting a run". **ADO needs Test Management: Read** — a Code-only PAT lists no Test Runs and is the commonest cause of an empty ADO sync. |

If the repo's CI does not publish JUnit yet, Settings ▸ Testing → **"Make your
pipeline report to Fabric"** generates the config to commit. Fabric will not
commit it for you, by design.

## 1. Ingestion — does a real run arrive?

1. Trigger a run in the provider directly (not through Fabric), and let it finish.
2. QA tab → **Sync now**.
3. **Expect**: the run appears with provider mark, `passed/total`, branch, commit,
   duration and a working link out.

**If empty**, work down [§ Diagnosing an empty sync](./pipeline-results.md#diagnosing-an-empty-sync)
before anything else. An empty ingest makes every remaining step meaningless.

**Watch for**: a run reporting **no** tests should render neutral, not green.
Green-for-zero is the failure that makes an untested project look healthy.

## 2. Linkage — does a result reach a case?

1. Ensure a test case exists whose `automationRef` / file path / title matches a
   real automated test (the three-tier cascade: tag > path > title).
2. Sync, then open the run detail.
3. **Expect**: the matched test names its Fabric case, and the case's current
   result updates.

**Watch for**: the **untracked automated tests** list on the QA tab. A
test that should have matched and did not will appear there — that is the
signal, not an absence of one.

## 3. Triggering — can Fabric start a run?

1. Runs panel → **Run tests**. Pick a pipeline (GitHub/ADO) or accept the ref
   (GitLab).
2. **Expect** either a queued run, **or a refusal that names its own remedy.**

The refusals are the valuable half here, because each was built from a provider
quirk rather than a guess. Deliberately try at least one:

| Try | Should say |
|---|---|
| A GitHub workflow **without** `workflow_dispatch:` | Add `workflow_dispatch:` under `on:` — Fabric will not edit their workflow |
| A read-only credential | Reconnect with the write scope named for that provider |
| An ADO PAT that is expired/invalid | A credential message, **not** `Unexpected token '<'` — ADO answers a rejected PAT with `203` and an HTML sign-in page |

**Then check the audit log** for `project.ci_run.triggered`, including the
refusals. It must record the provider, ref, pipeline id and the **keys** of any
forwarded inputs — never their values.

## 4. Per-feature scoping

1. Open a feature whose linked cases were reported on → QA tab.
2. **Expect**: only the runs that actually tested *that* feature.
3. Open a feature with **no** automated coverage.
4. **Expect**: *"No CI run has tested this feature yet"* — **never** the project's
   runs. This is the property most worth confirming by hand: a silent widening is
   how "nothing tests this" gets mistaken for "everything is fine", and it looks
   identical to working software.
5. Open **View all runs** from the feature tab: the dialog must say "every CI run
   that tested this feature", and its "showing N of M" must not exceed what the
   feature actually has.

## 5. Findings and the AI analysis

1. Let the same test fail in **two** runs. **Expect** one finding with
   `occurrences: 2`, not two findings.
2. Press **Analyse**. **Expect** a labelled *Suspected cause* block, attributed to
   a model, visually separated from the assertion CI printed.
3. Confirm the finding's `status` is **unchanged** and **no bug was opened**. The
   analysis is advisory; promotion is a person's action. A test asserts this, but
   it is the product ruling most worth seeing hold in the real UI.
4. Press **Create bug** and confirm it is idempotent — a second press must return
   the first bug, not open a second.
5. Unseed / misconfigure the prompt binding and re-press Analyse: expect
   `PROMPT_UNAVAILABLE`, not a silent fallback to a hidden prompt.

## 6. Manual order

1. Sort the QA ▸ Cases list by **Manual order**, ascending, no filters, all pages
   loaded. Drag a row.
2. **Expect** the new order to survive a refresh.
3. Apply any filter, or switch sort: handles disappear **and the list says which
   gate is in the way.** Silence here is the bug — a drag that does nothing reads
   as broken software.

## 7. Webhook delivery

Results do not only arrive by sweep. A project can mint one webhook endpoint in
**Settings ▸ Testing**, and a verified delivery invokes the same ingestion path
as polling — see [pipeline results](./pipeline-results.md) for the wire format,
the HMAC envelope, rotation and the dedupe rules.

Two properties are worth exercising by hand, because both fail silently:

1. **The endpoint is not a project oracle.** Send an unsigned request to a
   project id that does not exist:

   ```
   curl -sS -X POST https://<host>/api/webhooks/qa/does-not-exist -d '{}'
   ```

   **Expect** `200 {"accepted":true}` — the same response a revoked secret, a
   bad signature and a missing auth header all produce. Any response that
   distinguishes them turns the endpoint into a way to enumerate projects.

2. **A delivery publishes run metadata immediately, and detail follows.** After
   a verified delivery the run appears in the Runs segment with its status and
   counts, but its per-test breakdown arrives with the next reconciliation
   sweep, not in the request. A reader who expects the breakdown to be there at
   once will report a bug that is the documented contract.

## 8. Mode B — a scripted run

Mode B ships. It does **not** execute user-authored JavaScript: it interprets a
validated JSON action plan with a closed vocabulary, in a sandbox. The runner,
the vocabulary, the revision history and the reasons behind that design are on
[its own page](./agentic-runs.md), which is also where a Fabric-driven run is
verified — that needs an environment with a stored credential rather than a
connected CI, so it is a different exercise from verifying ingestion.

What to check here is only the seam with this page: a Mode B result lands in the
same Runs segment, through the same ingestion, and is distinguishable by its
runner. A scripted run reports **zero model calls** and **$0.00** — if it
reports a cost, it did not run the plan.

## 9. Known gaps

- **The failure analysis reads a diff, but a best-effort one.** It correlates
  what changed since the test last passed; the provider can cap or refuse that
  comparison, and the UI says so when it happens. Treat a missing diff as
  "unavailable for this run", not as "the feature does not do that".
An Azure DevOps failure banner that never cleared **used to be listed here and
is fixed.** The key mismatch is real — a plan-derivation failure is recorded
under `owner/repo` while an Azure DevOps success uses `project/repo` — but a
successful sync now supersedes the row under the key its own failure would have
used, so the banner clears the moment the source works again. Worth knowing
because the mismatch is still visible in the code and reads like a live bug: the
compensation is at the *success* end, not the failure end.

## What a result must say to count

A verification result names **which provider and which repository** were used.
"QA verified on staging" without that is not a reproducible claim — the three
providers fail in different places, and a pass on GitHub says nothing about the
ADO Test-Management scope.
