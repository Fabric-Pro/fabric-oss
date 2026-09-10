---
title: "Failing closed can remove the check that was containing it"
date: 2026-09-09
category: architecture-patterns
module: api auth tenant-context
problem_type: architecture_pattern
component: authentication
severity: high
applies_when:
  - "Routing a request into a fail-closed or 'safe' state instead of refusing it outright"
  - "A middleware resolves a value that a later middleware branches on, and the resolution can now produce a different branch than before"
  - "The containment for a bad state is a downstream check rather than the boundary itself"
  - "A tenant, permission, or role check has an early-return arm for the 'nothing resolved' case"
tags: [fail-closed, tenant-isolation, middleware, authorization, permission-bypass, adr-018, orpc, defence-in-depth]
related_components: [tenant-context-middleware, require-permission, resolve-organization-id, better-auth-session]
audience: engineers hardening a boundary that other layers branch on
owner: platform team
---

## Context

Fizzy #2403 hardened `tenantContextMiddleware`. A session can name an organization the caller has since been removed from — resolution and session insertion are not atomic, and offboarding clears only the sessions that exist when it runs. Before the change the middleware built an **organization context** for that request and left the caller's role `null`; tenant filtering then ran against a workspace the person had left.

The obvious hardening is to stop trusting the pointer: when the membership lookup finds nothing, resolve **no** workspace. That is what the first cut did, and it reads as the fail-closed choice. It was the opposite.

Two independent reviewers, and then a check of the code itself, found that it converted a denial into a pass-through.

## Guidance

**Before you route a bad state into a "safe" context, find out what was containing that state, and check whether the safe context still triggers it.**

The containment here was not the boundary. It was `requirePermission`, one layer down:

```ts
// packages/api/orpc/middleware/require-permission.ts
if (!context.tenantContext || context.tenantContext.type === "personal") {
    return next();          // no role evaluated at all
}
const granted = resolveOrgPermissions(context.activeOrganizationRole);
if (!hasPermission(granted, permission)) {
    denyPermission(/* ... */);   // FORBIDDEN
}
```

So the two shapes produce opposite outcomes for the same broken session:

| Tenant context handed down | Role | `requirePermission` | Result |
|---|---|---|---|
| organization (before) | `null` | evaluates `resolveOrgPermissions(null)` → empty | **FORBIDDEN** |
| personal (the "safe" cut) | `null` | early-returns `next()` | **allowed** |

And the organization id was not gone from the request — only from the tenant context. `resolveOrganizationId` reads `session.activeOrganizationId` directly, and the middleware forwards `context.session` untouched, so a handler still resolved the workspace the caller had left.

**The fix was to refuse, not to downgrade** — and to refuse narrowly. A session naming *no* workspace keeps its previous behaviour, because that arm is legitimately reached by account-global procedures. Only the case the caller cannot justify — naming a workspace they hold no membership in — throws:

```ts
if (namedOrganizationId && !hasMembership) {
    recordRequestWithoutWorkspace(missingWorkspaceRecord);   // before the throw
    throw new ORPCError("FORBIDDEN", {
        message: "This operation requires an organization context",
        data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
    });
}
```

## Why This Matters

A boundary that *narrows* what it hands downstream is not automatically safer. Downstream code branches on what it receives, and "less" can select a more permissive branch. That is exactly what a personal/empty/null tenant context does in a codebase where the permissive arm exists for a legitimate reason — here, procedures that are account-global and have no role to evaluate.

The trap is sharpened by intent. The change was made *because* `docs/adr/018-organization-is-the-only-tenant-context.md` calls the personal arm a fail-closed default that code should treat as a bug. Routing more traffic into an arm the ADR describes as fail-closed feels like compliance with it. The ADR's own wording is the safer reading: it is a default reached when something failed, **not a supported context** — so the answer to reaching it deliberately is to refuse, not to route into it.

Note also what the middleware's own comment claimed after the first cut: that containment had moved from each procedure to the boundary. It had not. It had moved *off* each procedure and not arrived at the boundary — the worst of the two positions, and the comment made it read as the best.

## When to Apply

Whenever a change makes a boundary produce a different value for a case it used to pass through — a null tenant, an empty scope, an absent role, a missing capability. Ask three questions in order:

1. **What actually refused this before?** If the answer is a downstream check rather than the boundary, the downstream check is the thing you are about to change, whether you meant to or not.
2. **Does the new value still reach that check's refusing branch?** Read the branch, do not infer it from the value's name. `personal`, `none`, `null` and `empty` are all words that sound restrictive and select permissive arms in real code.
3. **Did the value actually leave the request, or only leave one field of it?** Here the tenant context lost the organization while `context.session` still carried it, and `resolveOrganizationId` reads the session.

The general form: **narrowing what you pass is not the same as refusing.** If the caller has named something they hold no right to, refuse; reserve the fail-closed context for callers who named nothing.

## Examples

The test that would have caught it runs the real middleware and feeds its own output into the real permission middleware, rather than stopping at the shape of the context object:

```ts
// packages/api/__tests__/tenant-context-missing-membership.test.ts
it("denies a caller whose session names a workspace they have left", async () => {
    mocks.memberFindUnique.mockResolvedValue(null);

    const outcome = await runTenantThenPermission(
        makeCtx("session-stale-chain", ORG_ID),
    );

    expect(outcome.verdict).toBe("denied");
    expect(outcome.permissionNext).not.toHaveBeenCalled();
});
```

Both new middleware suites originally stopped at `expect(passed.tenantContext).toEqual(createPersonalContext(USER_ID))` — an assertion that was *true* under the broken shape. The chain test also pins the premise directly, so the reason the refusal exists cannot quietly stop being true:

```ts
it("shows why a personal downgrade could not stand: that arm is a pass-through", async () => {
    // personal context + null role -> next() runs, no role evaluated
    // organization context + null role -> FORBIDDEN
});
```

Related, and worth reading together:

- `docs/solutions/architecture-patterns/removing-a-fallback-promotes-every-path-that-relied-on-it.md` — the same blast-radius question asked from the other side: which paths did this fallback keep rare?
- `docs/solutions/conventions/a-normalizer-is-not-a-gate.md` — why a resolver that always produces a value cannot be the gate; `tenantContextMiddleware` was exactly that shape.
- `docs/solutions/architecture-patterns/reversing-a-safety-invariant-narrow-it-do-not-delete-it.md` — the personal arm was narrowed, not deleted, for the reason ADR-018 gives.
- `docs/solutions/integration-issues/a-database-write-cannot-reach-a-cached-session.md` — the cookie-cache mechanism behind the stale pointer this gate exists for.
