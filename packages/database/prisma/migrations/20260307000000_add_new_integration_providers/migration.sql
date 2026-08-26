-- Add new integration providers to WorkflowIntegrationProvider enum
-- Adding: ASANA, ATTIO, CANVA, FRESHSERVICE, FRONT

ALTER TYPE "WorkflowIntegrationProvider" ADD VALUE 'ASANA';
ALTER TYPE "WorkflowIntegrationProvider" ADD VALUE 'ATTIO';
ALTER TYPE "WorkflowIntegrationProvider" ADD VALUE 'CANVA';
ALTER TYPE "WorkflowIntegrationProvider" ADD VALUE 'FRESHSERVICE';
ALTER TYPE "WorkflowIntegrationProvider" ADD VALUE 'FRONT';
