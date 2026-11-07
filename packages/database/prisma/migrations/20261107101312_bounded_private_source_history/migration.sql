-- AlterTable
ALTER TABLE "delivery_signal_source_command" ADD COLUMN     "captureWindowEnd" TIMESTAMP(3),
ADD COLUMN     "captureWindowStart" TIMESTAMP(3);

-- Immutable selected history intent is metadata. Existing owner/org RLS continues to apply.
ALTER TABLE "delivery_signal_source_command" ADD CONSTRAINT "delivery_source_capture_window_valid" CHECK (
 ("captureMode" = 'BACKFILL' AND operation = 'CAPTURE' AND "captureWindowStart" IS NOT NULL AND "captureWindowEnd" IS NOT NULL AND "captureWindowStart" < "captureWindowEnd" AND "captureWindowEnd" - "captureWindowStart" <= interval '7 days')
 OR ("captureMode" IS DISTINCT FROM 'BACKFILL' AND "captureWindowStart" IS NULL AND "captureWindowEnd" IS NULL)
);
