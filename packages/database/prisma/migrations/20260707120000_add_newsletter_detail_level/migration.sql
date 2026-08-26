ALTER TABLE "newsletter_settings" ADD COLUMN "detailLevel" TEXT NOT NULL DEFAULT 'STANDARD';
ALTER TABLE "newsletter_send" ADD COLUMN "detailLevel" TEXT;
