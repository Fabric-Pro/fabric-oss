# ADR-003: XOR Pattern for Tenant Isolation

- **Status**: Accepted, amended by [ADR-018](018-organization-is-the-only-tenant-context.md)
- **Date**: 2024-06-01
- **Deciders**: Engineering team

> **Amendment (2026-08-31).** The XOR rule below still holds — never `OR` two
> tenant predicates. What no longer holds is the premise that personal is one of
> two reachable contexts: every account now has an organization, and the
> `organizationId: null` arm is a fail-closed default rather than a context to
> route into. See ADR-018 before writing new tenant-scoped code.

## Context

Multi-tenant SaaS requires strict data isolation between personal accounts and organization accounts, and between different organizations.

## Decision

All tenant-filtered queries use exclusive (XOR) filtering. Never use OR patterns.

```typescript
// Correct: XOR pattern
const filter = organizationId
  ? { organizationId, userId }
  : { organizationId: null, userId };

// Wrong: OR pattern (leaks data)
{ OR: [{ userId }, { organizationId }] }
```

## Alternatives Considered

- **OR-based filtering**: Simpler queries but creates data leakage between contexts
- **Separate databases per tenant**: Too expensive, complex migrations

## Consequences

- Every query must explicitly handle both personal (`organizationId: null`) and org contexts
- `tenantProtectedProcedure` enforces this at the API layer
- PostgreSQL RLS provides database-level enforcement
- `organizationId` must be passed through entire call chains (Temporal workflows, MCP clients, activities)
- Isolation behavior is exercised by the RLS test suites under `packages/database/__tests__/rls*`
