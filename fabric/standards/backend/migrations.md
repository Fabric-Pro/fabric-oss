## Database migration best practices

- **Never use `prisma db push`**: Every schema change must have a reviewed,
  versioned migration. Use `prisma migrate dev` locally and `prisma migrate
  deploy` in managed environments.
- **Rollback Planning**: Prisma migrations have no generated down migration.
  Prefer backward-compatible expand/contract changes and document a concrete
  forward-recovery or rollback plan for risky migrations.
- **Small, Focused Changes**: Keep each migration focused on a single logical change for clarity and easier troubleshooting
- **Zero-Downtime Deployments**: Consider deployment order and backwards compatibility for high-availability systems
- **Separate Schema and Data**: Keep schema changes separate from data migrations for better rollback safety
- **Index Management**: Create indexes on large tables carefully, using concurrent options when available to avoid locks
- **Naming Conventions**: Use clear, descriptive names that indicate what the migration does
- **Version Control**: Always commit migrations to version control and never modify existing migrations after deployment

## Required workflow

From `packages/database`, create a focused migration with the repository's
dotenv-wrapped Prisma command:

```bash
npx dotenv -c -e ../../.env.local -- npx prisma migrate dev --name descriptive_name --schema=./prisma/schema.prisma
```

Inspect the generated SQL, then run `pnpm --filter @repo/database generate`.
If tenant-aware tables changed, update and validate
`packages/database/scripts/apply-rls-direct.ts` as part of the same change.

Before switching branches after applying a migration, compare the branch's
migration history with the local database. Never delete rows from
`_prisma_migrations`, remove deployed migration directories, or reset shared
data as routine recovery. Diagnose the exact drift first and ask before any
destructive repair.
