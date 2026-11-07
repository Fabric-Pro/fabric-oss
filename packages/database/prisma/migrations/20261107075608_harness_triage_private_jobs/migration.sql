-- CreateTable
CREATE TABLE "harness_triage_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "goalCiphertext" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "credential" JSONB NOT NULL,
    "model" JSONB NOT NULL,
    "workflowId" TEXT NOT NULL,
    "nativeRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "failureCode" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "resultCiphertext" TEXT,
    "reviews" JSONB NOT NULL DEFAULT '{}',
    "maxTokens" INTEGER NOT NULL,
    "maxMicroUsd" BIGINT NOT NULL,
    "measuredTokens" BIGINT NOT NULL DEFAULT 0,
    "measuredMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "outstandingTokens" BIGINT NOT NULL DEFAULT 0,
    "outstandingMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "harness_triage_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "harness_triage_call" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'RESERVED',
    "reservedTokens" BIGINT NOT NULL,
    "reservedMicroUsd" BIGINT NOT NULL,
    "measuredTokens" BIGINT,
    "measuredMicroUsd" BIGINT,
    "responseCiphertext" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "harness_triage_call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "harness_triage_budget" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "measuredTokens" BIGINT NOT NULL DEFAULT 0,
    "measuredMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "outstandingTokens" BIGINT NOT NULL DEFAULT 0,
    "outstandingMicroUsd" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "harness_triage_budget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "harness_triage_run_workflowId_key" ON "harness_triage_run"("workflowId");

-- CreateIndex
CREATE INDEX "harness_triage_run_organizationId_userId_projectId_createdA_idx" ON "harness_triage_run"("organizationId", "userId", "projectId", "createdAt" DESC, "id");

-- CreateIndex
CREATE INDEX "harness_triage_run_expiresAt_idx" ON "harness_triage_run"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "harness_triage_run_organizationId_userId_requestId_key" ON "harness_triage_run"("organizationId", "userId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "harness_triage_run_id_organizationId_projectId_userId_key" ON "harness_triage_run"("id", "organizationId", "projectId", "userId");

-- CreateIndex
CREATE INDEX "harness_triage_call_organizationId_userId_projectId_idx" ON "harness_triage_call"("organizationId", "userId", "projectId");

-- CreateIndex
CREATE INDEX "harness_triage_call_expiresAt_idx" ON "harness_triage_call"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "harness_triage_call_runId_ordinal_key" ON "harness_triage_call"("runId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "harness_triage_budget_organizationId_periodStart_key" ON "harness_triage_budget"("organizationId", "periodStart");

-- AddForeignKey
ALTER TABLE "harness_triage_run" ADD CONSTRAINT "harness_triage_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harness_triage_run" ADD CONSTRAINT "harness_triage_run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harness_triage_run" ADD CONSTRAINT "harness_triage_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harness_triage_call" ADD CONSTRAINT "harness_triage_call_runId_organizationId_projectId_userId_fkey" FOREIGN KEY ("runId", "organizationId", "projectId", "userId") REFERENCES "harness_triage_run"("id", "organizationId", "projectId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harness_triage_budget" ADD CONSTRAINT "harness_triage_budget_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Private owner data is never an organization-wide Inbox item.
ALTER TABLE harness_triage_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_triage_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON harness_triage_run
 USING (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id())
 WITH CHECK (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id());
ALTER TABLE harness_triage_call ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_triage_call FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON harness_triage_call
 USING (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id())
 WITH CHECK (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id());
ALTER TABLE harness_triage_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_triage_budget FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON harness_triage_budget
 USING (current_tenant_type()='organization' AND "organizationId"=current_tenant_id())
 WITH CHECK (current_tenant_type()='organization' AND "organizationId"=current_tenant_id());
ALTER TABLE harness_triage_run ADD CONSTRAINT harness_triage_run_bounds CHECK (
 status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','OUTCOME_UNKNOWN')
 AND "maxTokens">0 AND "maxMicroUsd">0 AND "measuredTokens">=0 AND "outstandingTokens">=0
 AND "measuredMicroUsd">=0 AND "outstandingMicroUsd">=0
 AND jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence) BETWEEN 1 AND 5
 AND "inputHash" ~ '^[a-f0-9]{64}$');
ALTER TABLE harness_triage_call ADD CONSTRAINT harness_triage_call_bounds CHECK (
 state IN ('RESERVED','DISPATCHED','SETTLED','UNKNOWN','RELEASED') AND ordinal BETWEEN 1 AND 6
 AND "reservedTokens">0 AND "reservedMicroUsd">0 AND "requestDigest" ~ '^[a-f0-9]{64}$');
ALTER TABLE harness_triage_budget ADD CONSTRAINT harness_triage_budget_nonnegative CHECK (
 "measuredTokens">=0 AND "outstandingTokens">=0 AND "measuredMicroUsd">=0 AND "outstandingMicroUsd">=0);

-- Source revocation deletes all derived encrypted bodies, even completed-call caches.
CREATE FUNCTION purge_private_triage_source() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_id text;
BEGIN
 source_id := CASE WHEN TG_TABLE_NAME='delivery_signal_watch' THEN OLD.id ELSE OLD."watchId" END;
 IF TG_OP='DELETE' OR (TG_TABLE_NAME='delivery_signal_watch' AND NEW.state='DISCONNECTED')
    OR (TG_TABLE_NAME='delivery_signal_source_grant' AND NEW."revokedAt" IS NOT NULL) THEN
  UPDATE public.harness_triage_call SET "responseCiphertext"=NULL,"updatedAt"=now()
   WHERE "runId" IN (SELECT id FROM public.harness_triage_run WHERE "organizationId"=OLD."organizationId" AND "userId"=OLD."userId"
    AND evidence @> jsonb_build_array(jsonb_build_object('watchId',source_id)));
  UPDATE public.harness_triage_run SET "goalCiphertext"='',"resultCiphertext"=NULL,reviews='{}'::jsonb,
   "cancelRequestedAt"=COALESCE("cancelRequestedAt",now()),status=CASE WHEN status IN ('QUEUED','RUNNING') THEN 'CANCELLED' ELSE status END,"updatedAt"=now()
   WHERE "organizationId"=OLD."organizationId" AND "userId"=OLD."userId"
    AND evidence @> jsonb_build_array(jsonb_build_object('watchId',source_id));
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER purge_triage_watch AFTER UPDATE OF state OR DELETE ON delivery_signal_watch
 FOR EACH ROW EXECUTE FUNCTION purge_private_triage_source();
CREATE TRIGGER purge_triage_grant AFTER UPDATE OF "revokedAt" OR DELETE ON delivery_signal_source_grant
 FOR EACH ROW EXECUTE FUNCTION purge_private_triage_source();
