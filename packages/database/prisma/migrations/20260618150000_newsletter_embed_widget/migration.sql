-- AlterTable
ALTER TABLE "newsletter_settings"
  ADD COLUMN "publicWidgetEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "publicEmbedToken" TEXT,
  ADD COLUMN "publicEmbedTokenVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "publicWidgetTheme" TEXT,
  ADD COLUMN "publicWidgetAccent" TEXT,
  ADD COLUMN "publicWidgetConfig" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_settings_publicEmbedToken_key" ON "newsletter_settings"("publicEmbedToken");

-- AlterTable
ALTER TABLE "newsletter_subscriber" ADD COLUMN "embedTokenVersion" INTEGER;
