-- CreateTable
CREATE TABLE "dashboard_curated_preference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "cardKey" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "lastClickedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_curated_preference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_curated_preference_organizationId_userId_cardKey_key" ON "dashboard_curated_preference"("organizationId", "userId", "cardKey");

-- AddForeignKey
ALTER TABLE "dashboard_curated_preference" ADD CONSTRAINT "dashboard_curated_preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_curated_preference" ADD CONSTRAINT "dashboard_curated_preference_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
