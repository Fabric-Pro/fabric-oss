-- CreateEnum
CREATE TYPE "AuthorityRunType" AS ENUM ('ORCHESTRATOR', 'WORKFLOW', 'MCP_GATEWAY', 'AGENT_INSTANCE');

-- CreateEnum
CREATE TYPE "AuthoritySessionStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AuthorityGrantKind" AS ENUM ('BROAD', 'REQUEST');

-- CreateEnum
CREATE TYPE "AuthorityProviderType" AS ENUM ('MCP', 'INTEGRATION', 'FABRIC_NATIVE');

-- CreateEnum
CREATE TYPE "AuthorityAccessLevel" AS ENUM ('READ', 'WRITE');

-- CreateEnum
CREATE TYPE "AuthorityGrantStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'CONSUMED', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "authority_session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "runType" "AuthorityRunType" NOT NULL,
    "runId" TEXT,
    "status" "AuthoritySessionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "requestedByAgentId" TEXT,
    "approvalInstructions" TEXT,

    CONSTRAINT "authority_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "authority_grant" (
    "id" TEXT NOT NULL,
    "authoritySessionId" TEXT NOT NULL,
    "kind" "AuthorityGrantKind" NOT NULL DEFAULT 'BROAD',
    "providerType" "AuthorityProviderType" NOT NULL,
    "providerKey" TEXT NOT NULL,
    "providerRefId" TEXT,
    "providerDisplayName" TEXT,
    "accessLevel" "AuthorityAccessLevel" NOT NULL,
    "toolScope" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestFingerprint" TEXT,
    "status" "AuthorityGrantStatus" NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "deniedAt" TIMESTAMP(3),
    "denialReason" TEXT,
    "metadata" JSONB,

    CONSTRAINT "authority_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "authority_session_userId_idx" ON "authority_session"("userId");

-- CreateIndex
CREATE INDEX "authority_session_organizationId_idx" ON "authority_session"("organizationId");

-- CreateIndex
CREATE INDEX "authority_session_runType_runId_idx" ON "authority_session"("runType", "runId");

-- CreateIndex
CREATE INDEX "authority_session_status_expiresAt_idx" ON "authority_session"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "authority_session_userId_organizationId_status_idx" ON "authority_session"("userId", "organizationId", "status");

-- CreateIndex
CREATE INDEX "authority_grant_authoritySessionId_idx" ON "authority_grant"("authoritySessionId");

-- CreateIndex
CREATE INDEX "authority_grant_providerKey_status_idx" ON "authority_grant"("providerKey", "status");

-- CreateIndex
CREATE INDEX "authority_grant_providerRefId_status_idx" ON "authority_grant"("providerRefId", "status");

-- CreateIndex
CREATE INDEX "authority_grant_status_expiresAt_idx" ON "authority_grant"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "authority_session" ADD CONSTRAINT "authority_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authority_session" ADD CONSTRAINT "authority_session_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authority_grant" ADD CONSTRAINT "authority_grant_authoritySessionId_fkey" FOREIGN KEY ("authoritySessionId") REFERENCES "authority_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
