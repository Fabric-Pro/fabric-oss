-- Living Documents auto-refresh — per-document enrollment in the hourly refresh sweep.
--
-- Schema delta:
--   * ProjectDocumentType += SRS (additive — existing consumers ignore unknown
--     enum values). Completes the six living-document types the feature covers.
--   * document_auto_refresh_settings (new) — one row per enrolled document.
--     Opt-in: an absent row means the document is never refreshed, and `enabled`
--     defaults false even when a row exists.
--     `cadence` is TEXT rather than an enum, matching the newsletter_settings
--     precedent (the TS union lives in src/document-refresh-cadence.ts), so
--     adding a cadence costs no enum migration.
--     `createdByUserId` is load-bearing, not bookkeeping: the sweep has no
--     session, and AI model resolution + usage logging are per-user, so it
--     borrows the enroller's identity.
--     `lastAttemptAt` is deliberately separate from `lastRefreshedAt` — a failed
--     refresh does not advance the latter, so without the former a persistently
--     failing document would be re-dispatched by the hourly sweep 24x/day.
--   * Tenant columns userId/organizationId are copied from the parent
--     project_document. The table takes the `user_owned` RLS policy — see
--     scripts/apply-rls-direct.ts.

-- AlterEnum
-- `IF NOT EXISTS` keeps the ADD VALUE idempotent across half-applied deploys.
ALTER TYPE "ProjectDocumentType" ADD VALUE IF NOT EXISTS 'SRS';

-- CreateTable
CREATE TABLE "document_auto_refresh_settings" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "cadence" TEXT NOT NULL DEFAULT 'BIWEEKLY',
    "createdByUserId" TEXT NOT NULL,
    "lastRefreshedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastRefreshStatus" TEXT,
    "lastRefreshSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,

    CONSTRAINT "document_auto_refresh_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_auto_refresh_settings_documentId_key" ON "document_auto_refresh_settings"("documentId");

-- CreateIndex
CREATE INDEX "document_auto_refresh_settings_enabled_idx" ON "document_auto_refresh_settings"("enabled");

-- CreateIndex
CREATE INDEX "document_auto_refresh_settings_projectId_idx" ON "document_auto_refresh_settings"("projectId");

-- CreateIndex
CREATE INDEX "document_auto_refresh_settings_userId_idx" ON "document_auto_refresh_settings"("userId");

-- CreateIndex
CREATE INDEX "document_auto_refresh_settings_organizationId_idx" ON "document_auto_refresh_settings"("organizationId");

-- AddForeignKey
ALTER TABLE "document_auto_refresh_settings" ADD CONSTRAINT "document_auto_refresh_settings_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "project_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_auto_refresh_settings" ADD CONSTRAINT "document_auto_refresh_settings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_auto_refresh_settings" ADD CONSTRAINT "document_auto_refresh_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_auto_refresh_settings" ADD CONSTRAINT "document_auto_refresh_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
