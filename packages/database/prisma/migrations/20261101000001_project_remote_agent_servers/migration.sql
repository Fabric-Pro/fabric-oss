-- CreateTable
CREATE TABLE "project_remote_agent_server" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'PRIVATE',
    "url" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_remote_agent_server_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_remote_agent_server_projectId_isActive_idx" ON "project_remote_agent_server"("projectId", "isActive");

-- CreateIndex
CREATE INDEX "project_remote_agent_server_userId_idx" ON "project_remote_agent_server"("userId");

-- AddForeignKey
ALTER TABLE "project_remote_agent_server" ADD CONSTRAINT "project_remote_agent_server_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Only explicitly private or project-team connections are valid.
ALTER TABLE "project_remote_agent_server" ADD CONSTRAINT "project_remote_agent_server_scope_check" CHECK ("scope" IN ('PRIVATE', 'TEAM'));

-- Fail closed until apply:rls installs the project/owner policy.
ALTER TABLE "project_remote_agent_server" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_remote_agent_server" FORCE ROW LEVEL SECURITY;
