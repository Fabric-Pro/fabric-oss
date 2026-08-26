-- Publishing Suite 1C-1: per-project configuration (cadence, lookback, notification kill switch).
CREATE TABLE "publishing_suite_settings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "cadence" TEXT NOT NULL DEFAULT 'WEEKLY',
    "lookbackDays" INTEGER,
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publishing_suite_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "publishing_suite_settings_projectId_key" ON "publishing_suite_settings"("projectId");
CREATE INDEX "publishing_suite_settings_userId_idx" ON "publishing_suite_settings"("userId");
CREATE INDEX "publishing_suite_settings_organizationId_idx" ON "publishing_suite_settings"("organizationId");

ALTER TABLE "publishing_suite_settings" ADD CONSTRAINT "publishing_suite_settings_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_suite_settings" ADD CONSTRAINT "publishing_suite_settings_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_suite_settings" ADD CONSTRAINT "publishing_suite_settings_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant XOR, matching publishing_topic / publishing_suggestion_cycle
-- (migration 20260714140000). Personal context => organizationId NULL;
-- organization context => userId NULL. Never both, never neither.
ALTER TABLE "publishing_suite_settings"
    ADD CONSTRAINT "publishing_suite_settings_tenant_xor"
    CHECK (("organizationId" IS NULL) <> ("userId" IS NULL));
