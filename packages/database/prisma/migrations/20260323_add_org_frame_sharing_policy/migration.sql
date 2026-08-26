-- Add canShareFramesPublicly to organization
ALTER TABLE "organization" 
ADD COLUMN "canShareFramesPublicly" BOOLEAN NOT NULL DEFAULT true;

-- Add allowedFrameShareDomains to organization
ALTER TABLE "organization" 
ADD COLUMN "allowedFrameShareDomains" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Create index for the new column
CREATE INDEX "organization_canShareFramesPublicly_idx" ON "organization"("canShareFramesPublicly");
