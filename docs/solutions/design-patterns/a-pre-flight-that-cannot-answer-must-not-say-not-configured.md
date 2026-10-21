---
title: "A pre-flight that cannot answer must not say \"not configured\""
date: 2026-10-21
category: design-patterns
module: apps/web context-sources url-source pre-flight
problem_type: design_pattern
component: frontend
severity: medium
applies_when:
  - "A client query decides whether a form may submit, and the server re-checks on submit anyway"
  - "A notice says something is missing or not configured, based on a query result"
  - "A query result is read as `data?.flag ?? false`"
  - "A gate or notice reads `isLoading || isFetching` from TanStack Query"
  - "A notice tells the viewer to change settings that only some roles can change"
tags: [pre-flight, tanstack-query, query-state, false-negative, not-configured, retry, permissions, notice]
related_components: [context-sources, url-source, search-providers, add-context-dialogs]
audience: Engineers adding a client-side check that gates a form or shows a configuration notice
owner: platform team
---

# A pre-flight that cannot answer must not say "not configured"

## Context

Fizzy #3068 read "Unable to add context using the link option". The Link tab of the add-context dialogs runs a pre-flight that lists the organization's search providers, then shows a "configure a search provider" card and disables submit when none can read pages.

The pre-flight kept one boolean, `data?.hasAnyScrapeCapable ?? false`. Five different situations produced the same card and the same disabled button:

| Situation | What the card said | What was true |
|---|---|---|
| No provider rows | not configured | not configured |
| A provider saved with its key, switched off | not configured | configured, needs turning on |
| Only a search-only provider (Parallel, YouTube) | not configured | connected, cannot read pages |
| The request failed (the app's QueryClient has `retry: false`) | not configured | unknown |
| A project guest, refused with FORBIDDEN | not configured | unknown, and not the guest's to fix |

The server checks again on submit and answers with typed codes (`SCRAPE_PROVIDER_NOT_CONFIGURED`, `CRAWL_PROVIDER_NOT_CONFIGURED`), so the client gate only ever needed to stop a submit it was sure would fail. For a member, the card also linked to settings that only an organization admin can change.

This is the client-side form of [A surface must not report absence it did not verify](./a-surface-must-not-report-absence-it-did-not-verify.md).

## Guidance

**Keep "I don't know" apart from "no".** Derive a status, not a boolean, and let only a confirmed negative block:

```ts
type PreflightStatus = "checking" | "failed" | "unchecked" | "missing" | "ready";
// failed / unchecked: no card that claims anything, submit stays open,
// the server decides and its typed code drives the notice.
```

**Map an expected refusal to "no verdict", not to an error.** A guest who may not list the providers gets the same answer on every retry, so an error card with "Try again" would loop. Return `null` from the `queryFn` for an `ORPCError` with code `FORBIDDEN` and treat `null` as `unchecked`.

**A cached answer that would let the user through can outlive a failed refetch; one that blocks cannot.** TanStack Query v5 keeps `data` when a refetch fails and sets `isError`. Keep a cached "ready": the server re-checks anyway. Turn a cached "missing" into "failed": it may describe a provider connected since, and keeping it leaves a disabled button with nothing to retry.

**With no data, a refetch resets the query to `pending` and clears `error`.** During "Try again" after a first failure, `isError` is false and the status flips back to "checking": the error card and its button unmount and submit locks. `errorUpdateCount` is not reset by a fetch, so `errorUpdateCount > 0` keeps the status at "failed" while the retry runs. Mark the button `aria-busy` rather than disabled, so keyboard focus stays on it.

**Don't gate a verdict on `isFetching`.** `isLoading || isFetching` hides a confirmed card on every window-focus refetch and shows it again afterwards. Use the first-load state for "checking" and nothing else.

**Point only those who can fix it at the fix.** Decide by the organization role the server checks (`userRole` admin or owner), not `isOrganizationAdmin`, which also admits platform admins. Everyone else is told to ask an organization admin, without a link. That includes server-supplied hints: a bulk row's error message from the server named the settings page too.

## Why This Matters

A false "not configured" is believed. The reporter quoted the card and filed it as broken, because the card claimed a state it never checked and gave a step the reader could not take. A request that failed for one second locked the form until the dialog was reopened.

## When to Apply

- a client query gates a submit that the server validates anyway;
- a notice states that something is missing, off, or unconfigured;
- a query reads `?? false`, `?? []`, or `?? 0` into a decision;
- a notice links to settings and the surface is open to more than one role.

## Examples

Before:

```ts
const hasAnyScrapeCapable = query.data?.hasAnyScrapeCapable ?? false;
const showNotice = noticeOverride !== null || (!preflightLoading && !hasAnyScrapeCapable);
```

After (`apps/web/modules/saas/context-sources/hooks/use-url-source-form.ts`):

```ts
function preflightStatusOf(query) {
  if (query.data === undefined) {
    return query.isError || query.errorUpdateCount > 0 ? "failed" : "checking";
  }
  if (query.data === null) return "unchecked";
  if (query.data.hasAnyScrapeCapable) return "ready";
  return query.isError ? "failed" : "missing";
}
```

Tests that pin each state were each checked against the code they guard: revert the source, watch the test fail, restore. The retry-in-flight case only fails against the old code with a deferred promise; a retry that resolves at once passes either way.
