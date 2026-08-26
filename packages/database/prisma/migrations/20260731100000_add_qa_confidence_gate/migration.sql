-- NEEDS_REVIEW — the confidence threshold finally means what it says.
--
-- `project_qa_settings.confidenceThreshold` has shipped since the QA policy
-- existed, defaulting to 80, labelled "minimum AI confidence before a verdict is
-- recorded". Nothing read it. The runner asked the model whether an expectation
-- held and recorded PASSED or FAILED from the answer alone, however sure the
-- model was.
--
-- The runner now asks how confident the model is, and a step answered below the
-- project's bar records NEEDS_REVIEW instead of a verdict. The case and the run
-- carry it upward, which is why all three get the value.
--
-- A separate value rather than folding into BLOCKED, for the reason BLOCKED
-- itself was split from FAILED (20260727090000): BLOCKED means the step was
-- never attempted, and this step WAS attempted — the page was driven and read.
-- Collapsing them would report a runner that worked as a runner that could not
-- run.
--
-- Ranks below FAILED and BLOCKED and above PASSED at the run level. A run
-- holding a real failure is a failed run whatever else it holds; a case that
-- never ran outranks one that ran inconclusively; and a green badge over a
-- verdict the model would not stand behind is precisely the claim the threshold
-- exists to stop.
--
-- Additive only, and idempotent, matching the house style for enum migrations.
-- No existing row changes and nothing reads NEEDS_REVIEW until the worker
-- carrying the new code is deployed. Postgres cannot add an enum value inside a
-- transaction block that then USES it; these are bare ALTERs with no dependent
-- DML, so the standard migration transaction is fine.
ALTER TYPE "agentic_run_status" ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW';
ALTER TYPE "agentic_step_status" ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW';

-- Counted apart from every other bucket: the software was exercised and nothing
-- is known about the outcome, so adding these to passed or failed would state a
-- result nobody has. Defaults to 0, so every historical run reads as having
-- nothing awaiting review — which is true, because nothing could produce it.
ALTER TABLE "test_agentic_run"
  ADD COLUMN "needsReviewCount" INTEGER NOT NULL DEFAULT 0;
