-- Feature Maturation V2 — AI answer recommendations dogfood feature flag (#7, FR-15).
-- Default false: enrol the internal org first via SQL flip (like featureMaturationV2Enabled).
ALTER TABLE "organization" ADD COLUMN "aiAnswerRecommendationsEnabled" BOOLEAN NOT NULL DEFAULT false;
