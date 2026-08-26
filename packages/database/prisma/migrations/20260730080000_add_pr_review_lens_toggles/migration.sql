-- Which PR review lenses a project runs (card 1642 phase 4).
--
-- Both default TRUE so a project that never opens Settings > Testing behaves
-- exactly as it did before these columns existed. They gate the outward RUN, not
-- the display: turning a lens off stops new analyses and leaves findings already
-- stored readable, because deleting somebody's accepted findings is not what
-- "stop running this" means.
ALTER TABLE "project_qa_settings"
    ADD COLUMN "prReviewQaLensEnabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "prReviewArchitectureLensEnabled" BOOLEAN NOT NULL DEFAULT true;
