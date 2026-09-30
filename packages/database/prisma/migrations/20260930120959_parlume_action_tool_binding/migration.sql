-- AlterTable
ALTER TABLE "parlume_action" ADD COLUMN     "toolConfigId" TEXT NOT NULL DEFAULT 'builtin',
ADD COLUMN     "toolOriginalName" TEXT NOT NULL DEFAULT '';
