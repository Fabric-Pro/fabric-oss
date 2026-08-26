-- #1797 — roll out Feature Maturation V2 to all organizations.
-- Now that every work-item creation path drafts a Clean Spec (#1799), the V2
-- three-tab editor is coherent for every org, so flip the column default to
-- true (new orgs enrolled automatically) and backfill every existing org.
-- The column is retained as the per-org kill-switch: an org can be flipped
-- back to false via SQL to disable V2 without a deploy.
ALTER TABLE "organization" ALTER COLUMN "featureMaturationV2Enabled" SET DEFAULT true;

UPDATE "organization" SET "featureMaturationV2Enabled" = true WHERE "featureMaturationV2Enabled" = false;
