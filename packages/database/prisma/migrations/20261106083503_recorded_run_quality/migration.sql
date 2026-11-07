-- CreateTable
CREATE TABLE "run_quality_policy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workflowId" TEXT,
    "instanceId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "rulesJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_quality_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_quality_assessment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "workflowExecutionId" TEXT,
    "agentExecutionId" TEXT,
    "nativeWorkflowId" VARCHAR(256) NOT NULL,
    "nativeRunId" VARCHAR(64) NOT NULL,
    "assessmentWorkflowId" VARCHAR(256) NOT NULL,
    "assessmentRunId" VARCHAR(64),
    "sourceScopeJson" JSONB NOT NULL,
    "rulesJson" JSONB NOT NULL,
    "rulesHash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "verdict" VARCHAR(20),
    "reportJson" JSONB,
    "errorCode" VARCHAR(64),
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "run_quality_assessment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_quality_policy_userId_idx" ON "run_quality_policy"("userId");

-- CreateIndex
CREATE INDEX "run_quality_policy_workflowId_idx" ON "run_quality_policy"("workflowId");

-- CreateIndex
CREATE INDEX "run_quality_policy_instanceId_idx" ON "run_quality_policy"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "run_quality_policy_id_org_user_key" ON "run_quality_policy"("id", "organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "run_quality_policy_workflow_actor_key" ON "run_quality_policy"("organizationId", "userId", "workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "run_quality_policy_instance_actor_key" ON "run_quality_policy"("organizationId", "userId", "instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "run_quality_assessment_assessmentWorkflowId_key" ON "run_quality_assessment"("assessmentWorkflowId");

-- CreateIndex
CREATE INDEX "run_quality_assessment_organizationId_userId_createdAt_idx" ON "run_quality_assessment"("organizationId", "userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "run_quality_assessment_status_deadlineAt_idx" ON "run_quality_assessment"("status", "deadlineAt");

-- CreateIndex
CREATE INDEX "run_quality_assessment_workflowExecutionId_idx" ON "run_quality_assessment"("workflowExecutionId");

-- CreateIndex
CREATE INDEX "run_quality_assessment_agentExecutionId_idx" ON "run_quality_assessment"("agentExecutionId");

-- CreateIndex
CREATE INDEX "run_quality_assessment_userId_idx" ON "run_quality_assessment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "run_quality_assessment_workflow_key" ON "run_quality_assessment"("policyId", "workflowExecutionId");

-- CreateIndex
CREATE UNIQUE INDEX "run_quality_assessment_agent_key" ON "run_quality_assessment"("policyId", "agentExecutionId");

-- AddForeignKey
ALTER TABLE "run_quality_policy" ADD CONSTRAINT "run_quality_policy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_quality_policy" ADD CONSTRAINT "run_quality_policy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_quality_policy" ADD CONSTRAINT "run_quality_policy_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_quality_policy" ADD CONSTRAINT "run_quality_policy_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "agent_template_instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_quality_assessment" ADD CONSTRAINT "run_quality_assessment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_quality_assessment" ADD CONSTRAINT "run_quality_assessment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_quality_assessment" ADD CONSTRAINT "run_quality_assessment_policyId_organizationId_userId_fkey" FOREIGN KEY ("policyId", "organizationId", "userId") REFERENCES "run_quality_policy"("id", "organizationId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_quality_assessment" ADD CONSTRAINT "run_quality_assessment_workflowExecutionId_fkey" FOREIGN KEY ("workflowExecutionId") REFERENCES "workflow_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_quality_assessment" ADD CONSTRAINT "run_quality_assessment_agentExecutionId_fkey" FOREIGN KEY ("agentExecutionId") REFERENCES "agent_deployment_execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bounded actor-owned selectors and terminal state consistency are not expressible in Prisma.
ALTER TABLE "run_quality_policy"
 ADD CONSTRAINT "run_quality_policy_target_xor" CHECK (("workflowId" IS NULL) <> ("instanceId" IS NULL)),
 ADD CONSTRAINT "run_quality_policy_revision_positive" CHECK ("revision" > 0),
 ADD CONSTRAINT "run_quality_policy_rules_bounded" CHECK (CASE WHEN jsonb_typeof("rulesJson") = 'array' THEN jsonb_array_length("rulesJson") BETWEEN 1 AND 20 ELSE false END AND octet_length("rulesJson"::text) <= 131072);
ALTER TABLE "run_quality_assessment"
 ADD CONSTRAINT "run_quality_assessment_source_xor" CHECK (("workflowExecutionId" IS NULL) <> ("agentExecutionId" IS NULL)),
 ADD CONSTRAINT "run_quality_assessment_revision_positive" CHECK ("policyRevision" > 0 AND "sourceVersion" > 0),
 ADD CONSTRAINT "run_quality_assessment_rules_bounded" CHECK (CASE WHEN jsonb_typeof("rulesJson") = 'array' THEN jsonb_array_length("rulesJson") BETWEEN 1 AND 20 ELSE false END AND octet_length("rulesJson"::text) <= 131072 AND "rulesHash" ~ '^[a-f0-9]{64}$'),
 ADD CONSTRAINT "run_quality_assessment_state" CHECK (
   ("status" IN ('PENDING', 'CHECKING') AND "verdict" IS NULL AND "completedAt" IS NULL AND "reportJson" IS NULL AND "errorCode" IS NULL)
   OR ("status" IN ('COMPLETED', 'CANCELLED') AND "verdict" IN ('PASSED', 'NEEDS_ATTENTION', 'UNAVAILABLE', 'INCONCLUSIVE') AND "completedAt" IS NOT NULL)
 ),
 ADD CONSTRAINT "run_quality_assessment_evidence_bounded" CHECK (octet_length("sourceScopeJson"::text) <= 262144 AND ("reportJson" IS NULL OR octet_length("reportJson"::text) <= 262144));

-- Forced actor-within-organization policies protect every transport, including raw SQL.
ALTER TABLE run_quality_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_quality_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON run_quality_policy
 USING (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id())
 WITH CHECK (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id());
ALTER TABLE run_quality_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_quality_assessment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON run_quality_assessment
 USING (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id())
 WITH CHECK (current_tenant_type()='organization' AND "organizationId"=current_tenant_id() AND "userId"=current_user_id());

-- Referenced native objects must have the same actor and target, even for raw writes.
CREATE FUNCTION public.enforce_run_quality_policy_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF TG_OP='UPDATE' AND ROW(OLD."organizationId",OLD."userId",OLD."workflowId",OLD."instanceId") IS DISTINCT FROM ROW(NEW."organizationId",NEW."userId",NEW."workflowId",NEW."instanceId") THEN
  RAISE EXCEPTION 'Quality policy target is immutable' USING ERRCODE='23514';
 END IF;
 IF (NEW."workflowId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.workflow w WHERE w.id=NEW."workflowId" AND w."organizationId"=NEW."organizationId" AND w."userId"=NEW."userId"))
 OR (NEW."instanceId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.agent_template_instance i WHERE i.id=NEW."instanceId" AND i."organizationId"=NEW."organizationId" AND i."userId"=NEW."userId")) THEN
  RAISE EXCEPTION 'Quality policy reference has invalid scope' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER run_quality_policy_scope BEFORE INSERT OR UPDATE ON run_quality_policy FOR EACH ROW EXECUTE FUNCTION public.enforce_run_quality_policy_scope();
CREATE FUNCTION public.enforce_run_quality_assessment_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE p public.run_quality_policy%ROWTYPE;
rule jsonb;
grade jsonb;
result jsonb;
BEGIN
 IF jsonb_typeof(NEW."sourceScopeJson") IS DISTINCT FROM 'object' OR COALESCE(NEW."sourceScopeJson"->>'kind','') NOT IN ('WORKFLOW','AGENT','UNAVAILABLE') THEN RAISE EXCEPTION 'Quality sources have invalid shape' USING ERRCODE='23514'; END IF;
 IF (NEW."sourceScopeJson"->>'kind'='WORKFLOW' AND (NEW."sourceScopeJson" - ARRAY['kind','projectId','workspaceIds','skillIds'])<>'{}'::jsonb)
 OR (NEW."sourceScopeJson"->>'kind'='AGENT' AND ((NEW."sourceScopeJson" - ARRAY['kind','scope'])<>'{}'::jsonb OR jsonb_typeof(NEW."sourceScopeJson"->'scope') IS DISTINCT FROM 'object' OR ((NEW."sourceScopeJson"->'scope') - ARRAY['instanceId','configHash','projectId','workspaceIds','workspaceDocumentFilters','skillIds'])<>'{}'::jsonb))
 OR (NEW."sourceScopeJson"->>'kind'='UNAVAILABLE' AND (NEW."sourceScopeJson" - 'kind')<>'{}'::jsonb) THEN RAISE EXCEPTION 'Quality sources contain unsupported fields' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM public.run_quality_policy WHERE id=NEW."policyId" AND "organizationId"=NEW."organizationId" AND "userId"=NEW."userId";
 IF NOT FOUND THEN RAISE EXCEPTION 'Quality assessment policy has invalid scope' USING ERRCODE='23514'; END IF;
 IF NEW."workflowExecutionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.workflow_execution e WHERE e.id=NEW."workflowExecutionId" AND e."organizationId"=NEW."organizationId" AND e."userId"=NEW."userId" AND e."workflowId"=p."workflowId" AND e.version=NEW."sourceVersion" AND e."temporalRunId"=NEW."nativeWorkflowId") THEN
  RAISE EXCEPTION 'Quality workflow evidence has invalid scope' USING ERRCODE='23514';
 END IF;
 IF NEW."agentExecutionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.agent_deployment_execution e WHERE e.id=NEW."agentExecutionId" AND e."organizationId"=NEW."organizationId" AND e."userId"=NEW."userId" AND e.metadata#>>'{fabricAdmission,dispatch,instanceId}'=p."instanceId" AND e.metadata#>>'{fabricAdmission,dispatch,workflowType}' IN ('nativeDeploymentExecutionWorkflow','nativeGoalOrientedAgentWorkflow') AND e."workflowId"=NEW."nativeWorkflowId" AND e."runId"=NEW."nativeRunId") THEN
  RAISE EXCEPTION 'Quality agent evidence has invalid scope' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND ROW(OLD."organizationId",OLD."userId",OLD."policyId",OLD."policyRevision",OLD."sourceVersion",OLD."workflowExecutionId",OLD."agentExecutionId",OLD."nativeWorkflowId",OLD."nativeRunId",OLD."assessmentWorkflowId",OLD."sourceScopeJson",OLD."rulesJson",OLD."rulesHash",OLD."deadlineAt") IS DISTINCT FROM ROW(NEW."organizationId",NEW."userId",NEW."policyId",NEW."policyRevision",NEW."sourceVersion",NEW."workflowExecutionId",NEW."agentExecutionId",NEW."nativeWorkflowId",NEW."nativeRunId",NEW."assessmentWorkflowId",NEW."sourceScopeJson",NEW."rulesJson",NEW."rulesHash",NEW."deadlineAt") THEN
  RAISE EXCEPTION 'Quality admission is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW."reportJson" IS NOT NULL AND NEW."reportJson" <> 'null'::jsonb THEN
  IF jsonb_typeof(NEW."reportJson")<>'object' OR NOT NEW."reportJson" ?& ARRAY['version','scorerVersion','rules','coverage'] OR (NEW."reportJson" - ARRAY['version','scorerVersion','rules','coverage'])<>'{}'::jsonb OR NEW."reportJson"->>'version'<>'1' OR NEW."reportJson"->>'scorerVersion'<>'fabric-deterministic-v1' OR jsonb_typeof(NEW."reportJson"->'rules')<>'array' THEN
   RAISE EXCEPTION 'Quality report has invalid shape' USING ERRCODE='23514';
  END IF;
  FOR rule IN SELECT value FROM jsonb_array_elements(NEW."reportJson"->'rules') LOOP
   IF jsonb_typeof(rule)<>'object' OR (rule - ARRAY['id','name','required','outputHash','status','grade','reason'])<>'{}'::jsonb THEN RAISE EXCEPTION 'Quality rule has invalid shape' USING ERRCODE='23514'; END IF;
   grade=rule->'grade';
   IF grade IS NOT NULL THEN
    IF jsonb_typeof(grade)<>'object' OR (grade - ARRAY['version','method','scorerVersion','status','passed','total','unavailable','results'])<>'{}'::jsonb OR jsonb_typeof(grade->'results')<>'array' THEN RAISE EXCEPTION 'Quality grade has invalid shape' USING ERRCODE='23514'; END IF;
    FOR result IN SELECT value FROM jsonb_array_elements(grade->'results') LOOP
     IF jsonb_typeof(result)<>'object' OR (result - ARRAY['kind','index','passed','available'])<>'{}'::jsonb THEN RAISE EXCEPTION 'Quality check has invalid shape' USING ERRCODE='23514'; END IF;
    END LOOP;
   END IF;
  END LOOP;
 END IF;
 IF NEW.verdict IN ('PASSED','NEEDS_ATTENTION') AND (NEW."errorCode" IS NOT NULL OR NEW."reportJson" IS NULL OR NEW."reportJson"='null'::jsonb) THEN
  RAISE EXCEPTION 'Quality verdict requires evidence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER run_quality_assessment_scope BEFORE INSERT OR UPDATE ON run_quality_assessment FOR EACH ROW EXECUTE FUNCTION public.enforce_run_quality_assessment_scope();
