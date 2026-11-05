-- CreateTable
CREATE TABLE "agent_test_case" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentSId" VARCHAR(200) NOT NULL,
    "originInstanceId" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "input" TEXT NOT NULL,
    "checksJson" JSONB NOT NULL,
    "sourceScopeJson" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_test_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_test_run" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "agentSId" VARCHAR(200) NOT NULL,
    "agentVersion" INTEGER NOT NULL,
    "caseRevision" INTEGER NOT NULL,
    "caseInput" TEXT NOT NULL,
    "checksJson" JSONB NOT NULL,
    "sourceScopeJson" JSONB NOT NULL,
    "requestKey" VARCHAR(36) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ADMITTING',
    "verdict" VARCHAR(12),
    "executionId" TEXT,
    "nativeWorkflowId" VARCHAR(256),
    "nativeRunId" VARCHAR(64),
    "evaluationWorkflowId" VARCHAR(256) NOT NULL,
    "evaluationRunId" VARCHAR(64),
    "reportJson" JSONB,
    "errorCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_test_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_test_case_organizationId_userId_agentSId_createdAt_idx" ON "agent_test_case"("organizationId", "userId", "agentSId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "agent_test_case_originInstanceId_idx" ON "agent_test_case"("originInstanceId");

-- CreateIndex
CREATE INDEX "agent_test_case_userId_idx" ON "agent_test_case"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_test_case_id_org_user_key" ON "agent_test_case"("id", "organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_test_run_executionId_key" ON "agent_test_run"("executionId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_test_run_evaluationWorkflowId_key" ON "agent_test_run"("evaluationWorkflowId");

-- CreateIndex
CREATE INDEX "agent_test_run_organizationId_userId_agentSId_createdAt_idx" ON "agent_test_run"("organizationId", "userId", "agentSId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "agent_test_run_caseId_createdAt_idx" ON "agent_test_run"("caseId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "agent_test_run_instanceId_idx" ON "agent_test_run"("instanceId");

-- CreateIndex
CREATE INDEX "agent_test_run_userId_idx" ON "agent_test_run"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_test_run_actor_request_key" ON "agent_test_run"("organizationId", "userId", "requestKey");

-- AddForeignKey
ALTER TABLE "agent_test_case" ADD CONSTRAINT "agent_test_case_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_test_case" ADD CONSTRAINT "agent_test_case_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_test_case" ADD CONSTRAINT "agent_test_case_originInstanceId_fkey" FOREIGN KEY ("originInstanceId") REFERENCES "agent_template_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_test_run" ADD CONSTRAINT "agent_test_run_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_test_run" ADD CONSTRAINT "agent_test_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_test_run" ADD CONSTRAINT "agent_test_run_caseId_organizationId_userId_fkey" FOREIGN KEY ("caseId", "organizationId", "userId") REFERENCES "agent_test_case"("id", "organizationId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_test_run" ADD CONSTRAINT "agent_test_run_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "agent_template_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_test_run" ADD CONSTRAINT "agent_test_run_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "agent_deployment_execution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE agent_test_case ADD CONSTRAINT agent_test_case_bounds CHECK (
 revision > 0 AND octet_length(input) <= 80000 AND octet_length("checksJson"::text) <= 70000 AND octet_length("sourceScopeJson"::text) <= 131072
);
ALTER TABLE agent_test_run ADD CONSTRAINT agent_test_run_bounds CHECK (
 "caseRevision" > 0 AND "agentVersion" > 0 AND octet_length("caseInput") <= 80000 AND octet_length("checksJson"::text) <= 70000 AND octet_length("sourceScopeJson"::text) <= 262144
 AND status IN ('ADMITTING','RUNNING','COMPLETED','CANCELLED','ERROR') AND (verdict IS NULL OR verdict IN ('PASSED','FAILED')) AND "requestHash" ~ '^[a-f0-9]{64}$'
);
ALTER TABLE agent_test_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_test_case FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_test_case
 USING (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id())
 WITH CHECK (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id());
ALTER TABLE agent_test_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_test_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_test_run
 USING (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id())
 WITH CHECK (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id());

-- Results intentionally contain checks/hashes/metrics only, never native output.
ALTER TABLE agent_test_run ADD CONSTRAINT agent_test_run_report_bounds CHECK (
 "reportJson" IS NULL OR (jsonb_typeof("reportJson")='object' AND octet_length("reportJson"::text)<=8192
 AND "reportJson" ?& ARRAY['version','method','outputHash','passed','total','results','durationMs','inputTokens','outputTokens','totalCost']
 AND "reportJson"->>'version'='1' AND "reportJson"->>'method'='exact-text'
 AND ("reportJson" - ARRAY['version','method','outputHash','passed','total','results','durationMs','inputTokens','outputTokens','totalCost'])='{}'::jsonb)
);

-- Child RLS is not a substitute for consistency of referenced native resources.
-- Tests deliberately execute with their owner's existing saved credentials.
CREATE FUNCTION enforce_agent_test_case_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM agent_template_instance i WHERE i.id=NEW."originInstanceId" AND i."organizationId"=NEW."organizationId" AND i."userId"=NEW."userId" AND i."sId"=NEW."agentSId") THEN
  RAISE EXCEPTION 'Agent test case reference has invalid scope' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_test_case_scope BEFORE INSERT OR UPDATE ON agent_test_case FOR EACH ROW EXECUTE FUNCTION enforce_agent_test_case_scope();
CREATE FUNCTION enforce_agent_test_run_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM agent_test_case c WHERE c.id=NEW."caseId" AND c."organizationId"=NEW."organizationId" AND c."userId"=NEW."userId" AND c."agentSId"=NEW."agentSId")
 OR NOT EXISTS(SELECT 1 FROM agent_template_instance i WHERE i.id=NEW."instanceId" AND i."organizationId"=NEW."organizationId" AND i."userId"=NEW."userId" AND i."sId"=NEW."agentSId" AND i.version=NEW."agentVersion") THEN
  RAISE EXCEPTION 'Agent test run reference has invalid scope' USING ERRCODE='23514';
 END IF;
 IF NEW."executionId" IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM agent_deployment_execution e JOIN agent_deployment d ON d.id=e."deploymentId"
  WHERE e.id=NEW."executionId" AND e."organizationId"=NEW."organizationId" AND e."userId"=NEW."userId" AND d."instanceId"=NEW."instanceId"
  AND e.input->>'message'=NEW."caseInput" AND e."workflowId"=NEW."nativeWorkflowId"
  AND (e."runId" IS NULL OR e."runId"=NEW."nativeRunId")
 ) THEN
  RAISE EXCEPTION 'Agent test execution reference has invalid scope' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_test_run_scope BEFORE INSERT OR UPDATE ON agent_test_run FOR EACH ROW EXECUTE FUNCTION enforce_agent_test_run_scope();
