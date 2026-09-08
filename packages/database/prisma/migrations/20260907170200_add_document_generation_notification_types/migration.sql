-- AlterEnum
-- Terminal notifications for a document-generation run the recipient started.
--
-- Split into two types rather than one "finished" type, mirroring
-- REPORT_COMPLETED / REPORT_FAILED: a run that queued behind its dependencies
-- may land long after the requester stopped watching, so the notification is the
-- whole outcome and has to say which outcome it is without being opened.
--
-- Both reuse an existing NotificationCategory, so no category enum change is
-- required. Kept in its own migration, mirroring
-- 20260901120100_add_question_routing_notification_types: a value added by ALTER
-- TYPE cannot be referenced in the transaction that adds it.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DOCUMENT_GENERATION_COMPLETED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DOCUMENT_GENERATION_FAILED';
