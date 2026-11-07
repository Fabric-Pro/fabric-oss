-- Owner-private, on-demand Slack capture. Forward recovery is to pause/disconnect
-- watches and retain receipts; future repairs are additive migrations. No provider I/O.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

/*
  Warnings:

  - A unique constraint covering the columns `[id,organizationId]` on the table `project` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateTable
CREATE TABLE "delivery_signal_watch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "integrationId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'SLACK',
    "installationId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "grantRevision" INTEGER NOT NULL DEFAULT 1,
    "retentionDays" INTEGER NOT NULL DEFAULT 7,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "captureWindowStart" TIMESTAMP(3),
    "captureWindowEnd" TIMESTAMP(3),
    "captureCursorCiphertext" TEXT,
    "captureCheckpointVersion" INTEGER NOT NULL DEFAULT 0,
    "captureComplete" BOOLEAN NOT NULL DEFAULT false,
    "captureGrantRevision" INTEGER,
    "lastWorkflowId" TEXT,
    "lastRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_signal_watch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_signal_source_grant" (
    "id" TEXT NOT NULL,
    "watchId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'ONLY_ME',
    "humanUserId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "botUserId" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_signal_source_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_signal_observation" (
    "id" TEXT NOT NULL,
    "watchId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "externalItemId" TEXT NOT NULL,
    "revisionKind" TEXT NOT NULL,
    "revisionValue" TEXT NOT NULL,
    "receiptKey" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "evidenceDigest" TEXT NOT NULL,
    "ciphertext" TEXT,
    "hasReplies" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_signal_observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_signal_source_command" (
    "id" TEXT NOT NULL,
    "watchId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "workflowId" TEXT,
    "expectedVersion" INTEGER,
    "grantRevision" INTEGER,
    "captureMode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_signal_source_command_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_signal_capture_page" (
    "id" TEXT NOT NULL,
    "watchId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "pageIndex" INTEGER NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_signal_capture_page_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_watch_owner_order_idx" ON "delivery_signal_watch"("organizationId", "userId", "projectId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "delivery_signal_watch_integrationId_idx" ON "delivery_signal_watch"("integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_watch_scope_key" ON "delivery_signal_watch"("id", "organizationId", "projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_watch_source_key" ON "delivery_signal_watch"("organizationId", "userId", "projectId", "provider", "installationId", "containerId");

-- CreateIndex
CREATE INDEX "delivery_signal_source_grant_organizationId_userId_projectI_idx" ON "delivery_signal_source_grant"("organizationId", "userId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_grant_revision_key" ON "delivery_signal_source_grant"("watchId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_grant_scope_key" ON "delivery_signal_source_grant"("id", "watchId", "organizationId", "projectId", "userId");

-- CreateIndex
CREATE INDEX "delivery_observation_owner_order_idx" ON "delivery_signal_observation"("organizationId", "userId", "projectId", "watchId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "delivery_observation_receipt_idx" ON "delivery_signal_observation"("watchId", "grantId", "receiptKey");

-- CreateIndex
CREATE INDEX "delivery_observation_expiry_idx" ON "delivery_signal_observation"("expiresAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_observation_variant_key" ON "delivery_signal_observation"("watchId", "grantId", "variantKey");

-- CreateIndex
CREATE INDEX "delivery_signal_source_command_watchId_createdAt_idx" ON "delivery_signal_source_command"("watchId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_source_command_request_key" ON "delivery_signal_source_command"("organizationId", "userId", "requestId");

-- CreateIndex
CREATE INDEX "delivery_signal_capture_page_organizationId_userId_projectI_idx" ON "delivery_signal_capture_page"("organizationId", "userId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_capture_page_receipt_key" ON "delivery_signal_capture_page"("watchId", "workflowId", "pageIndex");

-- CreateIndex
CREATE UNIQUE INDEX "project_id_org_delivery_key" ON "project"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "delivery_signal_watch" ADD CONSTRAINT "delivery_signal_watch_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_signal_watch" ADD CONSTRAINT "delivery_signal_watch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_signal_watch" ADD CONSTRAINT "delivery_signal_watch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_signal_watch" ADD CONSTRAINT "delivery_signal_watch_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "workflow_integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_signal_source_grant" ADD CONSTRAINT "delivery_signal_source_grant_watchId_organizationId_projec_fkey" FOREIGN KEY ("watchId", "organizationId", "projectId", "userId") REFERENCES "delivery_signal_watch"("id", "organizationId", "projectId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_signal_observation" ADD CONSTRAINT "delivery_signal_observation_grantId_watchId_organizationId_fkey" FOREIGN KEY ("grantId", "watchId", "organizationId", "projectId", "userId") REFERENCES "delivery_signal_source_grant"("id", "watchId", "organizationId", "projectId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_signal_source_command" ADD CONSTRAINT "delivery_signal_source_command_watchId_organizationId_proj_fkey" FOREIGN KEY ("watchId", "organizationId", "projectId", "userId") REFERENCES "delivery_signal_watch"("id", "organizationId", "projectId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_signal_capture_page" ADD CONSTRAINT "delivery_signal_capture_page_watchId_organizationId_projec_fkey" FOREIGN KEY ("watchId", "organizationId", "projectId", "userId") REFERENCES "delivery_signal_watch"("id", "organizationId", "projectId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bounds and opaque identity invariants are migration-owned; Prisma does not model CHECKs.
ALTER TABLE delivery_signal_watch ADD CONSTRAINT delivery_watch_identity CHECK (
 char_length(id) BETWEEN 1 AND 200 AND id=btrim(id)
 AND char_length("organizationId") BETWEEN 1 AND 200 AND "organizationId"=btrim("organizationId")
 AND char_length("projectId") BETWEEN 1 AND 200 AND "projectId"=btrim("projectId")
 AND char_length("userId") BETWEEN 1 AND 200 AND "userId"=btrim("userId")
 AND provider='SLACK' AND "installationId" ~ '^T[A-Z0-9]{8,199}$'
 AND "containerId" ~ '^[CG][A-Z0-9]{8,199}$'
 AND char_length(label) BETWEEN 1 AND 200 AND label !~ '[[:cntrl:]]'
 AND "state" IN ('ACTIVE','PAUSED','DISCONNECTED') AND version>0 AND "grantRevision">0
 AND "retentionDays" IN (7,30) AND "captureCheckpointVersion">=0
 AND isfinite("verifiedAt") AND isfinite("createdAt")
);
ALTER TABLE delivery_signal_watch ADD CONSTRAINT delivery_watch_checkpoint CHECK (
 ("captureWindowStart" IS NULL AND "captureWindowEnd" IS NULL AND "captureCursorCiphertext" IS NULL
  AND "captureGrantRevision" IS NULL AND NOT "captureComplete")
 OR ("captureWindowStart" IS NOT NULL AND "captureWindowEnd" IS NOT NULL
  AND isfinite("captureWindowStart") AND isfinite("captureWindowEnd")
  AND "captureWindowStart" < "captureWindowEnd"
  AND "captureWindowEnd" - "captureWindowStart" <= interval '7 days'
  AND "captureGrantRevision" IS NOT NULL AND "captureGrantRevision"="grantRevision"
  AND (("captureComplete" AND "captureCursorCiphertext" IS NULL)
    OR (NOT "captureComplete" AND "captureCursorCiphertext" IS NOT NULL)))
);
ALTER TABLE delivery_signal_watch ADD CONSTRAINT delivery_watch_cursor_ciphertext CHECK (
 "captureCursorCiphertext" IS NULL OR (octet_length("captureCursorCiphertext")<=16384
 AND "captureCursorCiphertext" ~ '^(k[0-9A-Za-z_-]+:)?[0-9a-fA-F]{64}:[0-9a-fA-F]{32}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$')
);
ALTER TABLE delivery_signal_source_grant ADD CONSTRAINT delivery_grant_bounds CHECK (
 revision>0 AND audience='ONLY_ME' AND char_length("humanUserId") BETWEEN 1 AND 200
 AND char_length("botId") BETWEEN 1 AND 200 AND char_length("botUserId") BETWEEN 1 AND 200
 AND char_length("adapterVersion") BETWEEN 1 AND 200 AND isfinite("verifiedAt")
 AND ("revokedAt" IS NULL OR isfinite("revokedAt"))
);
ALTER TABLE delivery_signal_observation ADD CONSTRAINT delivery_observation_bounds CHECK (
 char_length("externalItemId") BETWEEN 1 AND 200
 AND "revisionKind" IN ('INTEGER','DECIMAL','UTC_TIME','OPAQUE')
 AND char_length("revisionValue") BETWEEN 1 AND 512 AND "revisionValue" !~ '[[:cntrl:]]'
 AND "receiptKey" ~ '^[0-9a-f]{64}$' AND "variantKey" ~ '^[0-9a-f]{64}$'
 AND "evidenceDigest" ~ '^[0-9a-f]{64}$'
 AND isfinite("occurredAt") AND isfinite("expiresAt") AND "expiresAt">"createdAt"
 AND (ciphertext IS NULL OR (octet_length(ciphertext)<=262144
  AND ciphertext ~ '^(k[0-9A-Za-z_-]+:)?[0-9a-fA-F]{64}:[0-9a-fA-F]{32}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$'))
);
ALTER TABLE delivery_signal_source_command ADD CONSTRAINT delivery_source_command_bounds CHECK (
 "requestId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 AND operation IN ('CONFIGURE','PAUSE','RESUME','DISCONNECT','CAPTURE','CANCEL')
 AND "payloadHash" ~ '^[0-9a-f]{64}$' AND "expectedVersion" IS NOT NULL AND "expectedVersion">0
 AND "grantRevision" IS NOT NULL AND "grantRevision">0
 AND ("workflowId" IS NULL OR char_length("workflowId") BETWEEN 1 AND 200)
 AND ((operation='CAPTURE' AND "workflowId" IS NOT NULL AND "captureMode" IN ('RECENT','CONTINUE'))
   OR (operation='CANCEL' AND "workflowId" IS NOT NULL AND "captureMode" IS NULL)
   OR (operation IN ('CONFIGURE','PAUSE','RESUME','DISCONNECT') AND "workflowId" IS NULL AND "captureMode" IS NULL))
);
CREATE FUNCTION delivery_capture_page_result_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object'
  OR value - 'captured' - 'hasMore' - 'coverage' <> '{}'::jsonb
  OR jsonb_typeof(value->'captured') IS DISTINCT FROM 'number'
  OR jsonb_typeof(value->'hasMore') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(value->'coverage') IS DISTINCT FROM 'string'
  OR (value->>'captured') !~ '^(0|[1-9][0-9]{0,2})$'
  OR (value->>'coverage') NOT IN ('ROOT_MESSAGES_ONLY','PARTIAL')
  OR (value->>'captured')::integer > 200 THEN RETURN false; END IF;
 RETURN (value ? 'captured') AND (value ? 'hasMore') AND (value ? 'coverage');
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER TABLE delivery_signal_capture_page ADD CONSTRAINT delivery_capture_page_bounds CHECK (
 "pageIndex" BETWEEN 0 AND 4 AND char_length("workflowId") BETWEEN 1 AND 200
 AND octet_length(result::text)<=512 AND delivery_capture_page_result_valid(result)
);

-- No definer privileges: ordinary owner/org RLS remains in force inside these triggers.
CREATE FUNCTION delivery_watch_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND ROW(OLD.id,OLD."organizationId",OLD."projectId",OLD."userId",OLD.provider,OLD."installationId",OLD."containerId",OLD."createdAt")
  IS DISTINCT FROM ROW(NEW.id,NEW."organizationId",NEW."projectId",NEW."userId",NEW.provider,NEW."installationId",NEW."containerId",NEW."createdAt") THEN
  RAISE EXCEPTION 'Private source identity is immutable' USING ERRCODE='23514'; END IF;
 IF NEW."integrationId" IS NOT NULL AND (TG_OP='INSERT' OR NEW."integrationId" IS DISTINCT FROM OLD."integrationId")
  AND NOT EXISTS(SELECT 1 FROM public.workflow_integration i WHERE i.id=NEW."integrationId"
   AND i."organizationId"=NEW."organizationId" AND i."userId"=NEW."userId"
   AND i.provider::text='SLACK' AND i."workflowId" IS NULL AND i.name<>'SLACK_OAUTH_APP') THEN
  RAISE EXCEPTION 'Private source connection scope does not match' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.version<OLD.version OR NEW.version>OLD.version+1
  OR NEW."grantRevision"<OLD."grantRevision" OR NEW."grantRevision">OLD."grantRevision"+1
  OR NEW."captureCheckpointVersion"<OLD."captureCheckpointVersion" OR NEW."captureCheckpointVersion">OLD."captureCheckpointVersion"+1) THEN
  RAISE EXCEPTION 'Private source version is invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER delivery_watch_identity BEFORE INSERT OR UPDATE ON delivery_signal_watch
 FOR EACH ROW EXECUTE FUNCTION delivery_watch_identity_guard();
CREATE FUNCTION delivery_grant_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF ROW(OLD.id,OLD."watchId",OLD."organizationId",OLD."projectId",OLD."userId",OLD.revision,OLD.audience,OLD."humanUserId",OLD."botId",OLD."botUserId",OLD."adapterVersion",OLD."verifiedAt",OLD."createdAt")
  IS DISTINCT FROM ROW(NEW.id,NEW."watchId",NEW."organizationId",NEW."projectId",NEW."userId",NEW.revision,NEW.audience,NEW."humanUserId",NEW."botId",NEW."botUserId",NEW."adapterVersion",NEW."verifiedAt",NEW."createdAt")
  OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
  RAISE EXCEPTION 'Private source grant is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER delivery_grant_identity BEFORE UPDATE ON delivery_signal_source_grant
 FOR EACH ROW EXECUTE FUNCTION delivery_grant_identity_guard();
CREATE FUNCTION delivery_source_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Private source evidence and receipts are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER delivery_observation_immutable BEFORE UPDATE ON delivery_signal_observation
 FOR EACH ROW EXECUTE FUNCTION delivery_source_receipt_immutable();
CREATE TRIGGER delivery_command_immutable BEFORE UPDATE ON delivery_signal_source_command
 FOR EACH ROW EXECUTE FUNCTION delivery_source_receipt_immutable();
CREATE TRIGGER delivery_page_immutable BEFORE UPDATE ON delivery_signal_capture_page
 FOR EACH ROW EXECUTE FUNCTION delivery_source_receipt_immutable();

ALTER TABLE "delivery_signal_watch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_signal_watch" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "delivery_signal_watch"
 USING (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id())
 WITH CHECK (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id());

ALTER TABLE "delivery_signal_source_grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_signal_source_grant" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "delivery_signal_source_grant"
 USING (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id())
 WITH CHECK (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id());

ALTER TABLE "delivery_signal_observation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_signal_observation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "delivery_signal_observation"
 USING (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id())
 WITH CHECK (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id());

ALTER TABLE "delivery_signal_source_command" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_signal_source_command" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "delivery_signal_source_command"
 USING (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id())
 WITH CHECK (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id());

ALTER TABLE "delivery_signal_capture_page" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "delivery_signal_capture_page" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "delivery_signal_capture_page"
 USING (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id())
 WITH CHECK (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id());

COMMIT;
