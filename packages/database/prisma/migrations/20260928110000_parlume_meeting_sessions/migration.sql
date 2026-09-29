-- Parlume: project-scoped provider bot lifecycle and final live transcript
-- segments. Partial stream events never reach this durable store.

CREATE TYPE "parlume_meeting_session_status" AS ENUM (
    'PENDING',
    'JOINING',
    'ACTIVE',
    'FINALIZING',
    'LEAVING',
    'STOP_FAILED',
    'ENDED',
    'FAILED'
);

CREATE TYPE "parlume_meeting_turn_status" AS ENUM (
    'PENDING',
    'RUNNING',
    'COMPLETED',
    'FAILED'
);

CREATE TABLE "parlume_meeting_session" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentInstanceSId" TEXT NOT NULL,
    "agentInstanceVersionId" TEXT NOT NULL,
    "agentInstanceVersion" INTEGER NOT NULL,
    "providerBotId" TEXT,
    "streamTokenDigest" TEXT NOT NULL,
    "status" "parlume_meeting_session_status" NOT NULL DEFAULT 'PENDING',
    "wakePhrase" TEXT NOT NULL DEFAULT 'Hey Fabric',
    "toolsReadOnly" BOOLEAN NOT NULL DEFAULT true,
    "lastError" TEXT,
    "joinedAt" TIMESTAMP(3),
    "hardStopAt" TIMESTAMP(3),
    "leaveRequestedAt" TIMESTAMP(3),
    "captureStoppedAt" TIMESTAMP(3),
    "terminalCallbackAt" TIMESTAMP(3),
    "streamClosedAt" TIMESTAMP(3),
    "streamGeneration" INTEGER NOT NULL DEFAULT 0,
    "finalizationStartedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "transcriptContextId" TEXT,
    "providerDataDeletedAt" TIMESTAMP(3),
    "activeTurnId" TEXT,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parlume_meeting_session_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "parlume_meeting_session_providerBotId_key"
    ON "parlume_meeting_session"("providerBotId");
CREATE UNIQUE INDEX "parlume_meeting_session_transcriptContextId_key"
    ON "parlume_meeting_session"("transcriptContextId");
CREATE INDEX "parlume_meeting_session_projectId_createdAt_idx"
    ON "parlume_meeting_session"("projectId", "createdAt");
CREATE INDEX "parlume_meeting_session_organizationId_status_idx"
    ON "parlume_meeting_session"("organizationId", "status");
CREATE INDEX "parlume_meeting_session_agentInstanceSId_idx"
    ON "parlume_meeting_session"("agentInstanceSId");

ALTER TABLE "parlume_meeting_session"
    ADD CONSTRAINT "parlume_meeting_session_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "parlume_meeting_session"
    ADD CONSTRAINT "parlume_meeting_session_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "parlume_meeting_session"
    ADD CONSTRAINT "parlume_meeting_session_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "parlume_meeting_segment" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "speakerName" TEXT,
    "speakerId" TEXT,
    "text" TEXT NOT NULL,
    "utteranceStartMs" INTEGER,
    "utteranceEndMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parlume_meeting_segment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "parlume_meeting_segment_sessionId_dedupeKey_key"
    ON "parlume_meeting_segment"("sessionId", "dedupeKey");
CREATE INDEX "parlume_meeting_segment_projectId_createdAt_idx"
    ON "parlume_meeting_segment"("projectId", "createdAt");
CREATE INDEX "parlume_meeting_segment_organizationId_createdAt_idx"
    ON "parlume_meeting_segment"("organizationId", "createdAt");

ALTER TABLE "parlume_meeting_segment"
    ADD CONSTRAINT "parlume_meeting_segment_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "parlume_meeting_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "parlume_meeting_segment"
    ADD CONSTRAINT "parlume_meeting_segment_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "parlume_meeting_segment"
    ADD CONSTRAINT "parlume_meeting_segment_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "parlume_meeting_segment"
    ADD CONSTRAINT "parlume_meeting_segment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "parlume_meeting_turn" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "speakerName" TEXT,
    "speakerId" TEXT,
    "requestText" TEXT NOT NULL,
    "responseText" TEXT,
    "status" "parlume_meeting_turn_status" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parlume_meeting_turn_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "parlume_meeting_turn_sessionId_dedupeKey_key"
    ON "parlume_meeting_turn"("sessionId", "dedupeKey");
CREATE INDEX "parlume_meeting_turn_sessionId_createdAt_idx"
    ON "parlume_meeting_turn"("sessionId", "createdAt");
CREATE INDEX "parlume_meeting_turn_projectId_createdAt_idx"
    ON "parlume_meeting_turn"("projectId", "createdAt");
CREATE INDEX "parlume_meeting_turn_organizationId_createdAt_idx"
    ON "parlume_meeting_turn"("organizationId", "createdAt");

ALTER TABLE "parlume_meeting_turn"
    ADD CONSTRAINT "parlume_meeting_turn_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "parlume_meeting_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "parlume_meeting_turn"
    ADD CONSTRAINT "parlume_meeting_turn_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "parlume_meeting_turn"
    ADD CONSTRAINT "parlume_meeting_turn_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "parlume_meeting_turn"
    ADD CONSTRAINT "parlume_meeting_turn_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
