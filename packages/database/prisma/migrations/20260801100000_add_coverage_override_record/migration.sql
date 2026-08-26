-- Recording a conscious decision to ship below the coverage target.
--
-- `project_qa_settings.coverageTarget` has shipped since the QA policy existed,
-- defaulting to 80. Nothing read it. A project could set 80% and close every
-- feature at 10% coverage without anything anywhere noticing, which makes the
-- control a decoration that reads as a guarantee.
--
-- It now blocks the move to Done. Blocking alone was rejected: a low-risk
-- feature may legitimately ship under target, and a second hard gate would
-- strand work for a reason far less clear-cut than a missing sign-off — which
-- is already a hard gate with no bypass. So the block is overridable, and the
-- override is recorded rather than swallowed.
--
-- The record is the part worth having. A team that ships under target
-- repeatedly can see that it did and why, which neither a silent number nor an
-- immovable wall would give them.
--
-- Additive and nullable: no existing row changes, and every feature that met
-- its target keeps all three columns null. They fill only when somebody
-- consciously goes under.
ALTER TABLE "user_story"
  ADD COLUMN "coverageOverrideReason" TEXT,
  ADD COLUMN "coverageOverrideById"   TEXT,
  ADD COLUMN "coverageOverrideAt"     TIMESTAMP(3);
