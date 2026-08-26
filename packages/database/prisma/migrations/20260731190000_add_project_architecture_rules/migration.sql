-- The record that makes "design-pattern compliance" checkable.
--
-- The architecture lens shipped reporting circular imports only, and that was
-- the honest limit: a cycle is a property of the reviewed project's own graph,
-- while every other "pattern" the lens could check was an assumption about a
-- layout the customer never agreed to. The layer rules that made those
-- assumptions were withdrawn for exactly that reason.
--
-- A project now declares the imports its architecture forbids, one rule per
-- line, and the lens checks the graph against what they wrote. Nothing is
-- inferred, and a project that declares nothing gets no findings.
--
-- Nullable and free text. Free text because somebody writes these by hand and
-- reads them in a diff, and `#` comments let a team group and explain their own
-- conventions; nullable because "has not written any" is the default state and
-- must not read as "wrote an empty rule set".
ALTER TABLE "project_qa_settings"
  ADD COLUMN "architectureRules" TEXT;
