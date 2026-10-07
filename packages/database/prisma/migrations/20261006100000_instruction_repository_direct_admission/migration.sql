-- Repository reads no longer allocate a Fabric snapshot. Keep the temporary
-- first import of an already-open upload migration bound to its sync row.
CREATE FUNCTION instruction_repository_migration_import_allowed(
  settings jsonb, project_id text, organization_id text,
  snapshot_source text, frozen jsonb
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    snapshot_source = 'REPOSITORY'
    AND jsonb_typeof(settings->'migration') = 'object'
    AND settings->'migration'->'v' = '1'::jsonb
    AND settings->'migration'->>'state' = 'SWITCHING'
    AND jsonb_typeof(settings->'migration'->'syncId') = 'string'
    AND jsonb_typeof(settings->'migration'->'startedAt') = 'string'
    AND jsonb_typeof(settings->'migration'->'userId') = 'string'
    AND jsonb_typeof(settings->'migration'->'branchId') IN ('string', 'null')
    AND jsonb_typeof(settings->'migration'->'snapshotId') IN ('string', 'null')
    AND jsonb_typeof(settings->'migration'->'pullRequestUrl') IN ('string', 'null')
    AND frozen->>'syncId' = settings->'migration'->>'syncId'
    AND EXISTS (
      SELECT 1 FROM "project_instruction_repository_sync" s
      WHERE s."id" = settings->'migration'->>'syncId'
        AND s."projectId" = project_id
        AND s."organizationId" = organization_id
    ), false);
$$;

CREATE FUNCTION guard_instruction_repository_snapshot_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE settings jsonb;
BEGIN
  -- Use the same lock as configuration writers, before inspecting the mode.
  -- NO KEY UPDATE also remains compatible with snapshot foreign-key checks.
  SELECT p."instructionSettings" INTO settings FROM "project" p
  WHERE p."id" = NEW."projectId" AND p."organizationId" = NEW."organizationId"
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instruction snapshot project or organization does not exist'
      USING ERRCODE = '23503';
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

CREATE TRIGGER instruction_repository_snapshot_insert
BEFORE INSERT ON "project_instruction_snapshot"
FOR EACH ROW EXECUTE FUNCTION guard_instruction_repository_snapshot_insert();

CREATE FUNCTION guard_instruction_repository_publication()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot_source text; frozen jsonb;
BEGIN
  IF NEW."publishedInstructionSnapshotId" IS NOT DISTINCT FROM OLD."publishedInstructionSnapshotId"
    OR NEW."instructionSettings"->>'sourceOfTruth' IS DISTINCT FROM 'REPOSITORY' THEN
    RETURN NEW;
  END IF;
  SELECT s."source"::text, s."settingsFrozen" INTO snapshot_source, frozen
  FROM "project_instruction_snapshot" s
  WHERE s."id" = NEW."publishedInstructionSnapshotId"
    AND s."projectId" = NEW."id" AND s."organizationId" = NEW."organizationId";
  IF NOT FOUND OR NOT instruction_repository_migration_import_allowed(
    NEW."instructionSettings", NEW."id", NEW."organizationId", snapshot_source, frozen
  ) THEN
    RAISE EXCEPTION 'REPOSITORY_DIRECT_READ: repository instructions do not publish snapshots'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER instruction_repository_publication
BEFORE UPDATE OF "publishedInstructionSnapshotId" ON "project"
FOR EACH ROW EXECUTE FUNCTION guard_instruction_repository_publication();
