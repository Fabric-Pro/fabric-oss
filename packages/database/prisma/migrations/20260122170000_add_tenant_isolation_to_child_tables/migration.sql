-- Add tenant isolation columns to child tables
-- This migration adds userId and organizationId columns to child tables
-- to enable proper tenant isolation filtering without relying solely on parent joins.

-- AlterTable: Workflow-related tables
ALTER TABLE "workflow_version" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "userId" TEXT;

ALTER TABLE "workflow_execution_log" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "userId" TEXT;

ALTER TABLE "workflow_api_key" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "userId" TEXT;

-- AlterTable: Project-related tables
ALTER TABLE "project_document" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "userId" TEXT;

ALTER TABLE "project_context" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "userId" TEXT;

ALTER TABLE "document_version" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "userId" TEXT;

ALTER TABLE "project_rag_settings" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "userId" TEXT;

-- Tables that already have userId, adding organizationId
ALTER TABLE "project_presence" ADD COLUMN "organizationId" TEXT;

ALTER TABLE "project_activity" ADD COLUMN "organizationId" TEXT;

ALTER TABLE "document_lock" ADD COLUMN "organizationId" TEXT;

-- AlterTable: Agent deployment tables
ALTER TABLE "agent_execution_step" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "userId" TEXT;

ALTER TABLE "agent_deployment_trigger" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "userId" TEXT;

ALTER TABLE "agent_deployment_metrics" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "userId" TEXT;

-- AlterTable: Template/Report chunk tables
ALTER TABLE "template_instance_artifact_chunk" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "userId" TEXT;

ALTER TABLE "report_artifact_chunk" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "userId" TEXT;

-- AlterTable: Prompt-related tables
ALTER TABLE "prompt_version" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "scope" "PromptScope",
ADD COLUMN "userId" TEXT;

ALTER TABLE "prompt_comment" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "scope" "PromptScope";

ALTER TABLE "prompt_comment_vote" ADD COLUMN "organizationId" TEXT;

ALTER TABLE "prompt_change_request" ADD COLUMN "organizationId" TEXT,
ADD COLUMN "scope" "PromptScope";

ALTER TABLE "prompt_connection" ADD COLUMN "organizationId" TEXT;

-- Create indexes for tenant isolation queries
CREATE INDEX "workflow_version_userId_idx" ON "workflow_version"("userId");
CREATE INDEX "workflow_version_organizationId_idx" ON "workflow_version"("organizationId");

CREATE INDEX "workflow_execution_log_userId_idx" ON "workflow_execution_log"("userId");
CREATE INDEX "workflow_execution_log_organizationId_idx" ON "workflow_execution_log"("organizationId");

CREATE INDEX "workflow_api_key_userId_idx" ON "workflow_api_key"("userId");
CREATE INDEX "workflow_api_key_organizationId_idx" ON "workflow_api_key"("organizationId");

CREATE INDEX "project_document_userId_idx" ON "project_document"("userId");
CREATE INDEX "project_document_organizationId_idx" ON "project_document"("organizationId");

CREATE INDEX "project_context_userId_idx" ON "project_context"("userId");
CREATE INDEX "project_context_organizationId_idx" ON "project_context"("organizationId");

CREATE INDEX "document_version_userId_idx" ON "document_version"("userId");
CREATE INDEX "document_version_organizationId_idx" ON "document_version"("organizationId");

CREATE INDEX "project_rag_settings_userId_idx" ON "project_rag_settings"("userId");
CREATE INDEX "project_rag_settings_organizationId_idx" ON "project_rag_settings"("organizationId");

CREATE INDEX "project_presence_userId_idx" ON "project_presence"("userId");
CREATE INDEX "project_presence_organizationId_idx" ON "project_presence"("organizationId");

CREATE INDEX "project_activity_userId_idx" ON "project_activity"("userId");
CREATE INDEX "project_activity_organizationId_idx" ON "project_activity"("organizationId");

CREATE INDEX "document_lock_organizationId_idx" ON "document_lock"("organizationId");

CREATE INDEX "agent_execution_step_userId_idx" ON "agent_execution_step"("userId");
CREATE INDEX "agent_execution_step_organizationId_idx" ON "agent_execution_step"("organizationId");

CREATE INDEX "agent_deployment_trigger_userId_idx" ON "agent_deployment_trigger"("userId");
CREATE INDEX "agent_deployment_trigger_organizationId_idx" ON "agent_deployment_trigger"("organizationId");

CREATE INDEX "agent_deployment_metrics_userId_idx" ON "agent_deployment_metrics"("userId");
CREATE INDEX "agent_deployment_metrics_organizationId_idx" ON "agent_deployment_metrics"("organizationId");

CREATE INDEX "template_instance_artifact_chunk_userId_idx" ON "template_instance_artifact_chunk"("userId");
CREATE INDEX "template_instance_artifact_chunk_organizationId_idx" ON "template_instance_artifact_chunk"("organizationId");

CREATE INDEX "report_artifact_chunk_userId_idx" ON "report_artifact_chunk"("userId");
CREATE INDEX "report_artifact_chunk_organizationId_idx" ON "report_artifact_chunk"("organizationId");

CREATE INDEX "prompt_version_userId_idx" ON "prompt_version"("userId");
CREATE INDEX "prompt_version_organizationId_idx" ON "prompt_version"("organizationId");
CREATE INDEX "prompt_version_scope_idx" ON "prompt_version"("scope");

CREATE INDEX "prompt_comment_organizationId_idx" ON "prompt_comment"("organizationId");
CREATE INDEX "prompt_comment_scope_idx" ON "prompt_comment"("scope");

CREATE INDEX "prompt_comment_vote_organizationId_idx" ON "prompt_comment_vote"("organizationId");

CREATE INDEX "prompt_change_request_organizationId_idx" ON "prompt_change_request"("organizationId");
CREATE INDEX "prompt_change_request_scope_idx" ON "prompt_change_request"("scope");

CREATE INDEX "prompt_connection_organizationId_idx" ON "prompt_connection"("organizationId");

-- Add foreign key constraints
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_execution_log" ADD CONSTRAINT "workflow_execution_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_execution_log" ADD CONSTRAINT "workflow_execution_log_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_api_key" ADD CONSTRAINT "workflow_api_key_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_api_key" ADD CONSTRAINT "workflow_api_key_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_document" ADD CONSTRAINT "project_document_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_document" ADD CONSTRAINT "project_document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_context" ADD CONSTRAINT "project_context_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_context" ADD CONSTRAINT "project_context_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_version" ADD CONSTRAINT "document_version_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_version" ADD CONSTRAINT "document_version_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_rag_settings" ADD CONSTRAINT "project_rag_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_rag_settings" ADD CONSTRAINT "project_rag_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_presence" ADD CONSTRAINT "project_presence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_presence" ADD CONSTRAINT "project_presence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_lock" ADD CONSTRAINT "document_lock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_lock" ADD CONSTRAINT "document_lock_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_execution_step" ADD CONSTRAINT "agent_execution_step_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_execution_step" ADD CONSTRAINT "agent_execution_step_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_deployment_trigger" ADD CONSTRAINT "agent_deployment_trigger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_deployment_trigger" ADD CONSTRAINT "agent_deployment_trigger_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_deployment_metrics" ADD CONSTRAINT "agent_deployment_metrics_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_deployment_metrics" ADD CONSTRAINT "agent_deployment_metrics_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "template_instance_artifact_chunk" ADD CONSTRAINT "template_instance_artifact_chunk_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "template_instance_artifact_chunk" ADD CONSTRAINT "template_instance_artifact_chunk_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "report_artifact_chunk" ADD CONSTRAINT "report_artifact_chunk_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "report_artifact_chunk" ADD CONSTRAINT "report_artifact_chunk_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "prompt_version" ADD CONSTRAINT "prompt_version_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prompt_version" ADD CONSTRAINT "prompt_version_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "prompt_comment" ADD CONSTRAINT "prompt_comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prompt_comment" ADD CONSTRAINT "prompt_comment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "prompt_comment_vote" ADD CONSTRAINT "prompt_comment_vote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prompt_comment_vote" ADD CONSTRAINT "prompt_comment_vote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "prompt_change_request" ADD CONSTRAINT "prompt_change_request_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prompt_change_request" ADD CONSTRAINT "prompt_change_request_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "prompt_connection" ADD CONSTRAINT "prompt_connection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill tenant isolation data from parent tables
-- Workflow-related backfills
UPDATE "workflow_version" wv
SET "userId" = w."userId", "organizationId" = w."organizationId"
FROM "workflow" w
WHERE wv."workflowId" = w.id;

UPDATE "workflow_api_key" wak
SET "userId" = w."userId", "organizationId" = w."organizationId"
FROM "workflow" w
WHERE wak."workflowId" = w.id;

UPDATE "workflow_execution_log" wel
SET "userId" = we."userId", "organizationId" = we."organizationId"
FROM "workflow_execution" we
WHERE wel."executionId" = we.id;

-- Project-related backfills
UPDATE "project_document" pd
SET "userId" = p."userId", "organizationId" = p."organizationId"
FROM "project" p
WHERE pd."projectId" = p.id;

UPDATE "project_context" pc
SET "userId" = p."userId", "organizationId" = p."organizationId"
FROM "project" p
WHERE pc."projectId" = p.id;

UPDATE "document_version" dv
SET "userId" = pd."userId", "organizationId" = pd."organizationId"
FROM "project_document" pd
WHERE dv."documentId" = pd.id;

UPDATE "project_rag_settings" prs
SET "userId" = p."userId", "organizationId" = p."organizationId"
FROM "project" p
WHERE prs."projectId" = p.id;

UPDATE "project_presence" pp
SET "organizationId" = p."organizationId"
FROM "project" p
WHERE pp."projectId" = p.id;

UPDATE "project_activity" pa
SET "organizationId" = p."organizationId"
FROM "project" p
WHERE pa."projectId" = p.id;

UPDATE "document_lock" dl
SET "organizationId" = pd."organizationId"
FROM "project_document" pd
WHERE dl."documentId" = pd.id;

-- Agent deployment backfills
UPDATE "agent_execution_step" aes
SET "userId" = ade."userId", "organizationId" = ade."organizationId"
FROM "agent_deployment_execution" ade
WHERE aes."executionId" = ade.id;

UPDATE "agent_deployment_trigger" adt
SET "userId" = ad."userId", "organizationId" = ad."organizationId"
FROM "agent_deployment" ad
WHERE adt."deploymentId" = ad.id;

UPDATE "agent_deployment_metrics" adm
SET "userId" = ad."userId", "organizationId" = ad."organizationId"
FROM "agent_deployment" ad
WHERE adm."deploymentId" = ad.id;

-- Template/Report chunk backfills
UPDATE "template_instance_artifact_chunk" tiac
SET "userId" = tia."userId", "organizationId" = tia."organizationId"
FROM "template_instance_artifact" tia
WHERE tiac."artifactId" = tia.id;

UPDATE "report_artifact_chunk" rac
SET "userId" = ra."userId", "organizationId" = ra."organizationId"
FROM "report_artifact" ra
WHERE rac."artifactId" = ra.id;

-- Prompt-related backfills
UPDATE "prompt_version" pv
SET "userId" = p."userId", "organizationId" = p."organizationId", "scope" = p."scope"
FROM "prompt" p
WHERE pv."promptId" = p.id;

UPDATE "prompt_comment" pc
SET "organizationId" = p."organizationId", "scope" = p."scope"
FROM "prompt" p
WHERE pc."promptId" = p.id;

UPDATE "prompt_comment_vote" pcv
SET "organizationId" = pc."organizationId"
FROM "prompt_comment" pc
WHERE pcv."commentId" = pc.id;

UPDATE "prompt_change_request" pcr
SET "organizationId" = p."organizationId", "scope" = p."scope"
FROM "prompt" p
WHERE pcr."promptId" = p.id;

UPDATE "prompt_connection" pconn
SET "organizationId" = p."organizationId"
FROM "prompt" p
WHERE pconn."sourceId" = p.id;
