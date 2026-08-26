-- CreateTable
CREATE TABLE "pm_ticket_missing_streak" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "entityType" "pm_state_change_entity_type" NOT NULL,
    "entityId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "missStreak" INTEGER NOT NULL DEFAULT 0,
    "firstMissingAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMissingAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pm_ticket_missing_streak_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pm_ticket_missing_streak_projectId_externalId_idx" ON "pm_ticket_missing_streak"("projectId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "pm_ticket_missing_streak_projectId_entityType_entityId_exte_key" ON "pm_ticket_missing_streak"("projectId", "entityType", "entityId", "externalId");

-- AddForeignKey
ALTER TABLE "pm_ticket_missing_streak" ADD CONSTRAINT "pm_ticket_missing_streak_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
