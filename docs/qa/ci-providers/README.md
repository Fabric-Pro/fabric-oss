# CI provider setup

- **Audience**: engineers working on the QA surface; support engineers diagnosing
  a project whose pipeline results look wrong
- **Owner**: Fabric platform team

Customer-facing instructions live in `apps/web/content/docs/features/testing/`.
Keep known defects and internal follow-ups out of those pages and out of these
ones; they belong on a ticket.

One page per provider, covering the part a customer has to do themselves: issue a
credential with the right scope, and make their pipeline reachable.

- [GitHub Actions](./github-actions.md)
- [GitLab CI](./gitlab-ci.md)
- [Azure DevOps](./azure-devops.md)

For how ingestion works once a provider is connected — the sweep, the webhook
accelerator, the normalised JUnit core — see [`../pipeline-results.md`](../pipeline-results.md).
These pages carry only what differs between providers.

## What every provider needs

Two capabilities, granted separately, because most teams want the first and not
always the second:

| Capability | What it does | Needed for |
|---|---|---|
| **Read** | Lists pipeline runs and their test results | The Testing tab's pipeline results, findings, and bug creation |
| **Write** | Starts a run from inside Fabric | The *Run tests* button only |

A read-only credential is a complete setup. Fabric refuses the trigger with a
message naming the scope it would need, and nothing else degrades.

Fabric **reuses the code-repository credential** and never stores its own — see
`../../adr/014-qa-reuses-the-repository-integration-credential.md`. Results come
from the code repository, not from the PM-tool connection
(`../../adr/016-qa-results-come-from-the-code-repository-not-the-pm-tool.md`),
which matters most on Azure DevOps where a customer can reasonably read the two
connections as one thing.

## Adding a provider

The ingestion core is provider-agnostic: thin fetchers normalise into a JUnit
shape and everything downstream reads that
(`../../adr/012-junit-normalised-core-with-thin-provider-fetchers.md`). Adding
one means writing a fetcher, a trigger, and a page here. The page should answer
four questions, because those are what support tickets are actually about:

1. **Which credential, at which scope**, spelled the way the provider's own UI
   spells it. "Read access to Actions" is not what the checkbox says.
2. **What the customer must change on their side**, if anything. GitHub needs
   `workflow_dispatch:` in the workflow file; GitLab and ADO need nothing.
3. **How a wrong scope presents.** Most providers answer with something other
   than a clean 403, and the failure a customer reports is the symptom, not the
   cause.
4. **How to verify it worked**, as a command they can run.

Keep the same four headings in the same order across pages, so someone
connecting a second provider can scan for the difference.
