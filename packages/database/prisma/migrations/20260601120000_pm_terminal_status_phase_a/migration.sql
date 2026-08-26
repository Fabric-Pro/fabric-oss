-- AlterTable
ALTER TABLE "project" ADD COLUMN     "pmAutoCloseEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pmTerminalStatuses" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "user_story" ADD COLUMN     "pmTicketTerminal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pmTicketTerminalStatus" TEXT;
