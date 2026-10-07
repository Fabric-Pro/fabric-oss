-- ChatGPT plan pooling for organizations (Fizzy #2770).
--
-- Three new tables and four new enums, no change to any existing table:
--
--   `chat_gpt_plan_org_account` holds the ChatGPT plan sign-ins an
--   organization admin connected for the organization's shared work. RLS
--   `org_only` (scripts/apply-rls-direct.ts), matched by ORG_ONLY_TABLES in
--   src/tenant-db.ts. `subject` is unique, so one ChatGPT account serves at
--   most one organization. Tokens are stored encrypted by the application.
--
--   `chat_gpt_plan_org_policy` is the organization's pooling policy, one row
--   per organization; also `org_only`.
--
--   `chat_gpt_plan_source_state` is the shared memory of a spent plan window,
--   keyed by source (a member's own plan or an organization account). No
--   organizationId and so no RLS policy; it is reached only through a source
--   its reader already resolved.

-- CreateEnum
CREATE TYPE "ChatGptPlanTier" AS ENUM ('UNKNOWN', 'PLUS', 'PRO');

-- CreateEnum
CREATE TYPE "ChatGptPlanApiFallbackInteractive" AS ENUM ('ASK', 'NEVER');

-- CreateEnum
CREATE TYPE "ChatGptPlanApiFallbackBackground" AS ENUM ('NEVER', 'AUTO');

-- CreateEnum
CREATE TYPE "ChatGptPlanSourceKind" AS ENUM ('USER', 'ORG');

-- CreateTable
CREATE TABLE "chat_gpt_plan_org_account" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "connectedByUserId" TEXT NOT NULL,
    "email" TEXT,
    "subject" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "encryptedAccessToken" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "encryptedIdToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "earliestRefreshAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "status" "ChatGptPlanCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "tier" "ChatGptPlanTier" NOT NULL DEFAULT 'UNKNOWN',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "serveInteractive" BOOLEAN NOT NULL DEFAULT false,
    "serveBackground" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_gpt_plan_org_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_gpt_plan_org_policy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "poolingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "apiFallbackInteractive" "ChatGptPlanApiFallbackInteractive" NOT NULL DEFAULT 'ASK',
    "apiFallbackBackground" "ChatGptPlanApiFallbackBackground" NOT NULL DEFAULT 'NEVER',
    "headroomPct" INTEGER NOT NULL DEFAULT 40,
    "termsAcknowledgedById" TEXT,
    "termsAcknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_gpt_plan_org_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_gpt_plan_source_state" (
    "sourceKind" "ChatGptPlanSourceKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "openUntil" TIMESTAMP(3),
    "resetAt" TIMESTAMP(3),
    "consecutiveUnknownResets" INTEGER NOT NULL DEFAULT 0,
    "lastExhaustedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_gpt_plan_source_state_pkey" PRIMARY KEY ("sourceKind","sourceId")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_gpt_plan_org_account_subject_key" ON "chat_gpt_plan_org_account"("subject");

-- CreateIndex
CREATE INDEX "chat_gpt_plan_org_account_organizationId_enabled_idx" ON "chat_gpt_plan_org_account"("organizationId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "chat_gpt_plan_org_policy_organizationId_key" ON "chat_gpt_plan_org_policy"("organizationId");

-- AddForeignKey
ALTER TABLE "chat_gpt_plan_org_account" ADD CONSTRAINT "chat_gpt_plan_org_account_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_gpt_plan_org_policy" ADD CONSTRAINT "chat_gpt_plan_org_policy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
