-- Parlume's unprompted suggestions and "Since last time" recap get an
-- audience: MEETING posts them in the meeting chat (every participant,
-- external guests included, sees them), TEAM keeps them on the project's
-- Parlume page only. MEETING is the default, so existing sessions and series
-- keep posting in the chat as before.
--
-- Every suggestion and recap Parlume makes is recorded in parlume_suggestion,
-- whichever audience it had, so the Parlume page can list them to the
-- project's readers.

CREATE TYPE "parlume_suggestion_audience" AS ENUM ('MEETING', 'TEAM');

CREATE TYPE "parlume_suggestion_kind" AS ENUM ('ANSWER', 'MISSED_QUESTION', 'RECAP');

ALTER TABLE "parlume_meeting_session"
  ADD COLUMN "suggestionAudience" "parlume_suggestion_audience" NOT NULL DEFAULT 'MEETING';

ALTER TABLE "project_linked_meeting"
  ADD COLUMN "parlumeAutoJoinSuggestionAudience" "parlume_suggestion_audience" NOT NULL DEFAULT 'MEETING';

CREATE TABLE "parlume_suggestion" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" "parlume_suggestion_kind" NOT NULL,
  "audience" "parlume_suggestion_audience" NOT NULL,
  "text" TEXT NOT NULL,
  "speaker" TEXT,
  "quote" TEXT,
  "topic" TEXT,
  "chatTag" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "parlume_suggestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "parlume_suggestion_sessionId_fkey" FOREIGN KEY ("sessionId")
    REFERENCES "parlume_meeting_session"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "parlume_suggestion_sessionId_createdAt_idx" ON "parlume_suggestion"("sessionId", "createdAt");
CREATE INDEX "parlume_suggestion_projectId_idx" ON "parlume_suggestion"("projectId");
