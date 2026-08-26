-- Serves the per-band MAX("roadmapOrder") rebase in recordPriorityMove: a
-- 100-move re-prioritization run issues one such aggregate per move, and with
-- only the (projectId) index each one scanned every story in the project.
CREATE INDEX "user_story_projectId_priority_idx" ON "user_story"("projectId", "priority");
