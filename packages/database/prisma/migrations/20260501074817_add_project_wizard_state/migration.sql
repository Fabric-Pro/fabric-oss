-- AlterTable: add wizardState JSON column for in-progress wizard ephemera (selections, currentStep, customRequirements). Nulled on activation.
ALTER TABLE "project" ADD COLUMN "wizardState" JSONB;
