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

## Hand-written SQL must still match the datamodel

`prisma migrate dev` replays the migration chain and turns every difference
from `schema.prisma` into a new migration. When a migration creates an object
by hand, declare it in `schema.prisma` too, or every later `migrate dev`
proposes dropping or recreating it — and fails outright when that SQL is
invalid for the real object.

- A hand-picked or truncated name: pin it with `map:`.
- A descending index column: `sort: Desc`.
- A column default set in SQL: `@default(...)`; a generated column's
  expression: `@default(dbgenerated("..."))`.
- A composite foreign key Prisma Client must not expose: an `@ignore`d
  relation, plus the `@@unique` it references. Migrate keeps the constraint;
  the client never sees it. Its columns drop out of the client's checked
  create and update inputs, so write them as plain scalar fields. Prisma
  compares neither MATCH FULL nor an ON DELETE SET NULL column list: when the
  constraint uses either, add it to
  `packages/database/scripts/assert-handwritten-constraints.sql`.
- Partial indexes and CHECK constraints: leave them out and document them on
  the model. Prisma does not read either, and an `@@index` standing in for a
  partial index makes every `migrate dev` try to create it again.

The `Migration drift` job fails the required `unit-tests` check when the
replayed chain and the datamodel differ, or when one of those constraints
loses its shape. To check locally, run this from `packages/database` with the
URL of an empty, disposable database — Prisma wipes the shadow database it is
given:

```bash
npx prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --shadow-database-url "postgresql://postgres:postgres@localhost:5432/shadow" --script --exit-code
```

Exit code 0 means no drift; 2 means drift, and the printed SQL is what
`migrate dev` would generate.
