-- Native repository edits reuse the durable instruction-operation parent, but
-- store only the explicit changed paths. They are never a materialized tree.
CREATE TYPE "ProjectInstructionContentKind" AS ENUM ('FULL_SNAPSHOT', 'GIT_INTENT');
CREATE TYPE "ProjectInstructionGitIntentOperation" AS ENUM ('PUT', 'DELETE');

ALTER TABLE "project_instruction_snapshot"
  ADD COLUMN "contentKind" "ProjectInstructionContentKind" NOT NULL DEFAULT 'FULL_SNAPSHOT',
  ADD COLUMN "repositoryGeneration" INTEGER,
  ADD COLUMN "repositoryBaseSha" TEXT;

CREATE TABLE "project_instruction_git_intent_entry" (
  "id" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "operation" "ProjectInstructionGitIntentOperation" NOT NULL,
  "path" TEXT NOT NULL,
  "baseObjectId" TEXT,
  "baseMode" INTEGER,
  "storageKey" TEXT,
  "sha256" TEXT,
  "size" INTEGER,
  "mimeType" TEXT,
  "isText" BOOLEAN,
  "mode" INTEGER,
  "kind" "ProjectInstructionFileKind",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_instruction_git_intent_entry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_instruction_git_intent_entry_snapshotId_path_key"
  ON "project_instruction_git_intent_entry"("snapshotId", "path");
CREATE INDEX "project_instruction_git_intent_entry_projectId_idx"
  ON "project_instruction_git_intent_entry"("projectId");
CREATE INDEX "project_instruction_git_intent_entry_organizationId_idx"
  ON "project_instruction_git_intent_entry"("organizationId");
CREATE INDEX "project_instruction_git_intent_entry_userId_idx"
  ON "project_instruction_git_intent_entry"("userId");

ALTER TABLE "project_instruction_git_intent_entry"
  ADD CONSTRAINT "project_instruction_git_intent_entry_snapshotId_projectId_fkey"
  FOREIGN KEY ("snapshotId", "projectId") REFERENCES "project_instruction_snapshot"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "project_instruction_git_intent_entry_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "project_instruction_git_intent_entry_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "project_instruction_git_intent_entry_base_pair"
  CHECK (("baseObjectId" IS NULL) = ("baseMode" IS NULL)),
  ADD CONSTRAINT "project_instruction_git_intent_entry_payload"
  CHECK (
    ("operation" = 'DELETE'
      AND "storageKey" IS NULL AND "sha256" IS NULL AND "size" IS NULL
      AND "mimeType" IS NULL AND "isText" IS NULL AND "mode" IS NULL AND "kind" IS NULL)
    OR
    ("operation" = 'PUT'
      AND "storageKey" IS NOT NULL AND "sha256" IS NOT NULL AND "size" IS NOT NULL
      AND "mimeType" IS NOT NULL AND "isText" IS NOT NULL AND "mode" IS NOT NULL AND "kind" IS NOT NULL)
  );

ALTER TABLE "project_instruction_snapshot"
  ADD CONSTRAINT "project_instruction_snapshot_git_intent_shape"
  CHECK (
    "contentKind" <> 'GIT_INTENT'
    OR (
      "source" = 'REPOSITORY'
      AND "repositoryIntegrationId" IS NOT NULL
      AND "sourceRef" IS NOT NULL
      AND length("sourceRef") > 0
      AND "sourceCommitSha" IS NOT NULL
      AND "sourceCommitSha" ~ '^[0-9a-f]{40}$'
      AND "sourceCommitSha" = "repositoryBaseSha"
      AND "repositoryGeneration" IS NOT NULL
      AND "repositoryGeneration" > 0
      AND "repositoryBaseSha" IS NOT NULL
      AND "publishOnReady" = FALSE
      AND "publishBeforeScan" = FALSE
      AND "deferredScanStatus" IS NULL
      AND "deferredScanFindings" IS NULL
      AND "deferredScanCompletedAt" IS NULL
      AND "scanRulesVersion" IS NULL
      AND "fileCount" = 0
      AND "storedBytes" = 0
      AND "excludedCount" = 0
      AND "excludedPaths" = '[]'::jsonb
      AND "digest" IS NULL
      AND "baseSnapshotId" IS NULL
      AND "baseVersion" IS NULL
      AND "publishedAt" IS NULL
      AND "proposalDestination" IN ('REPOSITORY', 'REPOSITORY_COMMIT')
    )
  ) NOT VALID;

CREATE FUNCTION guard_instruction_git_intent_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."contentKind" = 'GIT_INTENT' AND (
    NEW."contentKind" IS DISTINCT FROM OLD."contentKind"
    OR NEW."repositoryGeneration" IS DISTINCT FROM OLD."repositoryGeneration"
    OR NEW."repositoryBaseSha" IS DISTINCT FROM OLD."repositoryBaseSha"
    OR NEW."repositoryIntegrationId" IS DISTINCT FROM OLD."repositoryIntegrationId"
    OR NEW."sourceRef" IS DISTINCT FROM OLD."sourceRef"
    OR NEW."sourceCommitSha" IS DISTINCT FROM OLD."sourceCommitSha"
    OR NEW."settingsFrozen" IS DISTINCT FROM OLD."settingsFrozen"
    OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
    OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
  ) THEN
    RAISE EXCEPTION 'GIT_INTENT_IMMUTABLE: native repository operation identity cannot change'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."contentKind" = 'GIT_INTENT'
    AND OLD."status" <> 'RECEIVING' AND NEW."status" = 'RECEIVING' THEN
    RAISE EXCEPTION 'GIT_INTENT_SEALED: native repository operations cannot reopen admission'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."contentKind" = 'FULL_SNAPSHOT'
    AND NEW."contentKind" = 'GIT_INTENT' THEN
    RAISE EXCEPTION 'GIT_INTENT_IMMUTABLE: a snapshot cannot become a native repository operation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER instruction_git_intent_snapshot_immutable
BEFORE UPDATE ON "project_instruction_snapshot"
FOR EACH ROW EXECUTE FUNCTION guard_instruction_git_intent_snapshot();

-- A full snapshot may not inherit bytes from a native operation. This stays
-- enforced after a project switches to UPLOAD, where API-only source checks
-- would otherwise be bypassed by a historical intent id.
CREATE FUNCTION guard_instruction_git_intent_base()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE base_kind "ProjectInstructionContentKind";
BEGIN
  IF NEW."baseSnapshotId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT s."contentKind" INTO base_kind
  FROM "project_instruction_snapshot" s
  WHERE s."id" = NEW."baseSnapshotId"
    AND s."projectId" = NEW."projectId"
    AND s."organizationId" = NEW."organizationId";
  IF base_kind = 'GIT_INTENT' THEN
    RAISE EXCEPTION 'GIT_INTENT_INHERITANCE_FORBIDDEN: native repository operations cannot be snapshot bases'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER instruction_git_intent_base
BEFORE INSERT OR UPDATE OF "baseSnapshotId", "projectId", "organizationId"
ON "project_instruction_snapshot"
FOR EACH ROW EXECUTE FUNCTION guard_instruction_git_intent_base();

CREATE FUNCTION guard_instruction_git_intent_entry()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_snapshot_id text;
  entry_project_id text;
  entry_organization_id text;
  entry_user_id text;
  snapshot_org text;
  snapshot_user text;
  snapshot_kind "ProjectInstructionContentKind";
  snapshot_status "ProjectInstructionSnapshotStatus";
BEGIN
  entry_snapshot_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."snapshotId" ELSE NEW."snapshotId" END;
  entry_project_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."projectId" ELSE NEW."projectId" END;
  entry_organization_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."organizationId" ELSE NEW."organizationId" END;
  entry_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."userId" ELSE NEW."userId" END;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'GIT_INTENT_IMMUTABLE: native repository operation entries cannot change'
      USING ERRCODE = '55000';
  END IF;
  SELECT s."organizationId", s."userId", s."contentKind", s."status"
    INTO snapshot_org, snapshot_user, snapshot_kind, snapshot_status
  FROM "project_instruction_snapshot" s
  WHERE s."id" = entry_snapshot_id AND s."projectId" = entry_project_id;
  IF NOT FOUND THEN
    -- Cascading deletion runs after its parent row has gone. An orphan cannot
    -- otherwise exist because the composite foreign key owns this child.
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'GIT_INTENT_INVALID_PARENT: entries require their owning native repository operation'
      USING ERRCODE = '23503';
  END IF;
  IF snapshot_kind <> 'GIT_INTENT'
    OR snapshot_org IS DISTINCT FROM entry_organization_id
    OR snapshot_user IS DISTINCT FROM entry_user_id THEN
    RAISE EXCEPTION 'GIT_INTENT_INVALID_PARENT: entries require their owning native repository operation'
      USING ERRCODE = '23503';
  END IF;
  IF snapshot_status <> 'RECEIVING' THEN
    RAISE EXCEPTION 'GIT_INTENT_SEALED: native repository operation entries are fixed after admission'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER instruction_git_intent_entry_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "project_instruction_git_intent_entry"
FOR EACH ROW EXECUTE FUNCTION guard_instruction_git_intent_entry();

CREATE FUNCTION guard_instruction_file_snapshot_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE content_kind "ProjectInstructionContentKind";
BEGIN
  SELECT s."contentKind" INTO content_kind
  FROM "project_instruction_snapshot" s
  WHERE s."id" = NEW."snapshotId" AND s."projectId" = NEW."projectId";
  IF NOT FOUND OR content_kind <> 'FULL_SNAPSHOT' THEN
    RAISE EXCEPTION 'GIT_INTENT_FILE_TREE_FORBIDDEN: native repository operations have only intent entries'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER instruction_file_snapshot_kind
BEFORE INSERT OR UPDATE OF "snapshotId", "projectId" ON "project_instruction_file"
FOR EACH ROW EXECUTE FUNCTION guard_instruction_file_snapshot_kind();

-- Direct repository operations are allowed through the existing snapshot
-- operation parent. Ordinary full repository imports remain blocked unless a
-- structurally valid migration explicitly allows them.
CREATE OR REPLACE FUNCTION guard_instruction_repository_snapshot_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE settings jsonb;
BEGIN
  SELECT p."instructionSettings" INTO settings FROM "project" p
  WHERE p."id" = NEW."projectId" AND p."organizationId" = NEW."organizationId"
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instruction snapshot project or organization does not exist'
      USING ERRCODE = '23503';
  END IF;
  IF NEW."contentKind" = 'GIT_INTENT' THEN
    IF settings->>'sourceOfTruth' IS DISTINCT FROM 'REPOSITORY' THEN
      RAISE EXCEPTION 'GIT_INTENT_REPOSITORY_REQUIRED: native repository operations require a repository project'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF settings->>'sourceOfTruth' = 'REPOSITORY'
    AND NOT instruction_repository_migration_import_allowed(
      settings, NEW."projectId", NEW."organizationId", NEW."source"::text,
      NEW."settingsFrozen"
    ) THEN
    RAISE EXCEPTION 'REPOSITORY_DIRECT_READ: repository instructions do not accept snapshots'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

-- No GIT_INTENT may ever be a published/history pointer, including after a
-- project later switches back to UPLOAD. The existing direct-mode guard still
-- handles full snapshot pointer changes while repository mode is active.
CREATE OR REPLACE FUNCTION guard_instruction_repository_publication()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot_source text; frozen jsonb; content_kind "ProjectInstructionContentKind";
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW."publishedInstructionSnapshotId" IS NOT DISTINCT FROM OLD."publishedInstructionSnapshotId" THEN
    RETURN NEW;
  END IF;
  IF NEW."publishedInstructionSnapshotId" IS NULL THEN
    IF TG_OP = 'UPDATE' AND NEW."instructionSettings"->>'sourceOfTruth' = 'REPOSITORY' THEN
      RAISE EXCEPTION 'REPOSITORY_DIRECT_READ: repository instructions do not publish snapshots'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT s."source"::text, s."settingsFrozen", s."contentKind"
    INTO snapshot_source, frozen, content_kind
  FROM "project_instruction_snapshot" s
  WHERE s."id" = NEW."publishedInstructionSnapshotId"
    AND s."projectId" = NEW."id" AND s."organizationId" = NEW."organizationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REPOSITORY_DIRECT_READ: repository instructions do not publish snapshots'
      USING ERRCODE = '55000';
  END IF;
  IF content_kind = 'GIT_INTENT' THEN
    RAISE EXCEPTION 'GIT_INTENT_NONPUBLIC: native repository operations cannot be published'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."instructionSettings"->>'sourceOfTruth' = 'REPOSITORY'
    AND NOT instruction_repository_migration_import_allowed(
      NEW."instructionSettings", NEW."id", NEW."organizationId", snapshot_source, frozen
    ) THEN
    RAISE EXCEPTION 'REPOSITORY_DIRECT_READ: repository instructions do not publish snapshots'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER instruction_repository_publication ON "project";
CREATE TRIGGER instruction_repository_publication_insert
BEFORE INSERT ON "project"
FOR EACH ROW EXECUTE FUNCTION guard_instruction_repository_publication();
CREATE TRIGGER instruction_repository_publication
BEFORE UPDATE OF "publishedInstructionSnapshotId" ON "project"
FOR EACH ROW EXECUTE FUNCTION guard_instruction_repository_publication();
