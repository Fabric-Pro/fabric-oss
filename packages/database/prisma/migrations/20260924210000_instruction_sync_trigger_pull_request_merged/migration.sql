-- AlterEnum
-- Coding Instructions proposal pull requests (Fizzy #2563 spec §4.5 step 1):
-- the sync trigger a merged proposal pull request dispatches (spec §9.1).
--
-- Alone in its own migration: a value added by ALTER TYPE cannot be used in
-- the transaction that adds it, and nothing may use this one before it has
-- committed. Additive; the value cannot be removed while a run row holds it.
ALTER TYPE "ProjectInstructionSyncTrigger" ADD VALUE 'PULL_REQUEST_MERGED';
