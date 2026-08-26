-- The roadmap Priority layout counts open decision threads for a whole page of
-- work items at once (countOpenDecisionsForStories). The existing
-- (userStoryId, createdAt) index gets us to the right stories, but every
-- decision row for those stories is then heap-fetched only to be discarded by
-- the status / parentId / deletedAt predicates — roots are a small minority of
-- the table once a feature has been through maturation.
--
-- A partial index over exactly the rows the query wants keeps the count to a
-- probe per story. Partial on purpose: it stays small because it only holds
-- open thread roots, which is also the only shape this query asks for.
CREATE INDEX IF NOT EXISTS "decision_log_entry_open_roots_idx"
  ON "decision_log_entry" ("userStoryId")
  WHERE "status" = 'OPEN'
    AND "parentId" IS NULL
    AND "deletedAt" IS NULL;
