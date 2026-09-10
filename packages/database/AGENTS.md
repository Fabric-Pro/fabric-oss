# Database guidance

Apply the root `AGENTS.md` first. Before changing this tree, read
[migration standards](../../fabric/standards/backend/migrations.md),
[model standards](../../fabric/standards/backend/models.md),
[query standards](../../fabric/standards/backend/queries.md), and
[ADR-018](../../docs/adr/018-organization-is-the-only-tenant-context.md).

- Never use `prisma db push`, edit a deployed migration, or manipulate
  `_prisma_migrations` as routine recovery.
- Tenant queries remain exclusive and fail closed. Add new tenant-aware models
  to the tenant extension and RLS policy in the same change.
- Inspect generated migration SQL before applying it. Prefer additive,
  backward-compatible expand/contract changes.
- Never hand-edit generated Prisma Zod files.
- Audit metadata, snapshots, and resource names must not contain credentials.

For schema changes, create a migration, regenerate clients, update RLS when
needed, and run targeted migration and tenant-isolation tests.
