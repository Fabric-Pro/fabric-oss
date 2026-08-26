-- Review every pull request automatically, off unless a project asks for it.
--
-- Default false rather than true: an existing project must not start commenting
-- on its team's pull requests because Fabric shipped a feature.
ALTER TABLE "project_qa_settings" ADD COLUMN "prReviewAutoReviewEnabled" BOOLEAN NOT NULL DEFAULT false;
