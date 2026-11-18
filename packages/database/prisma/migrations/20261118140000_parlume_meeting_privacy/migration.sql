-- Parlume meeting privacy defaults.
--
-- A project agent uses its external MCP servers, integrations and workspaces
-- on a meeting turn only when it opts in; existing agents start opted out.
--
-- Suggestions and the recap now default to the team (the Parlume page)
-- rather than the meeting chat. Only the column defaults change: existing
-- series and sessions keep the audience they were saved with.
--
-- A linked meeting series can be marked confidential: its transcripts are
-- kept out of later answers, recaps and agendas. Existing series are not.

ALTER TABLE "agent_template_instance"
  ADD COLUMN "meetingExternalTools" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "project_linked_meeting"
  ALTER COLUMN "parlumeAutoJoinSuggestionAudience" SET DEFAULT 'TEAM',
  ADD COLUMN "confidential" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "parlume_meeting_session"
  ALTER COLUMN "suggestionAudience" SET DEFAULT 'TEAM';
