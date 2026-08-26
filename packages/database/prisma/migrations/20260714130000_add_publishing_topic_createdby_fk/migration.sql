-- CreateIndex
CREATE INDEX "publishing_topic_createdById_idx" ON "publishing_topic"("createdById");
-- AddForeignKey
ALTER TABLE "publishing_topic" ADD CONSTRAINT "publishing_topic_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
