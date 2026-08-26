-- AlterTable: configurable newsletter collection lookback (null = caller default)
ALTER TABLE "newsletter_settings" ADD COLUMN "lookbackDays" INTEGER;
