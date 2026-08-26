-- Add the integration providers ported from the upstream workflow-builder
-- template: Vercel Blob, Clerk, Stripe, Superagent and Webflow.
--
-- v0 is deliberately absent: upstream implements it against the v0-sdk npm
-- package, and an enum value with no implementation behind it is exactly the
-- pattern this work has been removing.
--
-- Postgres cannot add several enum values inside one transaction on versions
-- 11 and earlier; every supported deployment here is 12+, where it is fine.
ALTER TYPE "WorkflowIntegrationProvider" ADD VALUE IF NOT EXISTS 'BLOB';
ALTER TYPE "WorkflowIntegrationProvider" ADD VALUE IF NOT EXISTS 'CLERK';
ALTER TYPE "WorkflowIntegrationProvider" ADD VALUE IF NOT EXISTS 'STRIPE';
ALTER TYPE "WorkflowIntegrationProvider" ADD VALUE IF NOT EXISTS 'SUPERAGENT';
ALTER TYPE "WorkflowIntegrationProvider" ADD VALUE IF NOT EXISTS 'WEBFLOW';
