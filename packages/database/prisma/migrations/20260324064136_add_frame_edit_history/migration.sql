-- DropIndex
DROP INDEX "public"."frame_edit_history_editedAt_idx";

-- DropIndex
DROP INDEX "public"."frame_edit_history_frameId_idx";

-- CreateIndex
CREATE INDEX "frame_edit_history_frameId_editedAt_idx" ON "frame_edit_history"("frameId", "editedAt");
