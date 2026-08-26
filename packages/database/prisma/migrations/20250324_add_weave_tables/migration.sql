-- Migration: Add fabric-weave tables
-- Created: Phase 1 of fabric-weave implementation

-- Enums (uppercase to match Prisma schema and TypeScript code)
CREATE TYPE "WeavePlanStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "WeaveExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'PAUSED', 'CHECKPOINT', 'COMPLETED', 'FAILED', 'CANCELLED');

-- ProjectWeaveConfig: Per-project weave settings
CREATE TABLE "project_weave_config" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT,

  "patternConfig" JSONB,
  "shuttleConfig" JSONB,

  "requireReview" BOOLEAN NOT NULL DEFAULT true,
  "requireSecurityReview" BOOLEAN NOT NULL DEFAULT true,
  "autoExecuteSimple" BOOLEAN NOT NULL DEFAULT false,
  "complexityThreshold" TEXT NOT NULL DEFAULT 'medium',

  "enabledSkills" TEXT[] NOT NULL DEFAULT '{}',
  "enabledMcpTools" TEXT[] NOT NULL DEFAULT '{}',
  "categoryRouting" JSONB,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_weave_config_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_weave_config_projectId_key" UNIQUE ("projectId")
);

-- WeavePlan: Execution plans created by Pattern
CREATE TABLE "weave_plan" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT,

  "projectId" TEXT NOT NULL,
  "userStoryId" TEXT,
  "storyTaskId" TEXT,

  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "WeavePlanStatus" NOT NULL DEFAULT 'DRAFT',
  "checkboxes" JSONB NOT NULL DEFAULT '[]',

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "weave_plan_pkey" PRIMARY KEY ("id")
);

-- WeaveExecution: Execution tracking
CREATE TABLE "weave_execution" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT,

  "planId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "workflowId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "sandboxSessionId" TEXT,

  "status" "WeaveExecutionStatus" NOT NULL DEFAULT 'PENDING',
  "currentStep" INTEGER NOT NULL DEFAULT 0,
  "checkboxes" JSONB,
  "artifacts" JSONB,
  "error" TEXT,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "weave_execution_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "project_weave_config_projectId_idx" ON "project_weave_config"("projectId");
CREATE INDEX "project_weave_config_userId_organizationId_idx" ON "project_weave_config"("userId", "organizationId");

CREATE INDEX "weave_plan_projectId_idx" ON "weave_plan"("projectId");
CREATE INDEX "weave_plan_userStoryId_idx" ON "weave_plan"("userStoryId");
CREATE INDEX "weave_plan_userId_organizationId_idx" ON "weave_plan"("userId", "organizationId");
CREATE INDEX "weave_plan_status_idx" ON "weave_plan"("status");

CREATE INDEX "weave_execution_planId_idx" ON "weave_execution"("planId");
CREATE INDEX "weave_execution_projectId_idx" ON "weave_execution"("projectId");
CREATE INDEX "weave_execution_userId_organizationId_idx" ON "weave_execution"("userId", "organizationId");
CREATE INDEX "weave_execution_workflowId_idx" ON "weave_execution"("workflowId");

-- Foreign Keys
ALTER TABLE "project_weave_config" ADD CONSTRAINT "project_weave_config_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "weave_plan" ADD CONSTRAINT "weave_plan_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "weave_plan" ADD CONSTRAINT "weave_plan_userStoryId_fkey"
  FOREIGN KEY ("userStoryId") REFERENCES "user_story"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "weave_plan" ADD CONSTRAINT "weave_plan_storyTaskId_fkey"
  FOREIGN KEY ("storyTaskId") REFERENCES "story_task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "weave_execution" ADD CONSTRAINT "weave_execution_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "weave_plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Extend agent approval with weave fields (snake_case to match @map directives)
ALTER TABLE "agent_approval" ADD COLUMN IF NOT EXISTS "weave_execution_id" TEXT;
ALTER TABLE "agent_approval" ADD COLUMN IF NOT EXISTS "weave_plan_id" TEXT;
ALTER TABLE "agent_approval" ADD COLUMN IF NOT EXISTS "weave_context" JSONB;

CREATE INDEX "agent_approval_weave_execution_id_idx" ON "agent_approval"("weave_execution_id");
CREATE INDEX "agent_approval_weave_plan_id_idx" ON "agent_approval"("weave_plan_id");
