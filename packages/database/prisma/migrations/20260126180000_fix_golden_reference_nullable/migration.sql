-- AlterTable: Make goldenReferenceId nullable in document_eval
-- This fixes a schema drift where the column was NOT NULL in the database
-- but the Prisma schema defines it as optional (String?)

ALTER TABLE "document_eval" ALTER COLUMN "goldenReferenceId" DROP NOT NULL;
