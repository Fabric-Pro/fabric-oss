-- CLI connection records and the prompt dismissal (Fizzy #2457).
--
-- Three new tables, no change to any existing one. Fabric can feed project
-- context into a developer's own AI tooling over MCP, using a key, and nothing
-- in the product says so at a moment when it would land. These tables hold the
-- one fact both new surfaces read — has a coding CLI ever reached this
-- organization — and the one answer a person can give back.
--
-- Why three rather than one:
--
--   `organization_cli_reach` is per credential. Whether the organization is
--   CURRENTLY connected is answered by asking whether any credential that
--   reached it is still alive, so the rows have to be per credential to keep
--   revocation meaningful. `credentialId` carries NO foreign key on purpose: it
--   is polymorphic across `user_api_key` and `organization_api_key` and a
--   foreign key cannot point at two tables. The reader treats a missing key row
--   as "dead" — organization keys are hard-deleted by the revoke path, so the
--   absent row IS the revocation. Adding a constraint here would either be
--   inexpressible or would cascade away the history this table exists to keep.
--
--   `organization_cli_first_reach` is per organization and is never
--   invalidated. Every per-credential row above can become invalid — revoked,
--   expired, owner offboarded — and the adoption funnel has to survive that. The
--   organization is the primary key because there is exactly one first time, and
--   because that makes the write idempotent under concurrent first requests.
--
--   `cli_connection_prompt_dismissal` is per person per organization. It is
--   deliberately not a column on `member`: that table belongs to the
--   authentication library, carries no application columns, and its rows are
--   recreated when someone rejoins — which would silently clear a dismissal and
--   re-interrupt a person who had already answered.
--
-- Additive in the strict sense: three CREATE TABLEs and one CREATE TYPE, no
-- ALTER of anything that exists today, so the previous app version keeps
-- running unchanged and there is nothing to backfill. Every table starts empty,
-- which is the correct starting point — an organization nobody has connected
-- from has not connected, and a person who has not dismissed the prompt has not
-- dismissed it. The one accepted cost is a warm-up: an organization whose
-- members connected before this ships reads as not connected until one of them
-- makes another request. Seeding from the existing usage counters would be
-- exactly the false signal this design exists to stop trusting.
--
-- The indexes and constraints below build against empty tables, so they take no
-- meaningful lock and need neither CONCURRENTLY nor NOT VALID.
--
-- RLS is applied out of band by `pnpm --filter @repo/database apply:rls`; the
-- registrations are in `scripts/apply-rls-direct.ts` (`org_only` for the two
-- reach tables, `per_user_within_org` for the dismissal) and must be matched by
-- `src/tenant-db.ts`, or the table fails OPEN on the tenant path.

-- CreateEnum
-- Which of the two key tables `credentialId` points at. An enum rather than a
-- bare string because the id alone does not identify a row, and a typo in a
-- string would silently look up the wrong table.
CREATE TYPE "cli_credential_kind" AS ENUM ('USER_API_KEY', 'ORGANIZATION_API_KEY');

-- CreateTable
CREATE TABLE "organization_cli_reach" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "credentialKind" "cli_credential_kind" NOT NULL,
    "credentialId" TEXT NOT NULL,
    -- Named for what they mean rather than duplicated as a second
    -- created/updated pair: this row is created the first time a credential
    -- reaches the organization and touched on every reach after that.
    "firstReachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_cli_reach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_cli_first_reach" (
    "organizationId" TEXT NOT NULL,
    "firstReachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_cli_first_reach_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "cli_connection_prompt_dismissal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- Nullable, and null is meaningful: the row is an upsert target, so one that
    -- exists without a timestamp reads as "not dismissed". The timestamp carries
    -- the answer, not the row's existence.
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cli_connection_prompt_dismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The organization read. Every tenant policy and every read of this table
-- anchors on `organizationId`, and stating it separately keeps that read indexed
-- if the unique key's column order ever changes. The unique index below IS the
-- upsert's conflict target, so it ships with the table rather than concurrently:
-- there are no rows yet, so there is nothing for a blocking build to block. Its
-- name is Prisma's own, truncated to Postgres's 63-character identifier limit; a
-- hand-picked one would read better and would show up as permanent drift on
-- every `migrate diff`.
CREATE INDEX "organization_cli_reach_organizationId_idx" ON "organization_cli_reach"("organizationId");
CREATE UNIQUE INDEX "organization_cli_reach_organizationId_credentialKind_creden_key" ON "organization_cli_reach"("organizationId", "credentialKind", "credentialId");

-- CreateIndex
-- One row per (organization, person), which is both the upsert's conflict target
-- and the statement that a dismissal is per organization rather than per
-- project. The `userId` index serves the cascade on user delete.
CREATE INDEX "cli_connection_prompt_dismissal_organizationId_idx" ON "cli_connection_prompt_dismissal"("organizationId");
CREATE INDEX "cli_connection_prompt_dismissal_userId_idx" ON "cli_connection_prompt_dismissal"("userId");
CREATE UNIQUE INDEX "cli_connection_prompt_dismissal_organizationId_userId_key" ON "cli_connection_prompt_dismissal"("organizationId", "userId");

-- AddForeignKey
-- Cascade on organization delete for all three, and on user delete for the
-- dismissal: none of this is worth keeping once the tenant or the person is
-- gone, and a reach record outliving its organization would be unreachable
-- anyway. Note that this is the only cascade here — the credential id above
-- carries none, for the reason in the header.
ALTER TABLE "organization_cli_reach" ADD CONSTRAINT "organization_cli_reach_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organization_cli_first_reach" ADD CONSTRAINT "organization_cli_first_reach_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cli_connection_prompt_dismissal" ADD CONSTRAINT "cli_connection_prompt_dismissal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cli_connection_prompt_dismissal" ADD CONSTRAINT "cli_connection_prompt_dismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
