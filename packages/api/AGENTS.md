# API guidance

Apply the root `AGENTS.md` first. Read [API standards](../../fabric/standards/backend/api.md)
and [ADR-018](../../docs/adr/018-organization-is-the-only-tenant-context.md)
before changing procedures, middleware, authorization, or tenant resolution.

- Prefer `tenantProtectedProcedure`; resolve and authorize organization or
  object scope server-side.
- Treat API-key scope as a ceiling. Always perform the owner's current live
  permission check, including for wildcard keys.
- Use `hasProjectAccess` for reads and `canEditProject` for writes. Preserve
  invited-guest object access when it intentionally differs from membership.
- Security-relevant mutations need the correct audit action. Do not duplicate
  generic error capture already supplied by middleware.
- Pass `organizationId` and correlation context into Temporal, MCP, AI, and
  database layers without a silent fallback.

Run focused procedure and authorization tests, including cross-organization
and unauthorized-user cases.
