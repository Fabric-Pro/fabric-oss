-- Add lifecycle-event deployment triggers for project/story/task/comment/coding-run events.
ALTER TYPE "DeploymentTriggerType" ADD VALUE IF NOT EXISTS 'LIFECYCLE_EVENT';
