# ADR-018: An organization is the only tenant context

- **Status**: Accepted
- **Date**: 2026-08-31
- **Deciders**: Engineering team, Product
- **Amends**: [ADR-003](003-xor-tenant-isolation.md) — its XOR rule stands; its premise that personal is one of two reachable contexts does not
- **Audience**: engineers working on tenancy, authorization, routing or migrations
- **Owner**: Platform

## Context

ADR-003 assumed two tenant contexts, filtered exclusively: an organization, or a
personal one keyed by `organizationId: null`. Every feature therefore had to be
built twice, and the personal arm was where isolation work went to rot — it is
the arm that has no organization to check a role against, so a permission check
written for the organization case silently degraded to "allow" when the caller
was personal. Twenty-nine such checks could not evaluate at all; the audit in
[`docs/personal-context-surface-map.md`](../personal-context-surface-map.md)
enumerates them and everything else the context reached.

Product ruled that personal context is not a product surface anyone is entitled
to keep: no data migrates, and the rows are dropped.

## Decision

**Every account belongs to an organization, and an organization is the only
context anything resolves into.**

- An organization is created at signup, and backfilled at sign-in for accounts
  that predate the rule. There is no account without one.
- The session carries its organization. A resolver that cannot name one fails
  closed rather than falling through to a personal context.
- A caller who names an organization is honoured only after a tie to it is
  confirmed. A *tie*, not a membership: a project-scoped guest has object-level
  access to one project inside an organization they are not a member of, and
  refusing them would be a regression rather than a boundary. A caller with
  neither tie is refused, so naming a tenant you have no relationship with gets
  nowhere.
- The personal route trees, settings tree and interface strings are gone, each
  tree leaving a redirect into the caller's organization.

## What this does not change

- **The XOR rule itself.** Never `OR` two tenant predicates. `tenantProtectedProcedure`
  and `resolveOrganizationId()` remain the way to scope a query.
- **RLS.** Database-level enforcement is unchanged, as are the `rls*` suites.
- **`organizationId` threading.** It still has to reach Temporal workflows, MCP
  clients and activities; nothing about that got easier.
- **The four account-global models** that encode tenancy as `organizationId String @default("")`.
  They describe an account rather than a tenant and keep doing so.
- **Object storage and the vector store.** Their tenancy is derived from key
  prefixes and collection membership, not from a relational column, so no
  relational change reaches them.

## Consequences

- The personal arm of `getTenantFilterFromContext` still exists in code and is no
  longer reachable for user-facing tenancy. It is retained as a fail-closed
  default, not a supported context — **a new feature must not route into it**, and
  code that finds itself there should treat it as a bug in whatever failed to
  resolve an organization.
- A permission check now always has an organization to evaluate against, which is
  what made the twenty-nine inert ones fixable.
- A project-only guest is rooted in their own organization; the organization
  hosting the project they were invited to is named nowhere in their chrome.
- Personal rows are dropped, not migrated. The job is two-phase and its dry run
  is read before either phase runs.

## Alternatives considered

- **Migrate personal data into the new organization.** Refused twice by Product,
  the second time with a staging inventory in hand. It buys nobody anything: the
  rows are unused, and moving them imports their tenancy bugs into the surviving
  context.
- **Keep personal context for a subset of features.** This is the status quo
  under another name — the cost is the second code path, not the number of
  features on it.
- **Delete the personal arm from the type entirely.** Rejected for now: as a
  fail-closed default it is doing useful work, and removing it turns a refusal
  into a crash at every site that has not yet been proven unreachable.
