---
title: "A status field about runtime behaviour must ask the resolver, not infer from stored rows"
date: 2026-09-09
category: architecture-patterns
module: ai provider-resolution api web
problem_type: architecture_pattern
component: full_stack
severity: high
applies_when:
  - "A UI needs to know what a resolver will do, and the status endpoint reports only what is stored"
  - "Adding a field to a status payload whose neighbours describe configuration rather than outcome"
  - "A notice, badge or banner decides what to say by combining two or more fields from one response"
  - "A resolver has a fallback chain, so the thing it returns is not any single row a caller can read"
tags: [resolver, status-endpoint, provider-resolution, derived-state, tenant-scope, false-positive, byok]
related_components: [ai-config-status, ai-gateway, dynamic-model-selector, capability-banner]
audience: engineers adding a field that reports what runtime will do
owner: platform team
---

## Context

A notice had to tell a user that their AI provider could not serve embeddings. The status endpoint already returned everything that seemed necessary — which providers were configured, which was the default, which was assigned for embeddings — so the notice combined them and inferred the answer.

The inference was wrong in three reachable states, and each one made the product say something false to a user, in a change whose entire purpose was to stop the product saying something false.

The three fields were not the same kind of fact. Two described the **tenant's stored configuration**. One described **what this caller can reach**, and consulted the caller's own rows to answer. Combining them produced a sentence about neither.

## Guidance

**When a field answers "what will the runtime do?", compute it by calling the function the runtime calls. Do not re-derive it from the rows the runtime reads.**

The distinction is not stylistic. A resolver's fallback chain can land on an outcome that no single stored row represents:

```ts
// The runtime's embedding chain, roughly.
const dedicated = await getEmbeddingProviderConfig({ userId, organizationId });
if (dedicated.provider) return dedicated.provider;
return (await getAiProviderApiKey({ userId, organizationId })).provider;
```

Any UI-side reconstruction of that precedence is a second implementation of it, and the two drift the moment either changes — silently, because nothing compares them.

Three rules make the field trustworthy:

1. **Call, do not restate.** Import the resolver's own functions. A reimplementation "for the status endpoint" is the drift this pattern exists to remove.
2. **Say which kind of fact each field is.** A payload holding both stored configuration and resolved outcome must label them, or the next consumer will combine them again.
3. **Diverge deliberately, and write down why.** Stopping short of a rung is sometimes right — but only when the omitted rung provably cannot change the answer, and the reason belongs beside the code.

## Why This Matters

The three states the inference got wrong were all reachable, and none would have failed a test written from the stored fields:

- The tenant had enabled rows but none marked default, so the handler back-filled one from the first row it happened to load — a row the resolver's `findFirst({ isDefault: true })` never sees. The notice named a provider nobody chose.
- The tenant's default row was the right provider but carried no usable credential, so the resolver rejected it and fell through to the caller's own. The notice described a system that was working.
- The tenant had no rows at all and the caller's own default was the failing one. Every tenant-scoped field was null, so the notice stayed silent while the failure was real.

Two false positives and one false negative, from three fields that were each individually correct.

Asking the resolver closed all three at once, and closed a fourth gap that had already been accepted as out of scope — because the resolver consults the caller's own rows, and any reconstruction from tenant-scoped fields structurally cannot.

## When to Apply

Apply when a surface must predict a runtime decision: which provider, which model, which tier, which route, whether an operation will be refused.

Do **not** apply to fields that genuinely describe stored configuration. A settings form listing what a tenant has configured wants the stored rows, not the resolved outcome — those are different questions and both belong in the payload.

The tell that you are inferring: the consumer combines two or more fields with `&&`, and neither field alone answers the question being asked.

## Examples

Before — the consumer reconstructs precedence, and mixes two kinds of fact:

```ts
// `defaultProvider` and `embeddingProvider` describe the TENANT.
// `canResolveProvider` describes the CALLER.
return (
  status.defaultProvider === ANTHROPIC_PROVIDER_ID &&
  status.embeddingProvider === null
);
```

After — the endpoint reports the outcome, and the consumer reads one field:

```ts
// get-status.ts — computed by calling the runtime's own resolvers, and
// computed BEFORE the handler's default back-fill so it cannot inherit a
// provider the resolver would never pick.
resolvedEmbeddingProvider: z.string().nullable(),

// the consumer
return status.resolvedEmbeddingProvider === ANTHROPIC_PROVIDER_ID;
```

Two costs worth accepting, and one worth refusing.

Accept the extra reads: this endpoint gained two, on a query the client caches for a minute. Correctness by construction is worth more than an inference that is free and wrong.

Accept the divergence, once documented: the runtime's last rung reaches the deployment's own platform key. This field deliberately stops before it, because that rung is hardcoded to a gateway identifier and can never be the provider a caller needs warning about — while following it would run a synchronous key derivation on an endpoint the app shell hits on every page load, and would disclose to every tenant that the platform key exists.

Refuse to let the new reads widen the blast radius: several surfaces read this endpoint and treat a failed call as "not configured", so the extra reads are wrapped and degrade the new field to null rather than failing the payload.

## Prevention

- A payload mixing stored configuration with resolved outcome should say so in the field's own doc comment. The reviewer who catches the next inference will be reading that comment, not the handler.
- A test that mocks both resolvers pins the order the helper calls them in — not that the order matches the runtime. If the correspondence matters, say in the test that it is unpinned, or pin it where both sides can be exercised.
- Watch for a mock that returns something the real function cannot produce. One test here asserted an organization-sourced result against a fixture whose only organization row was not the default — the real resolver reads only default rows, so the mock had quietly licensed a false premise.
