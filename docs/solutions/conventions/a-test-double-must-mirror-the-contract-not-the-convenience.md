---
title: "A test double must mirror the contract, not the convenience"
date: 2026-08-18
category: conventions
module: api projects documents tests mocks vitest
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Writing a mock or double for something with a non-trivial shape — a discriminated union, a row with relations, a module with more than a couple of exports"
  - "Hand-listing a mocked module's exports instead of passing the real module through with importActual and overriding one export"
  - "Mocking a Prisma query result without every relation the real query's select requests"
tags: [test-doubles, mocking, vitest, contract-fidelity, prisma-mocks, fizzy-2190]
related_components: [documents, testing]
audience: engineers writing mocks and fixtures for typed contracts
owner: web app team
---

# A test double must mirror the contract, not the convenience

## Context

Three test doubles in one feature were more permissive than the thing they stood
in for, and each hid the mismatch it existed to catch.

A mock returned a bare string where the real type is a discriminated object. The
production code compared the whole value to that string — a comparison that can
never be true against the real type — and the test passed, because the mock
returned exactly the shape the broken comparison expected. The type checker caught
it; the test never would have.

A module mock returned a hand-listed subset of its exports. Adding one import to
the code under test broke every test in the file with a missing-export error,
because the double had been written to satisfy today's call sites rather than to
stand in for the module.

A mock returned a database row without the relation the query selects. The
production code read that relation and got `undefined`, and only failed once the
query changed to select it.

## Guidance

A double's job is to be **indistinguishable from the real thing in every way the
code under test can observe**. Convenience is not a reason to diverge; a double
shaped for convenience tests the double.

Three rules that cover most of it:

- **Return the real shape.** If the contract is a discriminated union, the double
  returns a discriminated union — not the string one of its members happens to
  carry. Derive the fixture from the exported type where possible so a contract
  change breaks the double loudly.
- **Pass the module through when you only need one export replaced.** Prefer
  `importActual` and override the specific function over hand-listing the exports
  you currently use. A hand-listed subset is a maintenance trap that fires on an
  unrelated import.
- **Mirror the query, not the call site.** When a double stands in for a data
  fetch, its return must carry every field the query selects — including relations
  — not just the ones today's code reads.

## Why This Matters

The whole reason to write a double is to exercise the code under test against its
contract without the real dependency. A permissive double inverts that: the code is
exercised against the double's contract, which is whatever was convenient when the
test was written. When the two disagree, the test reports agreement.

This is worse than an absent test, because the failure it hides is precisely the
contract mismatch a reader assumes the test rules out. In the case here, a feature
was dead in production and the suite was green.

## When to Apply

Whenever a double stands in for something with a non-trivial shape: a discriminated
union, a row with relations, a module with more than a couple of exports, a
response envelope. Skip it for a double returning a scalar or a boolean, where
there is no shape to get wrong.

## Examples

Permissive versus faithful:

```
// Permissive — matches a broken comparison, hides that the feature is dead.
mockCreate.mockResolvedValue({ outcome: "truncated" });

// Faithful — the real type is a discriminated object, so the code has to read
// its status field, and a comparison against the bare string fails to compile.
mockCreate.mockResolvedValue({ outcome: { status: "truncated" as const } });
```

Hand-listed subset versus pass-through:

```
// Breaks when the code under test imports one more thing from this module.
vi.mock("./queries", async () => ({ countWords: (await importActual()).countWords }));

// Survives it, and still exercises the real implementations.
vi.mock("./queries", async () => await importActual<typeof import("./queries")>());
```

## Related

- `docs/solutions/architecture-patterns/reconciling-a-human-edit-with-an-ai-rewrite-of-one-document.md` — the sibling rule: prove a test is not vacuous by reverting the behavior and confirming it goes red. A permissive double is one of the ways a test stays green against broken code.
