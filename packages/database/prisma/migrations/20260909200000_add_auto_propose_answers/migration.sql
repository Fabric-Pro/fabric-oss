-- Whether the planning analysis drafts SUGGESTED ANSWERS for the questions it
-- raises.
--
-- Per PROJECT, where Feature Maturation's equivalent is per-feature, because
-- the two are asked at different moments: FMv2 mints questions continuously as
-- a spec matures, so a person can turn it off for the one feature that is
-- noisy, while Publishing mints them once when the analysis runs — a per-topic
-- switch nobody could reach in time.
--
-- Defaulted ON: the suggestions are the feature, and a switch that starts off
-- is a feature nobody finds. NOT NULL with a default, so every existing project
-- is already in the right state and nothing needs backfilling.
ALTER TABLE "publishing_suite_settings"
    ADD COLUMN "autoProposeAnswers" BOOLEAN NOT NULL DEFAULT true;
