-- NOT VALID first: adding the FK validated would check every row under lock.
-- Validation follows in the next migration under a weaker lock.
-- migration-lint: allow unvalidated-constraint — the constraint is added NOT
-- VALID by design; 20260823090050_prompt_binding_project_fk_validate validates
-- it under a weaker lock in this same changeset.
ALTER TABLE "prompt_binding" ADD CONSTRAINT "prompt_binding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
