# Where a sign-in decides which organization to open

**Ticket:** Fizzy #1875 (regression surfaced during the org-only elimination)
**Related:** #1477 (multi-tab refresh safety)
**Status:** fixed

This document exists because the first diagnosis of "login opens the wrong
organization" named the wrong mechanism, and the wrong mechanism is a plausible
enough reading of the code that the next person will reach for it too. What
follows is what the code actually does.

## The correction

The original report said `seedSessionOrganization` never consults
`user.lastActiveOrganizationId`, pointing at its early return:

```ts
if (session.activeOrganizationId) {
    return null;
}
```

That early return only fires for a session that **already holds** an
organization. It is a "do not overwrite a deliberate placement" guard, not a
skip. A freshly created session row carries no organization — the field was only
ever written by an explicit switch — so on sign-in the seed **does** run, and it
**does** consult the last-active pointer through `resolveUserOrganization`.

So "last-active is never consulted" does not hold, and a fix aimed only at that
would have changed nothing for most users.

## What actually put people in the wrong place

Two independent causes, neither of which is the seed.

### 1. The fail-closed path leaks into an arbitrary landing

`resolveUserOrganization` deliberately refuses to guess. A user with several
memberships whose last-active pointer is unset, or names an organization they
have since left, returns `ambiguous` — the correct answer for a resolver whose
job is authorization.

But the caller had no fallback of its own. The seed wrote nothing, the session
stayed empty, `resolveLastActiveWorkspace` also returned null, and the
post-login hop fell through to `organizations[0]`.

`organizations[0]` was not stable. Better Auth 1.6.22's `listOrganizations`
(`dist/plugins/organization/adapter.mjs:367`) issues a `findMany` on `member`
with no sort clause, so Postgres returns those rows in whatever order the plan
yields — which drifts with the plan, with vacuum, and after row updates. Two
sign-ins with no data change between them could land in different places.

A fail-closed resolver is only as good as what the caller does with the refusal.
Here the refusal was converted into a coin flip one frame up the stack.

### 2. The durable record could be lost without a trace

The workspace switcher persisted `user.lastActiveOrganizationId`
fire-and-forget behind an empty `.catch()`, commented "non-critical
persistence".

It is not non-critical. Session seeding *derives* from that field, so it is the
only durable record of where a person works. One failed request discarded it
silently — no error, no log, nothing in the UI — and the next sign-in opened the
organization they had switched away from. The user experiences this as "the app
forgot", with nothing anywhere to explain it.

This is the more likely cause of the original report, and it was filed as the
secondary finding.

## The third hazard, introduced by the fix

Reordering the post-login hop to prefer the durable record creates a problem the
old order did not have.

`tenantContextMiddleware`
(`packages/api/orpc/middleware/tenant-context-middleware.ts`) builds the oRPC
tenant context from `session.activeOrganizationId`. Redirecting to
`/app/{slug}` on the strength of the last-active pointer, without writing the
session, would leave the page rendering one organization while every API call it
makes runs against another.

Any change to where the post-login hop sends someone **must** align the session
with the destination. The alignment write is best-effort — a sign-in must not
become an error page over a default — but it is not optional.

## What the code does now

On the post-login hop only (`?postLogin=1`), in order:

1. `user.lastActiveOrganizationId`, if it still names a membership — the durable,
   per-user record of where the person was working.
2. `session.activeOrganizationId`, if it names a membership — one last-write-wins
   value, shared by every tab on that session, which can outlive several
   switches. Right for a first sign-in or a fresh device; stale otherwise.
3. The lowest-id membership — sorted, matching the tiebreak
   `resolveUserOrganization` already applies, so the last resort is at least
   reproducible.

Then the session is aligned to whichever won, and only then does the redirect
fire.

Two invariants hold this together:

- **All of it stays inside the `?postLogin=1` guard.** A bare `/app` load reads
  neither source. `session.activeOrganizationId` is shared across tabs, so
  reading it on an ordinary load is what let a refreshed tab get hijacked into
  whatever organization another tab last activated (#1477). The post-login hop
  is safe because it is transient — it never rests on `/app`.
- **`redirect()` is called outside every `try`.** Next.js reports a redirect by
  throwing; a `catch` around it swallows the navigation and renders the page
  instead.

The switcher's write is now retried three times with a short backoff, abandons
itself when a newer switch supersedes it, and logs a genuine exhaustion.

## Residual, known and accepted

A single in-flight persist cannot be cancelled. If the first attempt is slow and
lands after a newer switch has already persisted, it can still win. That is the
original one-round-trip window, unchanged; closing it needs an `AbortSignal`
threaded through the oRPC client. What the supersession guard removes is the
~900ms window the retry itself introduced — comfortably inside human switching
speed, and so a genuine regression if left.

## Pinned by

- `apps/web/__tests__/organizations/personal-app-start-page.test.tsx` — source
  precedence, the alignment write and its failure path, the sorted last resort,
  and the bare-`/app` invariant.
- `apps/web/modules/saas/organizations/components/__tests__/ActiveOrganizationProvider.switch.test.tsx`
  — retry, supersession, and the log-on-exhaustion boundary.
