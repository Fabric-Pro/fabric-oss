-- Context Source Type Labeling (Fizzy #1888).
-- Both columns nullable on purpose: sources without them behave exactly as
-- before, so no backfill is needed and rollback is a flag flip.
-- Hand-written instead of `migrate dev`-generated because master's migration
-- chain currently replays with unrelated index/default drift against
-- schema.prisma; the generated diff swept that drift into this migration.

-- AlterTable
ALTER TABLE "project_context" ADD COLUMN     "sourceType" TEXT,
ADD COLUMN     "aiInstructions" TEXT;
