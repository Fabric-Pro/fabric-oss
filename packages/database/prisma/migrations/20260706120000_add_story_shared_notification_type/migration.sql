-- In-Feature Collaboration — Notify project members from the feature editor.
--
-- Schema delta:
--   * NotificationType += STORY_SHARED (additive — existing consumers ignore
--     unknown enum values). Written by `fanOut.storyShared` when a user tags
--     project members from the feature editor; reuses the MENTION category.

-- AlterEnum
-- `IF NOT EXISTS` keeps the ADD VALUE idempotent across half-applied deploys.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'STORY_SHARED';
