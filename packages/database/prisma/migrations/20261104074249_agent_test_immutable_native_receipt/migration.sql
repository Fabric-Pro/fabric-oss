-- Historical native admission identifies the version that actually executed.
-- A deployment is intentionally retargeted when its owner saves a new version;
-- its current instanceId must not invalidate outstanding or completed tests.
-- Forward recovery: replace this function in a later migration while retaining
-- the owner/family/version and immutable execution identity predicates.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.enforce_agent_test_run_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM public.agent_test_case c
  WHERE c.id=NEW."caseId" AND c."organizationId"=NEW."organizationId"
   AND c."userId"=NEW."userId" AND c."agentSId"=NEW."agentSId"
 ) OR NOT EXISTS(
  SELECT 1 FROM public.agent_template_instance i
  WHERE i.id=NEW."instanceId" AND i."organizationId"=NEW."organizationId"
   AND i."userId"=NEW."userId" AND i."sId"=NEW."agentSId" AND i.version=NEW."agentVersion"
 ) THEN
  RAISE EXCEPTION 'Agent test run reference has invalid scope' USING ERRCODE='23514';
 END IF;
 IF NEW."executionId" IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM public.agent_deployment_execution e
  WHERE e.id=NEW."executionId" AND e."organizationId"=NEW."organizationId" AND e."userId"=NEW."userId"
   AND jsonb_typeof(e.metadata->'fabricAdmission')='object'
   AND e.metadata#>'{fabricAdmission,version}'='1'::jsonb
   AND e.metadata#>>'{fabricAdmission,requestHash}' ~ '^[a-f0-9]{64}$'
   AND e.metadata#>>'{fabricAdmission,dispatch,instanceId}'=NEW."instanceId"
   AND e.metadata#>>'{fabricAdmission,dispatch,workflowType}' IN ('nativeDeploymentExecutionWorkflow','nativeGoalOrientedAgentWorkflow')
   AND jsonb_typeof(e.metadata#>'{fabricAdmission,imageRefs}')='array'
   AND e.input->>'message'=NEW."caseInput" AND e."workflowId"=NEW."nativeWorkflowId"
   AND (e."runId" IS NULL OR e."runId"=NEW."nativeRunId")
 ) THEN
  RAISE EXCEPTION 'Agent test execution reference has invalid scope' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
COMMIT;
