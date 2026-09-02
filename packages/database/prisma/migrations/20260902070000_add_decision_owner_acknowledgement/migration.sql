-- Owner sign-off on an architecture decision (Fizzy #2029, AC3/UC2).
--
-- Notifying an owner records that they were told; it does not record that they
-- accepted. Without this column "has the owner acted on this decision?" has no
-- answer to query, which is what UC2 asks for.
--
-- Nullable with no default and no backfill: existing decisions are genuinely
-- un-acknowledged, and stamping them would fabricate a sign-off nobody gave.
ALTER TABLE "architecture_decision"
  ADD COLUMN "ownerAcknowledgedAt" TIMESTAMP(3);
