-- AlterTable
ALTER TABLE "epic" ADD COLUMN     "externalMcpServerId" TEXT,
ADD COLUMN     "pmAutoHidden" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "feature" ADD COLUMN     "externalMcpServerId" TEXT,
ADD COLUMN     "pmAutoHidden" BOOLEAN NOT NULL DEFAULT false;
