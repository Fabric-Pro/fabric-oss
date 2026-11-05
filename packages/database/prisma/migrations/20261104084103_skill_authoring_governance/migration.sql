-- AlterTable
ALTER TABLE "skill" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "importProvenance" JSONB,
ADD COLUMN     "isDiscoverable" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "skill_organizationId_isPublished_archivedAt_idx" ON "skill"("organizationId", "isPublished", "archivedAt");

-- CreateIndex
CREATE INDEX "skill_userId_archivedAt_idx" ON "skill"("userId", "archivedAt");

-- Preserve automatic discovery only for rows the prior runtime could discover.
UPDATE "skill" SET "isDiscoverable" = true
WHERE "isPublished" = true AND "userId" IS NULL
AND ((scope = 'SYSTEM' AND "organizationId" IS NULL)
 OR (scope = 'ORGANIZATION' AND "organizationId" IS NOT NULL));

-- Published availability is the only sharing grant; archiving always removes it.
ALTER TABLE "skill" ADD CONSTRAINT skill_discoverable_requires_publication
 CHECK (NOT "isDiscoverable" OR "isPublished") NOT VALID;
ALTER TABLE "skill" VALIDATE CONSTRAINT skill_discoverable_requires_publication;
ALTER TABLE "skill" ADD CONSTRAINT skill_archived_is_private
 CHECK ("archivedAt" IS NULL OR (NOT "isPublished" AND NOT "isDiscoverable")) NOT VALID;
ALTER TABLE "skill" VALIDATE CONSTRAINT skill_archived_is_private;


ALTER TABLE "skill" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "skill";

CREATE POLICY tenant_isolation ON "skill" FOR SELECT USING (current_tenant_type() = 'organization' AND current_user_id() IS NOT NULL AND (
 ("skill".scope = 'SYSTEM' AND "skill"."organizationId" IS NULL AND "skill"."userId" IS NULL AND "skill"."isPublished" AND "skill"."archivedAt" IS NULL)
 OR ("skill".scope = 'ORGANIZATION' AND "skill"."organizationId" = current_tenant_id() AND
 ("skill"."userId" = current_user_id() OR ("skill"."isPublished" AND "skill"."archivedAt" IS NULL)))));

DROP POLICY IF EXISTS skill_owner_insert ON "skill";
CREATE POLICY skill_owner_insert ON "skill" FOR INSERT  WITH CHECK (current_tenant_type() = 'organization' AND current_user_id() IS NOT NULL AND "skill".scope = 'ORGANIZATION' AND "skill"."organizationId" = current_tenant_id() AND "skill"."userId" = current_user_id());

DROP POLICY IF EXISTS skill_owner_update ON "skill";
CREATE POLICY skill_owner_update ON "skill" FOR UPDATE USING (current_tenant_type() = 'organization' AND current_user_id() IS NOT NULL AND "skill".scope = 'ORGANIZATION' AND "skill"."organizationId" = current_tenant_id() AND "skill"."userId" = current_user_id()) WITH CHECK (current_tenant_type() = 'organization' AND current_user_id() IS NOT NULL AND "skill".scope = 'ORGANIZATION' AND "skill"."organizationId" = current_tenant_id() AND "skill"."userId" = current_user_id());

DROP POLICY IF EXISTS skill_owner_delete ON "skill";
CREATE POLICY skill_owner_delete ON "skill" FOR DELETE USING (current_tenant_type() = 'organization' AND current_user_id() IS NOT NULL AND "skill".scope = 'ORGANIZATION' AND "skill"."organizationId" = current_tenant_id() AND "skill"."userId" = current_user_id()) ;

ALTER TABLE "skill_file" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_file" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "skill_file";

CREATE POLICY tenant_isolation ON "skill_file" FOR SELECT USING (EXISTS (SELECT 1 FROM "skill" s WHERE s.id = "skill_file"."skillId" AND current_tenant_type() = 'organization' AND current_user_id() IS NOT NULL AND (
 (s.scope = 'SYSTEM' AND s."organizationId" IS NULL AND s."userId" IS NULL AND s."isPublished" AND s."archivedAt" IS NULL)
 OR (s.scope = 'ORGANIZATION' AND s."organizationId" = current_tenant_id() AND
 (s."userId" = current_user_id() OR (s."isPublished" AND s."archivedAt" IS NULL))))));

DROP POLICY IF EXISTS skill_owner_insert ON "skill_file";
CREATE POLICY skill_owner_insert ON "skill_file" FOR INSERT  WITH CHECK (EXISTS (SELECT 1 FROM "skill" s WHERE s.id = "skill_file"."skillId" AND current_tenant_type() = 'organization' AND current_user_id() IS NOT NULL AND s.scope = 'ORGANIZATION' AND s."organizationId" = current_tenant_id() AND s."userId" = current_user_id()));

DROP POLICY IF EXISTS skill_owner_update ON "skill_file";
CREATE POLICY skill_owner_update ON "skill_file" FOR UPDATE USING (EXISTS (SELECT 1 FROM "skill" s WHERE s.id = "skill_file"."skillId" AND current_tenant_type() = 'organization' AND current_user_id() IS NOT NULL AND s.scope = 'ORGANIZATION' AND s."organizationId" = current_tenant_id() AND s."userId" = current_user_id())) WITH CHECK (EXISTS (SELECT 1 FROM "skill" s WHERE s.id = "skill_file"."skillId" AND current_tenant_type() = 'organization' AND current_user_id() IS NOT NULL AND s.scope = 'ORGANIZATION' AND s."organizationId" = current_tenant_id() AND s."userId" = current_user_id()));

DROP POLICY IF EXISTS skill_owner_delete ON "skill_file";
CREATE POLICY skill_owner_delete ON "skill_file" FOR DELETE USING (EXISTS (SELECT 1 FROM "skill" s WHERE s.id = "skill_file"."skillId" AND current_tenant_type() = 'organization' AND current_user_id() IS NOT NULL AND s.scope = 'ORGANIZATION' AND s."organizationId" = current_tenant_id() AND s."userId" = current_user_id())) ;
