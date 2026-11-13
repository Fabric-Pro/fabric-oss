-- A reviewer can show an image above its highlight's description instead of
-- below it. Plain text like `captureState` and `source`: BELOW or ABOVE.
--
-- The column defaults to BELOW, where every image sat until now, so existing
-- rows need no backfill and the previous app version keeps working.

-- AlterTable
ALTER TABLE "newsletter_send_image" ADD COLUMN "placement" TEXT NOT NULL DEFAULT 'BELOW';
