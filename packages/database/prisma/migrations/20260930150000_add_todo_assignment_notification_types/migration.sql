-- To-do assignment notifications (Fizzy #2340).
--
-- Schema delta:
--   * NotificationType += TODO_ASSIGNED (additive). Written by
--     `fanOut.todoAssigned` when a teammate makes the recipient the assignee
--     of a to-do through `todos.assign`.
--   * NotificationType += TODO_MEETING_ITEMS_ASSIGNED (additive). Written by
--     the meeting-digest owner matcher when it assigns one or more of a
--     meeting's action items to the recipient — one row per recipient per
--     meeting.
--   Both reuse the ASSIGNMENT category, so the recipient's existing
--   "assignments" toggle silences them. No existing row changes type, and only
--   code shipped with this migration writes either value — the same expand
--   step every earlier NotificationType addition took (e.g.
--   20260911120000_add_cli_connection_requested_notification_type).

-- AlterEnum
-- `IF NOT EXISTS` keeps each ADD VALUE idempotent across half-applied deploys.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TODO_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TODO_MEETING_ITEMS_ASSIGNED';
