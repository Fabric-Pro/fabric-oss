-- Credential manager, phase 1 (ADR-026).
-- Additive only: a new table nothing reads yet. RLS is applied by
-- scripts/apply-rls-direct.ts (policy org_only_owned).

-- CreateEnum
CREATE TYPE "CredentialProvider" AS ENUM ('GITHUB', 'GITLAB', 'AZURE_DEVOPS', 'ATLASSIAN', 'SLACK', 'MICROSOFT', 'GOOGLE', 'NOTION', 'LINEAR', 'OPENAI', 'ANTHROPIC', 'AZURE_OPENAI', 'CUSTOM');

-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('APP_INSTALLATION', 'OAUTH', 'GITHUB_APP_USER', 'PAT', 'API_KEY', 'BASIC', 'SERVICE_ACCOUNT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "CredentialPrincipal" AS ENUM ('APP', 'USER');

-- CreateEnum
CREATE TYPE "CredentialSharing" AS ENUM ('PRIVATE', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'EXPIRING', 'NEEDS_REAUTH', 'REVOKED', 'ERROR');

-- CreateTable
CREATE TABLE "credential" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "sharing" "CredentialSharing" NOT NULL DEFAULT 'PRIVATE',
    "provider" "CredentialProvider" NOT NULL,
    "kind" "CredentialKind" NOT NULL,
    "principal" "CredentialPrincipal" NOT NULL DEFAULT 'USER',
    "label" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "externalAccountId" TEXT,
    "externalAccountLogin" TEXT,
    "installationId" TEXT,
    "installation" JSONB,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "encryptedSecret" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "refreshRejectedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credential_organizationId_provider_idx" ON "credential"("organizationId", "provider");

-- CreateIndex
CREATE INDEX "credential_organizationId_userId_idx" ON "credential"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "credential_status_idx" ON "credential"("status");

-- AddForeignKey
ALTER TABLE "credential" ADD CONSTRAINT "credential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential" ADD CONSTRAINT "credential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential" ADD CONSTRAINT "credential_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One live grant per provider account per owner per organization: a
-- reconnect replaces the secret in place instead of adding a second grant.
-- Partial, so not declared in schema.prisma (see the model doc).
CREATE UNIQUE INDEX "credential_account_grant_key"
    ON "credential"("organizationId", "userId", "provider", "origin", "externalAccountId")
    NULLS NOT DISTINCT
    WHERE "kind" IN ('OAUTH', 'GITHUB_APP_USER')
      AND "status" <> 'REVOKED'
      AND "externalAccountId" IS NOT NULL;

-- An app installation binds to exactly one organization.
CREATE UNIQUE INDEX "credential_installation_key"
    ON "credential"("provider", "origin", "installationId")
    WHERE "kind" = 'APP_INSTALLATION' AND "installationId" IS NOT NULL;

-- Organization-owned rows are always shared with the organization, and an
-- app installation is always organization-owned and acts as the app.
ALTER TABLE "credential" ADD CONSTRAINT "credential_org_owned_shared_check"
    CHECK ("userId" IS NOT NULL OR "sharing" = 'ORGANIZATION');
ALTER TABLE "credential" ADD CONSTRAINT "credential_app_installation_check"
    CHECK ("kind" <> 'APP_INSTALLATION'
           OR ("userId" IS NULL AND "principal" = 'APP' AND "encryptedSecret" IS NULL));
