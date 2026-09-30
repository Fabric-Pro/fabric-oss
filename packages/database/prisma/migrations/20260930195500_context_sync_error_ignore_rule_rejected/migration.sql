-- A Living Memory sync refuses a `.contextignore` rule that would make the
-- `ignore` matcher's running time explode (Fizzy #2784).
--
-- Schema delta:
--   * ProjectContextSyncError += IGNORE_RULE_REJECTED (additive). Written by
--     the sync when a selected folder's `.contextignore` holds a rule with
--     more `**` groups than the matcher can evaluate in bounded time; the run
--     fails instead of dropping the rule, which would sync files the rule was
--     meant to exclude. The run's `limitDetail` names the rule's line. No
--     existing row changes, and only code shipped with this migration writes
--     the value: the same expand step every earlier enum addition took.

-- AlterEnum
-- `IF NOT EXISTS` keeps the ADD VALUE idempotent across half-applied deploys.
ALTER TYPE "ProjectContextSyncError" ADD VALUE IF NOT EXISTS 'IGNORE_RULE_REJECTED';
