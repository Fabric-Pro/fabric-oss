-- CreateTable
CREATE TABLE "frame_change_proposal" (
    "id" TEXT NOT NULL,
    "frameId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "baseUpdatedAt" TIMESTAMP(3) NOT NULL,
    "baseContentHash" TEXT NOT NULL,
    "baseContent" TEXT NOT NULL,
    "proposedContent" TEXT NOT NULL,
    "proposedContentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "appliedUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "frame_change_proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "frame_approved_revision" (
    "id" TEXT NOT NULL,
    "frameId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "origin" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "frame_approved_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "frame_change_proposal_organizationId_userId_frameId_created_idx" ON "frame_change_proposal"("organizationId", "userId", "frameId", "createdAt" DESC, "id");

-- CreateIndex
CREATE UNIQUE INDEX "frame_change_proposal_frameId_userId_requestId_key" ON "frame_change_proposal"("frameId", "userId", "requestId");

-- CreateIndex
CREATE INDEX "frame_approved_revision_organizationId_userId_frameId_creat_idx" ON "frame_approved_revision"("organizationId", "userId", "frameId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "frame_approved_revision_frameId_contentHash_origin_key" ON "frame_approved_revision"("frameId", "contentHash", "origin");

-- AddForeignKey
ALTER TABLE "frame_change_proposal" ADD CONSTRAINT "frame_change_proposal_frameId_fkey" FOREIGN KEY ("frameId") REFERENCES "agent_workspace_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "frame_change_proposal" ADD CONSTRAINT "frame_change_proposal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "frame_change_proposal" ADD CONSTRAINT "frame_change_proposal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "frame_approved_revision" ADD CONSTRAINT "frame_approved_revision_frameId_fkey" FOREIGN KEY ("frameId") REFERENCES "agent_workspace_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "frame_approved_revision" ADD CONSTRAINT "frame_approved_revision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "frame_approved_revision" ADD CONSTRAINT "frame_approved_revision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- These checks and indexes apply only to the new, empty review tables.
ALTER TABLE frame_change_proposal ADD CONSTRAINT frame_change_proposal_state CHECK (
 status IN ('PENDING','APPLIED','DISMISSED') AND (status='APPLIED')=("appliedUpdatedAt" IS NOT NULL)
 AND "requestHash" ~ '^[a-f0-9]{64}$' AND "baseContentHash" ~ '^[a-f0-9]{64}$' AND "proposedContentHash" ~ '^[a-f0-9]{64}$'
 AND octet_length("baseContent")<=1000000 AND octet_length("proposedContent")<=1000000
 AND "baseContentHash"=encode(sha256(convert_to("baseContent",'UTF8')),'hex')
 AND "proposedContentHash"=encode(sha256(convert_to("proposedContent",'UTF8')),'hex')
);
ALTER TABLE frame_approved_revision ADD CONSTRAINT frame_approved_revision_snapshot CHECK (
 origin IN ('APPROVED','LEGACY_PUBLICATION') AND octet_length(content)<=8000000
 AND "contentHash"=encode(sha256(convert_to(content,'UTF8')),'hex')
);
CREATE FUNCTION public.enforce_frame_review_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE parent public.agent_workspace_file%ROWTYPE;
BEGIN
 SELECT * INTO parent FROM public.agent_workspace_file WHERE id=NEW."frameId";
 IF NOT FOUND OR parent."userId" IS DISTINCT FROM NEW."userId" OR parent."organizationId" IS DISTINCT FROM NEW."organizationId" OR parent."fileType"::text NOT IN ('FRAME','SLIDESHOW') THEN
  RAISE EXCEPTION 'Frame review owner does not match the parent page' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='frame_approved_revision' THEN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Approved page snapshots are immutable' USING ERRCODE='23514';END IF;
  IF NEW.content IS DISTINCT FROM parent.content OR NEW."sourceUpdatedAt" IS DISTINCT FROM parent."updatedAt" THEN RAISE EXCEPTION 'Approval must capture the current page' USING ERRCODE='23514';END IF;
 ELSE
  IF TG_OP='INSERT' AND (NEW."baseContent" IS DISTINCT FROM parent.content OR NEW."baseUpdatedAt" IS DISTINCT FROM parent."updatedAt" OR NEW.status<>'PENDING') THEN RAISE EXCEPTION 'Proposal must capture the current page' USING ERRCODE='23514';END IF;
  IF (NEW."proposedContent"::jsonb)->'metadata' IS DISTINCT FROM (NEW."baseContent"::jsonb)->'metadata'
   OR (NEW."proposedContent"::jsonb)->'kind' IS DISTINCT FROM (NEW."baseContent"::jsonb)->'kind'
   OR (NEW."proposedContent"::jsonb)->'theme'->'branding' IS DISTINCT FROM (NEW."baseContent"::jsonb)->'theme'->'branding' THEN
   RAISE EXCEPTION 'A content proposal cannot change page authority or branding provenance' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
   IF ROW(NEW.id,NEW."frameId",NEW."userId",NEW."organizationId",NEW."requestId",NEW."requestHash",NEW."baseUpdatedAt",NEW."baseContentHash",NEW."baseContent",NEW."proposedContent",NEW."proposedContentHash",NEW."createdAt") IS DISTINCT FROM ROW(OLD.id,OLD."frameId",OLD."userId",OLD."organizationId",OLD."requestId",OLD."requestHash",OLD."baseUpdatedAt",OLD."baseContentHash",OLD."baseContent",OLD."proposedContent",OLD."proposedContentHash",OLD."createdAt")
    OR OLD.status<>'PENDING' AND ROW(NEW.status,NEW."appliedUpdatedAt") IS DISTINCT FROM ROW(OLD.status,OLD."appliedUpdatedAt") THEN
    RAISE EXCEPTION 'Proposal evidence and terminal decisions are immutable' USING ERRCODE='23514';
   END IF;
   IF NEW.status='APPLIED' AND (NEW."appliedUpdatedAt" IS DISTINCT FROM parent."updatedAt" OR NEW."proposedContent" IS DISTINCT FROM parent.content) THEN RAISE EXCEPTION 'Applied proposal must match the saved page' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER frame_change_proposal_binding BEFORE INSERT OR UPDATE ON frame_change_proposal FOR EACH ROW EXECUTE FUNCTION public.enforce_frame_review_binding();
CREATE TRIGGER frame_approved_revision_binding BEFORE INSERT OR UPDATE ON frame_approved_revision FOR EACH ROW EXECUTE FUNCTION public.enforce_frame_review_binding();
ALTER TABLE frame_change_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE frame_change_proposal FORCE ROW LEVEL SECURITY;
ALTER TABLE frame_approved_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE frame_approved_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON frame_change_proposal FOR ALL USING (
 current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id()
) WITH CHECK (
 current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id()
);
CREATE POLICY tenant_isolation ON frame_approved_revision FOR ALL USING (
 current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id()
) WITH CHECK (
 current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id()
);

-- All content writers, including generic workspace file updates, retain the first public version.
CREATE FUNCTION public.pin_legacy_frame_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE snapshot_id text;
BEGIN
 IF OLD."fileType"::text IN ('FRAME','SLIDESHOW') AND OLD."isPublic" AND OLD.content IS DISTINCT FROM NEW.content
  AND NOT coalesce(OLD.metadata,'{}'::jsonb) ? 'publishedFrameRevisionId' THEN
  snapshot_id := 'frame-legacy-' || encode(sha256(convert_to(OLD.id || ':' || OLD.content,'UTF8')),'hex');
  INSERT INTO public.frame_approved_revision(id,"frameId","userId","organizationId","contentHash",content,"sourceUpdatedAt",origin)
   VALUES(snapshot_id,OLD.id,OLD."userId",OLD."organizationId",encode(sha256(convert_to(OLD.content,'UTF8')),'hex'),OLD.content,OLD."updatedAt",'LEGACY_PUBLICATION');
  NEW.metadata := coalesce(NEW.metadata,'{}'::jsonb) || jsonb_build_object('publishedFrameRevisionId',snapshot_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pin_legacy_frame_publication BEFORE UPDATE OF content ON agent_workspace_file FOR EACH ROW EXECUTE FUNCTION public.pin_legacy_frame_publication();
-- App roles cannot erase/recreate review receipts. Parent-row deletion still cascades for retention.
CREATE FUNCTION public.keep_frame_review_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF pg_trigger_depth()=1 AND EXISTS(SELECT 1 FROM public.agent_workspace_file WHERE id=OLD."frameId") THEN
  RAISE EXCEPTION 'Page review evidence is retained while the page exists' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER keep_frame_proposal BEFORE DELETE ON frame_change_proposal FOR EACH ROW EXECUTE FUNCTION public.keep_frame_review_evidence();
CREATE TRIGGER keep_frame_approval BEFORE DELETE ON frame_approved_revision FOR EACH ROW EXECUTE FUNCTION public.keep_frame_review_evidence();
