---
title: "Query invalidation keys are derived, never hand-built — a wrong one matches nothing and says nothing"
date: 2026-08-04
category: conventions
module: web saas shared data layer
problem_type: convention
component: frontend
severity: high
applies_when:
  - "Writing `queryClient.invalidateQueries` after a mutation"
  - "A surface renders from more than one query and a mutation changes state all of them display"
  - "An optimistic control reverts to its previous state after a successful write"
tags: [tanstack-query, invalidate-queries, query-keys, orpc, tenant-isolation, optimistic-ui, silent-failure]
related_components: [projects, navigation]
---

# Query invalidation keys are derived, never hand-built

## Context

This repository registers query keys in three different shapes, and nothing at
the type level stops you from writing a filter that matches none of them:

| Shape | Produced by | Actual key |
|---|---|---|
| oRPC procedure | `orpc.<path>.key()` / `.queryKey()` | `[["projects","list"], { input, type }]` |
| Tenant-scoped | `createTenantQueryKey(orgId, base)` | `["tenant", orgId, ...base]` |
| Hand-rolled | a literal array in the calling file | whatever was typed |

While adding quick-access project shortcuts (#1694), a single mutation needed to
invalidate four queries across all three shapes. Three of the four filters were
written by hand and **every one of them matched nothing**. None produced an
error, a warning, or a failing test.

`docs/solutions/` already carried the related war story about flat versus nested
oRPC keys. This entry is the generalisation that case did not state: the problem
is not one wrong shape, it is that hand-authoring the filter at all is the
defect, because the repository has more than one shape and the failure is silent
in all of them.

## Guidance

**Never type a query key literal into an `invalidateQueries` call. Derive it
from the same helper that registered the query.**

```ts
// Wrong — three separate silent no-ops.
queryClient.invalidateQueries({ queryKey: ["projects"] });
queryClient.invalidateQueries({ queryKey: ["projects", "shortcuts"] });

// Right — each key comes from whatever registered that query.
queryClient.invalidateQueries({ queryKey: orpc.projects.list.key() });
queryClient.invalidateQueries({
  queryKey: orpc.projects.get.key({ input: { id: projectId } }),
});
queryClient.invalidateQueries({
  queryKey: createTenantQueryKey(organizationId, PROJECT_SHORTCUTS_BASE_KEY),
});
```

Export the base key from the module that owns the query, so a caller never has
to reconstruct it:

```ts
// use-project-shortcuts.ts
export const PROJECT_SHORTCUTS_BASE_KEY = ["projects", "shortcuts"] as const;
```

**Enumerate every query that renders the state you changed, not just the obvious
one.** The same star control renders from three different reads — the projects
grid, the project detail page, and the "Shared with me" grid, which is a
*separate* query. Adding a field to a read is the moment to ask which query
registered it.

## Why This Matters

TanStack's `partialMatchKey` compares the filter against the real key
**positionally from index 0**, recursing into arrays and objects:

- `["projects"]` against `[["projects","list"], {…}]` — index 0 compares the
  string `"projects"` against the array `["projects","list"]`. No match.
- `["projects","shortcuts"]` against `["tenant", orgId, "projects", "shortcuts"]`
  — index 0 compares `"projects"` against `"tenant"`. No match.
- `[["projects","get"], { input: { id } }]` against
  `[["projects","get"], { input: { id, organizationId }, type }]` — **matches**,
  because object comparison is a recursive subset test. A filter may carry
  *fewer* object keys; it may not carry a *different* array prefix.

A non-matching filter is not an error condition — it means "invalidate the zero
queries that matched." So the failure presents as a UI bug with no stack trace:
an optimistic control flips immediately, the mutation succeeds, then the control
reverts to a prop backed by a query that was never refetched. The user sees a
star fill and then quietly empty itself.

This is also why the surrounding components appear to work with hand-built keys.
`ProjectCard` and `ProjectsListView` call `invalidateQueries({ queryKey:
["projects"] })` and still refresh — not because the filter matches, but because
they also call an `onUpdate()` callback that triggers an explicit `refetch()`.
Copying the invalidation line without the callback inherits a no-op.

## When to Apply

- Any `invalidateQueries`, `cancelQueries`, `getQueryData`, or `setQueryData`
  call — all four take the same filter and fail the same silent way.
- Especially when the mutation lives in a shared component used by several host
  surfaces, since each host may register its data differently.
- When adding a field to an existing read: find every query that serves that
  field before assuming one invalidation covers them.

## Examples

A regression test pins the derived key so a future refactor cannot quietly
flatten it:

```ts
it("invalidates the shortcut query under its tenant-prefixed key", async () => {
  const { invalidate } = renderToggle({ isFavorite: false });

  await userEvent.click(screen.getByRole("button"));

  await waitFor(() => {
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["tenant", "org-1", "projects", "shortcuts"],
    });
  });
});
```

Asserting the *expanded* key rather than the helper call is deliberate: it fails
if the shape changes, which is the thing that actually breaks.

One related timing rule, since it produces the same symptom for a different
reason. Invalidate in `onSuccess` and let TanStack await it before `onSettled`
clears the optimistic value — otherwise the control falls back to a stale prop
in the window before the refetch lands:

```ts
onSuccess: async () => {
  await Promise.all([/* invalidations */]);
},
onSettled: () => {
  setOptimistic(null);
},
```

Invalidating in `onSettled` also fires on the error path, refetching queries
that nothing changed.
