# ADR-010: QA Results Are Pulled on a Schedule; Webhooks Accelerate, They Do Not Replace

- **Status**: Accepted
- **Date**: 2026-07-29
- **Deciders**: Engineering team
- **Audience**: Engineers working on QA pipeline-result ingestion, the sync workflow, or the inbound webhook endpoint
- **Owner**: Fabric platform

## Context

Fabric shows a project's CI test results in the QA tab. Those results live in
GitHub Actions, GitLab CI or Azure DevOps, and something has to move them.

There are two textbook ways to do that, and the industry default is the one
Fabric did **not** pick as its foundation:

1. **Webhook-driven.** The provider notifies Fabric on every run. Latency is
   near-zero and Fabric does no work when nothing happens.
2. **Poll on a schedule.** Fabric asks each connected source what is new, on an
   interval, and advances an incremental cursor.

Webhooks look strictly better on a whiteboard. They are strictly better only
when delivery is reliable and configuration cannot drift — and neither holds
here. Fabric does not own the customer's CI. A webhook can be deleted by anyone
with repo admin, its secret can be rotated out from under us, the provider's
retry policy is its own business and generally gives up, and a customer
migrating a repo silently takes the registration with it. Every one of those
failures is **invisible**: the symptom is results that quietly stop arriving,
which reads to the user as "Fabric is broken" long before anyone suspects the
webhook.

Polling has the opposite shape. It is slower and it does work when nothing has
happened, but it is **self-healing**: whatever went wrong, the next tick asks
again, and a source that is misconfigured shows up as a failure on the sync
state rather than as silence.

## Decision

**The scheduled sweep is the source of truth for ingestion. The webhook is an
accelerator layered on top of it, and is never the only path.**

Concretely:

- A Temporal schedule visits projects that are due (`pipelineSyncIntervalMinutes`,
  default 15 minutes) and pulls each connected source through an incremental
  cursor that only advances on success.
- A project may additionally mint one inbound webhook endpoint. A verified
  delivery invokes the **same ingestion path** the sweep uses — it does not have
  a private code path that could drift from it.
- A webhook delivery publishes **run metadata** immediately. The provider's
  detailed test artifacts still arrive through the sweep. Fetching artifacts in
  the request path would put an unbounded provider download inside a webhook
  handler with a delivery timeout.
- Removing the webhook must never break ingestion. If it does, the layering is
  wrong.

## Consequences

**Good.** Results arrive even when nobody configured a webhook — the common
case, since Fabric does not register them (ADR-011). A broken or removed
webhook degrades latency, not correctness. The webhook handler stays small
enough to reason about as a security boundary, because it is not also an
artifact pipeline.

**Bad.** Without a webhook, a run can be up to one interval old before it
appears, and users read that as slowness. Two paths write results, so any change
to ingestion has to be checked from both. The "metadata now, detail on the next
sweep" split is a genuine surprise: a user who sees a run appear and opens it
expecting the per-test breakdown will find it missing for up to an interval, and
that has already been mistaken for a bug.

**Rejected: webhook-only.** It makes correctness depend on infrastructure Fabric
neither owns nor can monitor, and its failure mode is silence.

**Rejected: polling with no webhook at all.** This was the shipped state for
some time and it is defensible. The webhook was added because the interval is
the dominant term in "I pushed, where are my results", and that complaint is
about the product regardless of whose infrastructure is at fault.

## References

- `docs/qa/pipeline-results.md` — the sweep, the cursor, and the webhook wire format
- `docs/qa/qa-settings.md` — minting, rotating and revoking the endpoint
- ADR-011 — why Fabric does not register the webhook for you
