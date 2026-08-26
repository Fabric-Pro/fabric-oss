# Azure DevOps

Connecting an Azure DevOps project so Fabric can read test runs and queue builds.

- **Audience**: engineers working on the QA surface; support engineers diagnosing a project whose pipeline results look wrong
- **Owner**: Fabric platform team

## Credential and scope

| Capability | PAT scope |
|---|---|
| Read results | **Test Management: Read** |
| Start a run | **Build: Read and execute** |

**Test Management: Read is the single commonest cause of an empty Azure sync.** A
Code-only PAT authenticates, connects, and lists no Test Runs at all, so the
connection reports healthy and the results list stays empty. Check this scope
first on any "ADO returns nothing" report.

## What the customer must change

The pipeline needs a **`PublishTestResults`** task. Without it there are no Test
Runs to read, whatever the PAT can do. The generator in Settings ▸ Testing ▸ Sync
emits `PublishTestResults@2`.

Starting a build needs no change to the pipeline definition.

## The two Azure DevOps connections

Azure DevOps can be connected twice, for different jobs, and a customer
reasonably reads them as one thing:

- the **code-repository** integration (PAT), which is where pipeline results come
  from;
- the **PM-tool** connection (MCP), which is where work items come from.

A project with only the PM connection has no source for pipeline results. Fabric
says exactly that rather than showing a bare empty list, because an empty state
that cannot tell "nothing connected" from "the thing you connected cannot do
this" sends someone to check a connection working perfectly well at its own job.
See `../../adr/016-qa-results-come-from-the-code-repository-not-the-pm-tool.md`.

## How a wrong scope presents

**Azure DevOps answers a rejected PAT with `203`** — inside the 2xx range — and
an HTML sign-in body. A plain `2xx` check therefore lets the sign-in page reach
`res.json()` and reports `Unexpected token '<'` instead of "check your PAT". Both
the trigger and the definition-listing path guard for this explicitly; keep the
guard if you touch either.

A Code-only PAT does not error at all. It returns an empty Test Run list, which
is why the scope check comes before any debugging of the pipeline itself.

## Verifying

Read access — a PAT with Test Management: Read returns runs, a Code-only PAT
returns an empty list with HTTP 200:

```bash
curl -s -u :<pat> \
  "https://dev.azure.com/<org>/<project>/_apis/test/runs?api-version=7.0" \
  | jq '.count'
```

Confirm the response is JSON before trusting it. A `203` with HTML means the PAT
was rejected, not that there are no runs.
