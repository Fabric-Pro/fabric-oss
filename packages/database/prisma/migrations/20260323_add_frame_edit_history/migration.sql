-- Create FrameEditHistory table for tracking frame edits
CREATE TABLE "frame_edit_history" (
    "id" TEXT NOT NULL,
    "frameId" TEXT NOT NULL,
    "editType" TEXT NOT NULL,
    "oldString" TEXT,
    "newString" TEXT,
    "contentSnapshot" TEXT,
    "editedBy" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revertedToVersion" INTEGER,

    CONSTRAINT "frame_edit_history_pkey" PRIMARY KEY ("id")
);

-- Create indexes for FrameEditHistory
CREATE INDEX "frame_edit_history_frameId_idx" ON "frame_edit_history"("frameId");
CREATE INDEX "frame_edit_history_editedAt_idx" ON "frame_edit_history"("editedAt");

-- Add foreign key constraint
ALTER TABLE "frame_edit_history" 
ADD CONSTRAINT "frame_edit_history_frameId_fkey" 
FOREIGN KEY ("frameId") REFERENCES "agent_workspace_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;
