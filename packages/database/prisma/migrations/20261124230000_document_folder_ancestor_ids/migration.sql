-- Google Drive document folders: the ids of a folder's ancestors, which the
-- connect overlap check compares. Additive with an empty-array default, so
-- existing OneDrive and SharePoint rows keep the path-based check.
-- AlterTable
ALTER TABLE "project_document_folder" ADD COLUMN     "ancestorIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
