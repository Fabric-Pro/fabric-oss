-- Per-user email opt-out for report-run notifications (Fizzy #1692, default ON).
ALTER TABLE "notification_preference" ADD COLUMN "reportEmails" BOOLEAN NOT NULL DEFAULT true;

-- Durable at-most-once claim for the report-run completion/failure email.
ALTER TABLE "template_instance_execution" ADD COLUMN "emailSentAt" TIMESTAMP(3);
