-- Create FrameTemplate table
CREATE TABLE "frame_template" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "variables" JSONB,
    "organizationId" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "frame_template_pkey" PRIMARY KEY ("id")
);

-- Create indexes for FrameTemplate
CREATE INDEX "frame_template_organizationId_idx" ON "frame_template"("organizationId");
CREATE INDEX "frame_template_category_idx" ON "frame_template"("category");
CREATE INDEX "frame_template_isSystem_idx" ON "frame_template"("isSystem");

-- Add foreign key constraint for organization
ALTER TABLE "frame_template" 
ADD CONSTRAINT "frame_template_organizationId_fkey" 
FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
