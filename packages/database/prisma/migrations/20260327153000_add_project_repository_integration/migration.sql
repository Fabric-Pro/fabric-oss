-- CreateEnum
CREATE TYPE "RepositoryProvider" AS ENUM ('GITHUB', 'AZURE_DEVOPS');

-- CreateEnum
CREATE TYPE "RepositoryAuthMethod" AS ENUM ('OAUTH', 'PAT');

-- CreateEnum
CREATE TYPE "RepositoryIntegrationStatus" AS ENUM ('ACTIVE', 'TOKEN_EXPIRED', 'ERROR', 'DISCONNECTED');

-- CreateTable
CREATE TABLE "project_repository_integration" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" "RepositoryProvider" NOT NULL,
    "authMethod" "RepositoryAuthMethod" NOT NULL,
    "repositoryUrl" TEXT NOT NULL,
    "repositoryOwner" TEXT NOT NULL,
    "repositoryName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "tokenScopes" TEXT[],
    "encryptedPat" TEXT,
    "azureOrganization" TEXT,
    "status" "RepositoryIntegrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastHealthCheck" TIMESTAMP(3),
    "lastError" TEXT,
    "configuredByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_repository_integration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_repository_integration_projectId_idx" ON "project_repository_integration"("projectId");

-- CreateIndex
CREATE INDEX "project_repository_integration_status_idx" ON "project_repository_integration"("status");

-- CreateIndex
CREATE UNIQUE INDEX "project_repository_integration_projectId_provider_repositor_key" ON "project_repository_integration"("projectId", "provider", "repositoryOwner", "repositoryName");

-- AddForeignKey
ALTER TABLE "project_repository_integration" ADD CONSTRAINT "project_repository_integration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_repository_integration" ADD CONSTRAINT "project_repository_integration_configuredByUserId_fkey" FOREIGN KEY ("configuredByUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
