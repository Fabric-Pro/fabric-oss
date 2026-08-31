-- Amendment pointer for Decision Log answer turns (#1910).
--
-- Amending a resolved answer APPENDS a new turn rather than editing the old one,
-- keeping the Decision Log append-only as its model intends. This column links
-- the new turn to the one it replaces, so the previous answer stays readable as
-- history and every AI surface can exclude it.
--
-- No backfill: existing turns supersede nothing, so NULL is correct for all of
-- them. The unique index that enforces "a turn is superseded at most once" is a
-- separate migration, because CREATE UNIQUE INDEX on an existing table must run
-- CONCURRENTLY and therefore cannot share a transaction with DDL.
--
-- The foreign key is added NOT VALID and validated in 20260828130200, following
-- the shape 20260823090040/090050 used for prompt_binding's project FK. A plain
-- ADD CONSTRAINT ... FOREIGN KEY validates against every existing row while
-- holding a lock; NOT VALID takes that scan off the path that adds the column.
-- Nothing can actually violate it — the column is created empty by the statement
-- above — but the scan still reads every page of the relation, and this table is
-- on the maturation write path.
ALTER TABLE "decision_log_entry" ADD COLUMN "supersedesId" TEXT;

-- migration-lint: allow unvalidated-constraint — the constraint IS added NOT
-- VALID; the rule's matcher does not see the trailing marker on this statement,
-- the same blind spot 20260823090040_prompt_binding_project_fk_not_valid carries
-- the identical allow for. 20260828130200_decision_log_supersedes_fk_validate
-- validates it under a weaker lock in this same changeset, so nothing is left
-- unvalidated and no pending-constraint-validations.json entry is owed.
ALTER TABLE "decision_log_entry" ADD CONSTRAINT "decision_log_entry_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "decision_log_entry"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
