-- Readiness attention state (Fizzy #2165).
--
-- Every attention rule asks "has anything changed since YOU last looked", and
-- nothing answered that today. `last_visited_at` on the same row records opening
-- the PROJECT rather than the checklist, and is overwritten on every visit.
--
-- All four columns are nullable or defaulted, so this is additive: existing rows
-- read as "never seen", which is the correct starting point — a person who has
-- never opened the panel has not seen anything in it.
ALTER TABLE "project_user_preference"
  ADD COLUMN "readinessSeenAt" TIMESTAMP(3),
  ADD COLUMN "readinessSeenLevel" TEXT,
  ADD COLUMN "readinessAutoExpandedAt" TIMESTAMP(3);

-- Verdict rows are written for ALL items on a project's first read, so an item
-- becoming reachable is indistinguishable from its row being seeded. Tracking
-- visibility alongside completion is what makes "this appeared" answerable.
--
-- Defaults to false rather than true on purpose: the next reconcile writes each
-- row's real visibility, and a false -> true transition on that pass is a seed
-- rather than news. `reconcileVerdicts` already draws that distinction for
-- completion and applies the same rule here.
ALTER TABLE "project_readiness_verdict"
  ADD COLUMN "isVisible" BOOLEAN NOT NULL DEFAULT false;

-- Visibility gets its own timestamp. `changed_at` means "when completion
-- flipped" and the recently-completed list reads it, so bumping it because a
-- dependency landed would announce long-finished items as fresh news. That is
-- the defect this table was corrected for once already.
ALTER TABLE "project_readiness_verdict"
  ADD COLUMN "visibleChangedAt" TIMESTAMP(3);
