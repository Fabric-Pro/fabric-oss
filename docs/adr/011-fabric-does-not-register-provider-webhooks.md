# ADR-011: Fabric Does Not Register, Update or Remove Provider Webhooks

- **Status**: Accepted
- **Date**: 2026-07-29
- **Deciders**: Engineering team
- **Audience**: Engineers working on QA result ingestion or any Fabric feature holding a customer repository token
- **Owner**: Fabric platform

## Context

Fabric can accept inbound QA result webhooks (ADR-010). Setting one up is a
manual, multi-step chore: mint the secret in Fabric, open the provider, paste a
URL, paste a secret, pick the right events, choose the right content type.

Fabric already holds a repository credential with enough scope to do all of that
by API. Every competitor in this space does exactly that, and the onboarding
difference is real — "click Connect" versus a page of instructions.

The reason not to is not technical difficulty. It is that **the customer's CI
configuration is their infrastructure, and silently mutating it is a trust
boundary Fabric has decided not to cross.** This is the same ruling that already
governs CI config: Fabric generates a snippet for the user to commit and
deliberately does not write it into their repository, because "a tool that
silently commits CI config is a tool nobody can trust with a repo token".

Auto-registration is worse than the config case, not better:

- It is **invisible**. A commit shows up in review; a webhook created by API
  appears in a settings page nobody opens.
- It is **stateful and drift-prone**. Fabric would then own a registration it
  must reconcile forever — detect manual edits, handle a repo rename, clean up
  on disconnect. Every one of those is a new failure mode in someone else's
  system.
- It **escalates what the token means**. A token granted so Fabric can read
  results would now be a token that reconfigures the repository. Users reason
  about scopes; they do not read our source to discover what we do with them.
- On a shared repo it is **not the connecting user's decision to make**. One
  project member connecting a repo would change behaviour for everyone.

## Decision

**Fabric never creates, updates or deletes a webhook registration on GitHub,
GitLab or Azure DevOps.** It mints the endpoint and secret on its own side,
shows the exact values and per-provider instructions, and the customer performs
the registration in their own change process.

The same rule already applies to CI configuration: Fabric generates, the
customer commits.

## Consequences

**Good.** The repository token is only ever used for reading. Nothing Fabric
does to a customer's provider account is invisible to them. There is no
registration state to reconcile, so a repo rename, a manual edit or a revoked
webhook cannot put Fabric into a lying state — the sweep keeps working
regardless (ADR-010).

**Bad.** Onboarding has a manual step, and some users will not take it — those
projects run at sweep latency and may never know a faster path existed. The
setup instructions are per-provider copy that has to be maintained. This is a
real, measurable product cost accepted deliberately.

**Revisiting this** would need, at minimum: an explicit in-product consent step
naming what will be created, an audit event for the creation, visible ownership
of the registration in Fabric's UI, and reconciliation for drift and
disconnection. "We already have the token" is not sufficient justification on
its own.

## References

- ADR-010 — pull-based ingestion; why a missing webhook is not a correctness problem
- `docs/qa/pipeline-results.md` — the equivalent no-write ruling for CI configuration
- `docs/qa/qa-settings.md` — what the user is asked to do by hand
