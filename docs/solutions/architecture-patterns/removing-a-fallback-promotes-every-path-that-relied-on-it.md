---
title: "Removing a fallback promotes every path that relied on it"
date: 2026-09-04
category: architecture-patterns
module: ai provider-resolution temporal api
problem_type: architecture_pattern
component: full_stack
severity: high
applies_when:
  - "Removing a default, allowance, or fallback that quietly stood behind a failure path"
  - "A refusal that used to be rare is about to become the normal outcome for a class of tenant"
  - "Splitting one resolver into a permissive and a strict half, where call sites choose by which symbol they import"
  - "A change's own commit message claims a property that holds for the call sites you inspected"
tags: [fallback-removal, byok, provider-resolution, refusal-path, blast-radius, resolver-split, retry-policy, error-mapping]
related_components: [ai-gateway, dynamic-model-selector, temporal-workflows, atlas, ai-config-status]
audience: engineers removing a default that other code silently depends on
owner: platform team
---

## Context

Fizzy #1875 removed a platform-funded AI allowance so that a user-facing AI
operation runs on the tenant's own provider key or does not run at all. The
mechanism was sound and reviewed: two named resolvers, a tenant-facing one that
cannot reach the deployment's gateway key and a system one that can, so a call
site picks a policy by importing a name rather than passing a flag.

The change landed green — 66/66 type-check, knip and lint clean, ~26,000 tests
passing — and a multi-persona review plus a cross-model adversarial gate then
found **seven** defects in the same shape. Not seven mistakes in the new code:
seven places where correct-looking existing code became wrong because the
fallback that had been absorbing its failure was gone.

That pattern, not the AI specifics, is the durable part.

## Guidance

**Removing a fallback does not only change behaviour. It changes the frequency
of every code path the fallback was hiding.**

Before the change, a tenant with no provider key was served by the platform.
The "no provider configured" path existed, was tested, and essentially never
ran. After the change it is the normal outcome for every keyless tenant. Code
that was correct-in-principle but never exercised went to
exercised-on-every-request in a single deploy.

So the audit that matters is not "did I update every call site of the thing I
changed?" — that one is mechanical and type-checked. It is:

> **Which paths did this fallback keep rare, and are they each correct at
> volume?**

The seven findings, all instances of that question going unasked:

| What was found | What the fallback had been hiding |
|---|---|
| Atlas mapped the same condition to `BAD_REQUEST` while two procedures said `PRECONDITION_FAILED` | The refusal reached a shared error map that nobody had needed to look at |
| Two Temporal workflows had no non-retryable classification for a configuration error | A deterministic refusal spent a full retry budget, which nobody noticed while refusals were rare |
| The duplicate scan never checked whether the resolver returned credentials | An empty model string marked the whole corpus stale and shipped every item to the embedder to fail there |
| A status field asked "does ANY row carry a credential" while the resolver reads only the default row | The two only disagree for a tenant the resolver refuses — previously, nobody was refused |
| Image generation resolved on the system half | Every caller has a person waiting; it was the most expensive call in the product |
| Chat retrieval embedded the user's message on the platform key before generation refused | Spending on a request that will be refused only costs money once refusals exist |
| A credential-reading rule had a test for one branch and not the other | Both branches returned the same answer while a fallback stood behind them |

**Three checks that would have caught most of them:**

1. **Enumerate the refusal's consumers, not the change's call sites.** Grep for
   the error type, the error code, and the sentinel value the refusal produces —
   then ask what each consumer does at volume. Retry policies, error maps, and
   cache-staleness comparisons are the usual suspects, and none of them appear
   in a diff of the thing you changed.
2. **Re-read the rule's justification, not its category.** The system resolver
   is for embedding *because indexing is background work*. Direct-chat retrieval
   is an embedding step, so it inherited the exemption — but a chat turn is not
   background work. A rule applied by its category outlives its reason.
3. **Check the claim against the paths, not the paths against the claim.** The
   commit said "user-facing AI runs on the tenant's key". The honest test is to
   enumerate what a user can trigger and check each one, which is how the
   remaining holes were found. Checking the paths you changed only confirms the
   ones you already thought about.

## Why This Matters

A green test suite is evidence about the paths tests exercise, and the paths a
fallback keeps rare are exactly the paths a suite under-covers — the fallback
was making them pass. So the moment of highest risk in this kind of change is
also the moment the usual signal is least informative.

The blast radius is also asymmetric in a way that hides it. Each of the seven
findings is individually small and locally defensible; several had comments
explaining why they were fine. They were fine. What changed was the traffic.

## When to Apply

Any change that removes or narrows something absorbing failures for other code:
a default credential, a free tier, a permissive-mode flag, a retry that masked a
downstream error, an `?? fallbackValue` that stopped a null from propagating.

The tell is a sentence of the form *"X only happens when Y, and Y is rare"* —
where the change makes Y common.

## Examples

Narrow rather than delete, so the two halves stay nameable (this repo's existing
[reversing a safety invariant](reversing-a-safety-invariant-narrow-it-do-not-delete-it.md)
pattern, which this work followed):

```ts
// One resolver, one policy, and no way to ask for the other.
getAiProviderApiKey({ userId, organizationId });      // tenant only
getSystemAiProviderApiKey({ userId, organizationId }); // may reach the platform key
```

A flag was explicitly rejected for this: `getKey({ allowPlatform: true })` makes
fourteen call sites each restate a policy judgement, and a reviewer cannot tell a
considered `true` from a copied one. With two names, the wrong choice is visible
in an import.

The residual weakness is worth stating: the split is enforced by which symbol a
call site imports, so a new caller can copy the wrong one from a neighbour. What
actually caught the misplaced call sites here was not the naming but tests that
named the expected resolver in their module mocks — renaming a call site's
resolver failed them. That is the enforcement worth adding deliberately rather
than relying on it existing by accident.

## Related

- [Reversing a safety invariant: narrow it, never delete it](reversing-a-safety-invariant-narrow-it-do-not-delete-it.md) — the shape this change followed
- [A trust boundary has more than one axis](../security-issues/a-trust-boundary-has-more-than-one-axis.md) — for the tenant/role reasoning around who a refusal applies to
- `CONCEPTS.md` § BYOK — the vocabulary this change introduced
- [Where a sign-in decides which organization to open](../post-login-organization-resolution.md) — the other half of the same branch
