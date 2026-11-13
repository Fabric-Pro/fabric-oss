-- Record whether Fabric started a suggestion run itself (opening My time,
-- after a meeting or a pull request) or the member asked for it, and copy that
-- onto each suggestion the run creates. Automatic pending suggestions are
-- hidden from the To confirm list while their project is Fixed bid.
--
-- Additive. Existing rows default to false: they count as on-demand and stay
-- visible on Fixed bid projects, because their origin was never recorded.
ALTER TABLE "time_suggestion_run" ADD COLUMN "automatic" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "time_suggestion" ADD COLUMN "automatic" BOOLEAN NOT NULL DEFAULT false;
