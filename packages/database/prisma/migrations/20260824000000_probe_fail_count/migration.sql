-- Consecutive definitive-negative repo-probe counter for No-access rows:
-- at the sweep's retirement threshold the row leaves the periodic sweep,
-- since a permanently unreadable repository can never self-heal. Reset by
-- reconnect, attachPat, or a successful probe.
ALTER TABLE "project_repository_integration" ADD COLUMN "probeFailCount" INTEGER NOT NULL DEFAULT 0;
