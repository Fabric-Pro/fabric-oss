-- FR9/10 one-subject -> N-angle multiplication: additive nullable subject + subjectKey.
-- subject = canonical subject line shown on grouped cards; subjectKey = grouping identity
-- (hash of the normalized subject-or-title), server-side only, never a uniqueness key.
-- Backward-compatible; existing rows read back NULL.
ALTER TABLE "publishing_topic"
  ADD COLUMN "subject" TEXT,
  ADD COLUMN "subjectKey" TEXT;
