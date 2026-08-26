-- CreateEnum
CREATE TYPE "FunctionTag" AS ENUM ('PRODUCT_OWNER', 'PRODUCT_CONTRIBUTOR', 'DEVELOPER', 'ARCHITECT', 'SDET_QA', 'SME', 'STAKEHOLDER');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "defaultFunctionTags" "FunctionTag"[] DEFAULT ARRAY[]::"FunctionTag"[];

-- CreateTable
CREATE TABLE "project_user_function_tag" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "tags" "FunctionTag"[] DEFAULT ARRAY[]::"FunctionTag"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_user_function_tag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_user_function_tag_projectId_idx" ON "project_user_function_tag"("projectId");

-- CreateIndex
CREATE INDEX "project_user_function_tag_userId_idx" ON "project_user_function_tag"("userId");

-- CreateIndex
CREATE INDEX "project_user_function_tag_organizationId_idx" ON "project_user_function_tag"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "project_user_function_tag_projectId_userId_key" ON "project_user_function_tag"("projectId", "userId");

-- AddForeignKey
ALTER TABLE "project_user_function_tag" ADD CONSTRAINT "project_user_function_tag_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_user_function_tag" ADD CONSTRAINT "project_user_function_tag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_user_function_tag" ADD CONSTRAINT "project_user_function_tag_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

