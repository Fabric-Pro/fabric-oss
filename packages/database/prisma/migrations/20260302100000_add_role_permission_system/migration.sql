-- CreateTable: permission
CREATE TABLE IF NOT EXISTS "permission" (
    "key" TEXT NOT NULL,
    "description" TEXT,
    CONSTRAINT "permission_pkey" PRIMARY KEY ("key")
);

-- CreateTable: role
CREATE TABLE IF NOT EXISTS "role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "organizationId" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable: role_permission
CREATE TABLE IF NOT EXISTS "role_permission" (
    "roleId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("roleId", "permissionKey")
);

-- CreateTable: principal_role
CREATE TABLE IF NOT EXISTS "principal_role" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT,
    "userId" TEXT,
    "registeredAgentId" TEXT,
    "organizationApiKeyId" TEXT,
    CONSTRAINT "principal_role_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "role_organizationId_idx" ON "role"("organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "role_organizationId_name_key" ON "role"("organizationId", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "principal_role_userId_idx" ON "principal_role"("userId");
CREATE INDEX IF NOT EXISTS "principal_role_organizationId_idx" ON "principal_role"("organizationId");
CREATE INDEX IF NOT EXISTS "principal_role_registeredAgentId_idx" ON "principal_role"("registeredAgentId");
CREATE INDEX IF NOT EXISTS "principal_role_organizationApiKeyId_idx" ON "principal_role"("organizationApiKeyId");
CREATE UNIQUE INDEX IF NOT EXISTS "principal_role_roleId_organizationId_userId_key" ON "principal_role"("roleId", "organizationId", "userId");
CREATE UNIQUE INDEX IF NOT EXISTS "principal_role_roleId_organizationId_registeredAgentId_key" ON "principal_role"("roleId", "organizationId", "registeredAgentId");
CREATE UNIQUE INDEX IF NOT EXISTS "principal_role_roleId_organizationId_organizationApiKeyId_key" ON "principal_role"("roleId", "organizationId", "organizationApiKeyId");

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permissionKey_fkey" FOREIGN KEY ("permissionKey") REFERENCES "permission"("key") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "principal_role" ADD CONSTRAINT "principal_role_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "principal_role" ADD CONSTRAINT "principal_role_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "principal_role" ADD CONSTRAINT "principal_role_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "principal_role" ADD CONSTRAINT "principal_role_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "principal_role" ADD CONSTRAINT "principal_role_registeredAgentId_fkey" FOREIGN KEY ("registeredAgentId") REFERENCES "registered_agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "principal_role" ADD CONSTRAINT "principal_role_organizationApiKeyId_fkey" FOREIGN KEY ("organizationApiKeyId") REFERENCES "organization_api_key"("id") ON DELETE CASCADE ON UPDATE CASCADE;
