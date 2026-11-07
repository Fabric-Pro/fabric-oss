-- Create the expanded native-run uniqueness before retiring the stricter old indices.
-- CreateIndex
CREATE UNIQUE INDEX "run_quality_assessment_native_workflow_key" ON "run_quality_assessment"("policyId", "workflowExecutionId", "nativeRunId");

-- CreateIndex
CREATE UNIQUE INDEX "run_quality_assessment_native_agent_key" ON "run_quality_assessment"("policyId", "agentExecutionId", "nativeRunId");

/*
  Warnings:

  - A unique constraint covering the columns `[policyId,workflowExecutionId,nativeRunId]` on the table `run_quality_assessment` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[policyId,agentExecutionId,nativeRunId]` on the table `run_quality_assessment` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "run_quality_assessment_agent_key";

-- DropIndex
DROP INDEX "run_quality_assessment_workflow_key";

-- Expand the deployed report envelope without changing native execution,
-- publication/cancellation fences, ownership, retained output or RLS.
CREATE FUNCTION agent_test_report_is_minimized(report jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public AS $$
DECLARE
  allowed_keys text[];
  allowed_result_keys text[];
  metric text;
  result jsonb;
  version_two boolean;
  result_count integer := 0;
  passed_count integer := 0;
  unavailable_count integer := 0;
  failed boolean := false;
BEGIN
  IF report IS NULL OR jsonb_typeof(report) IS DISTINCT FROM 'object'
     OR octet_length(report::text) > 8192 THEN RETURN false; END IF;
  allowed_keys := ARRAY['version','method','outputHash','passed','total','results','durationMs','inputTokens','outputTokens','totalCost'];
  IF report->'version' = '1'::jsonb AND report->>'method' = 'exact-text' THEN
    version_two := false;
    allowed_result_keys := ARRAY['kind','index','passed'];
  ELSIF report->'version' = '2'::jsonb AND report->>'method' = 'deterministic'
        AND report->>'scorerVersion' = 'fabric-deterministic-v1' THEN
    version_two := true;
    allowed_keys := allowed_keys || ARRAY['scorerVersion','status','unavailable'];
    allowed_result_keys := ARRAY['kind','index','passed','available'];
  ELSE RETURN false; END IF;
  IF NOT (report ?& allowed_keys) OR report - allowed_keys <> '{}'::jsonb
     OR jsonb_typeof(report->'outputHash') IS DISTINCT FROM 'string'
     OR NOT (report->>'outputHash' ~ '^[a-f0-9]{64}$')
     OR jsonb_typeof(report->'results') IS DISTINCT FROM 'array'
     OR jsonb_typeof(report->'passed') IS DISTINCT FROM 'number'
     OR jsonb_typeof(report->'total') IS DISTINCT FROM 'number'
     OR NOT (report->>'passed' ~ '^[0-9]+$')
     OR NOT (report->>'total' ~ '^[0-9]+$') THEN RETURN false; END IF;
  FOREACH metric IN ARRAY ARRAY['durationMs','inputTokens','outputTokens'] LOOP
    IF report->metric <> 'null'::jsonb AND
      (jsonb_typeof(report->metric) IS DISTINCT FROM 'number'
       OR NOT (report->>metric ~ '^[0-9]+$')
       OR (report->>metric)::numeric > 9007199254740991) THEN RETURN false; END IF;
  END LOOP;
  IF report->'totalCost' <> 'null'::jsonb AND
     (jsonb_typeof(report->'totalCost') IS DISTINCT FROM 'string'
      OR length(report->>'totalCost') > 40
      OR NOT (report->>'totalCost' ~ '^[0-9]+([.][0-9]+)?$')) THEN RETURN false; END IF;
  FOR result IN SELECT value FROM jsonb_array_elements(report->'results') LOOP
    result_count := result_count + 1;
    IF result_count > (CASE WHEN version_two THEN 63 ELSE 40 END)
       OR jsonb_typeof(result) IS DISTINCT FROM 'object'
       OR NOT (result ?& allowed_result_keys) OR result - allowed_result_keys <> '{}'::jsonb
       OR jsonb_typeof(result->'kind') IS DISTINCT FROM 'string'
       OR jsonb_typeof(result->'index') IS DISTINCT FROM 'number'
       OR NOT (result->>'index' ~ '^[0-9]+$')
       OR (result->>'index')::numeric > 19
       OR jsonb_typeof(result->'passed') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
    IF version_two THEN
      IF result->>'kind' NOT IN ('required','forbidden','json','schema','grounding')
         OR jsonb_typeof(result->'available') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
      IF result->'available' = 'false'::jsonb THEN
        unavailable_count := unavailable_count + 1;
        IF result->'passed' <> 'false'::jsonb THEN RETURN false; END IF;
      ELSIF result->'passed' = 'false'::jsonb THEN failed := true;
      END IF;
    ELSIF result->>'kind' NOT IN ('required','forbidden') THEN RETURN false;
    END IF;
    IF result->'passed' = 'true'::jsonb THEN passed_count := passed_count + 1; END IF;
  END LOOP;
  IF result_count = 0 OR (report->>'total')::numeric <> result_count
     OR (report->>'passed')::numeric <> passed_count THEN RETURN false; END IF;
  IF version_two AND
     (jsonb_typeof(report->'unavailable') IS DISTINCT FROM 'number'
      OR NOT (report->>'unavailable' ~ '^[0-9]+$')
      OR (report->>'unavailable')::numeric <> unavailable_count
      OR jsonb_typeof(report->'status') IS DISTINCT FROM 'string'
      OR report->>'status' <> (CASE WHEN failed THEN 'FAILED' WHEN unavailable_count > 0 THEN 'NOT_ASSESSED' ELSE 'PASSED' END))
    THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END $$;

ALTER TABLE agent_test_run
  DROP CONSTRAINT agent_test_run_report_bounds,
  ADD CONSTRAINT agent_test_run_report_bounds
  CHECK ("reportJson" IS NULL OR agent_test_report_is_minimized("reportJson")) NOT VALID;
ALTER TABLE agent_test_run VALIDATE CONSTRAINT agent_test_run_report_bounds;

-- Parent execution projections may advance to a new native attempt. Check native
-- references only when admitting a row; immutable admission fields then preserve
-- historical provenance while allowing the old observer to terminalize safely.
CREATE OR REPLACE FUNCTION public.enforce_run_quality_assessment_scope() RETURNS trigger
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
 IF TG_OP='INSERT' AND NEW."workflowExecutionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.workflow_execution e WHERE e.id=NEW."workflowExecutionId" AND e."organizationId"=NEW."organizationId" AND e."userId"=NEW."userId" AND e."workflowId"=p."workflowId" AND e.version=NEW."sourceVersion" AND e."temporalRunId"=NEW."nativeWorkflowId") THEN
  RAISE EXCEPTION 'Quality workflow evidence has invalid scope' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND NEW."agentExecutionId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.agent_deployment_execution e WHERE e.id=NEW."agentExecutionId" AND e."organizationId"=NEW."organizationId" AND e."userId"=NEW."userId" AND e.metadata#>>'{fabricAdmission,dispatch,instanceId}'=p."instanceId" AND e.metadata#>>'{fabricAdmission,dispatch,workflowType}' IN ('nativeDeploymentExecutionWorkflow','nativeGoalOrientedAgentWorkflow') AND e."workflowId"=NEW."nativeWorkflowId" AND e."runId"=NEW."nativeRunId") THEN
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
 IF TG_OP='UPDATE' AND OLD.status IN ('COMPLETED','CANCELLED') AND ROW(OLD.status,OLD.verdict,OLD."reportJson",OLD."errorCode",OLD."completedAt") IS DISTINCT FROM ROW(NEW.status,NEW.verdict,NEW."reportJson",NEW."errorCode",NEW."completedAt") THEN
  RAISE EXCEPTION 'Quality terminal evidence is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
