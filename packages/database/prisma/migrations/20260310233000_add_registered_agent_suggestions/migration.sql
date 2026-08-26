CREATE TYPE "RegisteredAgentSuggestionKind" AS ENUM (
    'INSTRUCTIONS',
    'TOOLS',
    'RELIABILITY',
    'DISCOVERY'
);

CREATE TYPE "RegisteredAgentSuggestionState" AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED',
    'OUTDATED'
);

CREATE TABLE "registered_agent_suggestion" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "kind" "RegisteredAgentSuggestionKind" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "state" "RegisteredAgentSuggestionState" NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL DEFAULT 'generated',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registered_agent_suggestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "registered_agent_suggestion_agentId_key_key"
ON "registered_agent_suggestion"("agentId", "key");

CREATE INDEX "registered_agent_suggestion_agentId_idx"
ON "registered_agent_suggestion"("agentId");

CREATE INDEX "registered_agent_suggestion_userId_idx"
ON "registered_agent_suggestion"("userId");

CREATE INDEX "registered_agent_suggestion_organizationId_idx"
ON "registered_agent_suggestion"("organizationId");

CREATE INDEX "registered_agent_suggestion_state_idx"
ON "registered_agent_suggestion"("state");

ALTER TABLE "registered_agent_suggestion"
ADD CONSTRAINT "registered_agent_suggestion_agentId_fkey"
FOREIGN KEY ("agentId") REFERENCES "registered_agent"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "registered_agent_suggestion"
ADD CONSTRAINT "registered_agent_suggestion_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "user"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "registered_agent_suggestion"
ADD CONSTRAINT "registered_agent_suggestion_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
