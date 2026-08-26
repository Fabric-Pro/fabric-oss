# GitHub Actions

Connecting a GitHub repository so Fabric can read CI results and start runs.

- **Audience**: engineers working on the QA surface; support engineers diagnosing a project whose pipeline results look wrong
- **Owner**: Fabric platform team

## Credential and scope

| Capability | GitHub App | Fine-grained token | Classic token |
|---|---|---|---|
| Read results | **Actions: Read** | `actions:read` | `repo` |
| Start a run | **Actions: Read and write** | `actions:write` | `workflow` |

Read and write are separate grants. A team that wants both should ask for
*Read and write* once rather than granting read, discovering the trigger is
refused, and going through the approval a second time.

## What the customer must change

**The workflow has to declare `workflow_dispatch:`** under `on:`, or GitHub
rejects the dispatch with a 422. Fabric will not edit the workflow file, and says
so on screen: it generates CI configuration for a person to commit and never
writes into a repository.

Reading results needs no change to the repository.

## How a wrong scope presents

GitHub answers a missing permission with **403 on the Actions endpoint**, and the
pipeline banner reports which source failed and why.

Two things make this harder to diagnose than the status code suggests.

**GitHub reuses 403 for throttling.** Rate limits are separated by the
`x-ratelimit-remaining` header, so a throttled request does not tell someone to
reissue a credential that was never the problem.

**For a GitHub App, granting a permission does not grant it.** Adding a
permission to the App raises a *pending request* that an owner must approve **per
installation**. Until they do, the installation's tokens keep their old scopes,
while the App's settings page shows the permission as granted. Reconnecting the
repository changes nothing: reconnection mints a token from the same
installation, with the same scopes, which is why the error message says so.

Diagnose from the installation, never from the App:

```bash
gh api orgs/<org>/installations \
  --jq '.installations[] | {app_slug, actions: .permissions.actions}'
```

A **missing key** — absent, not `null` — means never granted. Compare against
another app on the same organisation: if a sibling reports `actions: "read"` and
yours reports nothing at all, the request was never approved.

Two checks make it airtight. `GET /apps/{app_slug}` shows what the App
*declares*, which separates "never requested" from "requested, never approved".
Calling the failing endpoint with an ordinary personal token proves the
repository and endpoint are healthy and isolates the fault to the app credential.

Approving is UI-only. An owner opens each installation's settings page; there is
no API for it, so this step is always a hand-off.

**A PAT is a valid alternative.** `RepositoryAuthMethod` accepts `OAUTH` or
`PAT`, so reconnecting with a token carrying the scopes above clears the same
failure without touching the App. The App approval is usually better, since a
long-lived token is one more credential to rotate.

## Verifying

Read access, from the installation rather than the App:

```bash
gh api orgs/<org>/installations \
  --jq '.installations[] | select(.app_slug=="<app>") | .permissions.actions'
```

`read` or `write` means the token will carry it. In the product, Settings ▸
Testing ▸ Sync, then **Sync now**: the banner clears and real runs appear with
branch, actor, duration and outcome.

Write access, end to end: press **Run tests**, pick a pipeline, and confirm the
run exists on GitHub with `event = workflow_dispatch`:

```bash
gh api "repos/<owner>/<repo>/actions/runs?per_page=5" \
  --jq '.workflow_runs[] | "\(.name) | \(.event) | \(.status)"'
```

Select the pipeline you intend to run. The list offers every workflow in the
repository that declares `workflow_dispatch:`, which normally includes deployment
and maintenance jobs alongside test ones, so a connection check should name a
read-only pipeline such as type-check or unit tests.

## Webhook delivery volume

GitHub cannot filter a webhook by workflow or by branch — the only choice is
which events to subscribe to. Subscribe to **Workflow runs** and nothing else,
then expect Fabric to do the filtering:

- **Three deliveries per run.** GitHub sends `requested`, `in_progress` and
  `completed`. They carry the same run id, so they collapse into one row that
  changes state rather than three rows.
- **Only the watched branch is kept.** A delivery for any other branch is
  accepted and dropped, so feature branches, preview deploys and dependabot runs
  do not reach the pipeline list. Change which branch that is under the
  repository's QA settings.
- **Every workflow on that branch is kept**, including deploys and notification
  jobs, because Fabric cannot tell which of them run tests. A run with no test
  report is recorded at run level with no counts.

So a release that fires twelve workflows on the watched branch produces twelve
rows and around thirty-six deliveries, while the same twelve on a feature branch
produce none.
