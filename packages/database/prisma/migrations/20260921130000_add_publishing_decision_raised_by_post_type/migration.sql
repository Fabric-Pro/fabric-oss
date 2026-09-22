-- Which draft run raised this decision root, or NULL for the planning analysis
-- (Fizzy #1988).
--
-- Until now the planning analysis was the only thing that could raise a
-- question, so reconciliation could soft-close every OPEN root of its kind that
-- a regenerated analysis no longer listed. A draft generation run may now raise
-- an asset confirmation of its own, and those rows must survive that sweep:
-- they are not the analysis's to retract. NULL means "the analysis raised it"
-- and is what every existing row means, so the add needs no backfill.
--
-- Nullable, no default: the column is read as a discriminator, never counted,
-- and a constant-default add does not rewrite the table.
ALTER TABLE "publishing_topic_decision_entry"
  ADD COLUMN "raisedByPostType" "PublishingTopicPostType";
