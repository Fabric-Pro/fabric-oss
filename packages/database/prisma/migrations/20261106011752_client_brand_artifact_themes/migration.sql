-- CreateEnum
CREATE TYPE "ArtifactBrandSource" AS ENUM ('COMPANY', 'CLIENT');

-- CreateEnum
CREATE TYPE "ArtifactCoverStyle" AS ENUM ('DARK', 'LIGHT', 'MINIMAL');

-- AlterTable
ALTER TABLE "project_document_style" ADD COLUMN     "brandSource" "ArtifactBrandSource" NOT NULL DEFAULT 'COMPANY',
ADD COLUMN     "coverStyle" "ArtifactCoverStyle";

-- AlterTable
ALTER TABLE "project_recipient_brand" ADD COLUMN     "bodyFontFamily" TEXT,
ADD COLUMN     "coverStyle" "ArtifactCoverStyle" NOT NULL DEFAULT 'DARK',
ADD COLUMN     "displayFontFamily" TEXT;

-- Only committed, licensed font families can reach previews and offline print.
-- The nullable columns start empty; old writers preserve their stored values.
ALTER TABLE "project_recipient_brand"
  ADD CONSTRAINT "project_recipient_brand_display_font_catalog"
    CHECK ("displayFontFamily" IS NULL OR "displayFontFamily" IN ('Inter', 'Poppins', 'JetBrains Mono')) NOT VALID,
  ADD CONSTRAINT "project_recipient_brand_body_font_catalog"
    CHECK ("bodyFontFamily" IS NULL OR "bodyFontFamily" IN ('Inter', 'Poppins', 'JetBrains Mono')) NOT VALID;

ALTER TABLE "project_recipient_brand"
  VALIDATE CONSTRAINT "project_recipient_brand_display_font_catalog";
ALTER TABLE "project_recipient_brand"
  VALIDATE CONSTRAINT "project_recipient_brand_body_font_catalog";
