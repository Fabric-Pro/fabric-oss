-- ChatGPT plan connection (Fizzy #2939).
--
-- Two new tables and one new enum, no change to any existing table:
--
--   `chat_gpt_plan_credential` holds one person's ChatGPT plan sign-in,
--   uploaded by `fabric connect chatgpt`. One row per user and no
--   organizationId: the plan belongs to the person, so it carries no RLS
--   policy, and every reader keys on the session's own userId. Tokens are
--   stored encrypted by the application.
--
--   `chat_gpt_plan_org_use` records, per person and organization, whether that
--   person chose to run their own work there on the plan, and whether that
--   includes the background work done on their behalf. RLS
--   `per_user_within_org` (scripts/apply-rls-direct.ts), matched by
--   PER_USER_ORG_TABLES in src/tenant-db.ts.
--
-- Both tables start empty and nothing is backfilled. The indexes and foreign
-- keys build against empty tables, so they need neither CONCURRENTLY nor
-- NOT VALID.

-- CreateEnum
CREATE TYPE "ChatGptPlanCredentialStatus" AS ENUM ('ACTIVE', 'NEEDS_RECONNECT');

-- CreateTable
CREATE TABLE "chat_gpt_plan_credential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
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
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_gpt_plan_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_gpt_plan_org_use" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "includeBackgroundJobs" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_gpt_plan_org_use_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_gpt_plan_credential_userId_key" ON "chat_gpt_plan_credential"("userId");

-- CreateIndex
CREATE INDEX "chat_gpt_plan_org_use_organizationId_idx" ON "chat_gpt_plan_org_use"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "chat_gpt_plan_org_use_userId_organizationId_key" ON "chat_gpt_plan_org_use"("userId", "organizationId");

-- AddForeignKey
ALTER TABLE "chat_gpt_plan_credential" ADD CONSTRAINT "chat_gpt_plan_credential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_gpt_plan_org_use" ADD CONSTRAINT "chat_gpt_plan_org_use_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_gpt_plan_org_use" ADD CONSTRAINT "chat_gpt_plan_org_use_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
