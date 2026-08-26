-- DropIndex
DROP INDEX "public"."workspace_userId_organizationId_type_key";

-- CreateIndex: Partial unique index for PERSONAL workspaces only (one per user+org context)
-- CUSTOM workspaces are allowed to have multiples per user+org context
CREATE UNIQUE INDEX "workspace_userId_organizationId_type_personal_key"
ON "workspace" ("userId", "organizationId", "type")
WHERE "type" = 'PERSONAL';
