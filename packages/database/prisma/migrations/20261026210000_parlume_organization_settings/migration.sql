-- Parlume organization settings: an organization configures its own meeting
-- bot (Attendee key, base URL, Teams sign-in mode) and the Azure deployment
-- that serves its realtime voice, instead of relying only on the operator's
-- environment. One row per organization. Without its own Attendee key the
-- organization uses the environment's key, URL and sign-in mode together;
-- without a deployment name, one named after the realtime model.
--
-- Also adds NOT_ADMITTED to the end reasons, for a bot nobody let in from the
-- meeting lobby.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: organizationId is the only tenant column. RLS
-- (scripts/apply-rls-direct.ts) gives the table `org_only`. updatedById is
-- attribution, not a tenant column.

-- AlterEnum
-- Not referenced below: a value added by ALTER TYPE cannot be used in the
-- transaction that adds it.
ALTER TYPE "parlume_meeting_end_reason" ADD VALUE IF NOT EXISTS 'NOT_ADMITTED';

-- CreateEnum
CREATE TYPE "parlume_teams_login_mode" AS ENUM ('ALWAYS', 'ONLY_IF_REQUIRED');

-- CreateTable
CREATE TABLE "organization_parlume_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "encryptedAttendeeApiKey" TEXT,
    "attendeeBaseUrl" TEXT,
    "teamsLoginMode" "parlume_teams_login_mode",
    "realtimeDeployment" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_parlume_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_parlume_settings_organizationId_key" ON "organization_parlume_settings"("organizationId");

-- CreateIndex
CREATE INDEX "organization_parlume_settings_updatedById_idx" ON "organization_parlume_settings"("updatedById");

-- AddForeignKey
ALTER TABLE "organization_parlume_settings" ADD CONSTRAINT "organization_parlume_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_parlume_settings" ADD CONSTRAINT "organization_parlume_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
