-- Add project-level implementation defaults and explicit Vibe project policy.
ALTER TABLE "project"
  ADD COLUMN "implementationDefaultChannel" "CodingRunExecutionChannel",
  ADD COLUMN "implementationDefaultProvider" "CodingRunProvider",
  ADD COLUMN "implementationDefaultWorkingDirectory" TEXT,
  ADD COLUMN "vibeRemoteProjectId" TEXT,
  ADD COLUMN "vibeRemoteProjectName" TEXT;
