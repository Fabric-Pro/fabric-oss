/*
  Warnings:

  - You are about to drop the column `notionPrdSyncError` on the `project` table. All the data in the column will be lost.
  - You are about to drop the column `notionPrdWorkflowId` on the `project` table. All the data in the column will be lost.
  - You are about to drop the column `prdSourceMcpConfigId` on the `project` table. All the data in the column will be lost.
  - You are about to drop the column `prdSourceToolArgs` on the `project` table. All the data in the column will be lost.
  - You are about to drop the column `prdSourceToolName` on the `project` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "project" DROP COLUMN "notionPrdSyncError",
DROP COLUMN "notionPrdWorkflowId",
DROP COLUMN "prdSourceMcpConfigId",
DROP COLUMN "prdSourceToolArgs",
DROP COLUMN "prdSourceToolName";
