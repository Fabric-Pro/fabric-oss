-- Brand sources for client-document Proposals (Fizzy #2946).
--
-- The Brand kit gains the preparer's primary colour, fonts, hero image and
-- website. A value fetched from a website never lands in a row a person
-- writes: the organization's website fetch and the recipient website fetch
-- each keep their own sidecar row, and the export worker records the brand an
-- export printed in a third. So no automated write can replace a value a
-- person chose, and a fetched value survives a person's override.
--
-- No backfill: every value already stored was typed by a person, and a null
-- Style primary colour already means "no override". This holds while no reader
-- treats a null Style primary as anything but "inherit"; the part-1 visuals
-- palette did (it promoted the first accent or a recipient colour), and the
-- same change replaces it with the shared resolver.

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "organization_brand_kit" ADD COLUMN     "bodyFontFamily" TEXT,
ADD COLUMN     "bodyFontKey" TEXT,
ADD COLUMN     "displayFontFamily" TEXT,
ADD COLUMN     "displayFontKey" TEXT,
ADD COLUMN     "heroKey" TEXT,
ADD COLUMN     "primaryColor" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "website" TEXT;

-- AlterTable
ALTER TABLE "project_recipient_brand" ADD COLUMN     "logoHash" TEXT;

-- CreateTable
CREATE TABLE "organization_brand_site_fetch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "website" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "failureCode" TEXT,
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "resultWebsite" TEXT,
    "primaryColor" TEXT,
    "accentColors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_brand_site_fetch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_recipient_brand_suggestion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "website" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "failureCode" TEXT,
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "resultWebsite" TEXT,
    "name" TEXT,
    "colors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "logoKey" TEXT,
    "logoHash" TEXT,
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_recipient_brand_suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_document_export_brand" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "themeTokenHash" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "exportedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_document_export_brand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_brand_site_fetch_organizationId_key" ON "organization_brand_site_fetch"("organizationId");

-- CreateIndex
CREATE INDEX "organization_brand_site_fetch_requestedById_idx" ON "organization_brand_site_fetch"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "project_recipient_brand_suggestion_projectId_key" ON "project_recipient_brand_suggestion"("projectId");

-- CreateIndex
CREATE INDEX "project_recipient_brand_suggestion_organizationId_idx" ON "project_recipient_brand_suggestion"("organizationId");

-- CreateIndex
CREATE INDEX "project_recipient_brand_suggestion_requestedById_idx" ON "project_recipient_brand_suggestion"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "project_document_export_brand_documentId_key" ON "project_document_export_brand"("documentId");

-- CreateIndex
CREATE INDEX "project_document_export_brand_projectId_idx" ON "project_document_export_brand"("projectId");

-- CreateIndex
CREATE INDEX "project_document_export_brand_organizationId_idx" ON "project_document_export_brand"("organizationId");

-- AddForeignKey
ALTER TABLE "organization_brand_site_fetch" ADD CONSTRAINT "organization_brand_site_fetch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_brand_site_fetch" ADD CONSTRAINT "organization_brand_site_fetch_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_recipient_brand_suggestion" ADD CONSTRAINT "project_recipient_brand_suggestion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_recipient_brand_suggestion" ADD CONSTRAINT "project_recipient_brand_suggestion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_recipient_brand_suggestion" ADD CONSTRAINT "project_recipient_brand_suggestion_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_export_brand" ADD CONSTRAINT "project_document_export_brand_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "project_document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_export_brand" ADD CONSTRAINT "project_document_export_brand_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_document_export_brand" ADD CONSTRAINT "project_document_export_brand_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Kit columns added above: every existing row is NULL (or the default 1), so
-- each check is trivially satisfied and there is nothing to back-scan.

-- migration-lint: allow unvalidated-constraint — the column is added in this same migration.
ALTER TABLE "organization_brand_kit" ADD CONSTRAINT "organization_brand_kit_primary_color_check"
  CHECK ("primaryColor" IS NULL OR "primaryColor" ~ '^#[0-9a-f]{6}$');

-- Family names are written into CSS and DOCX styles: letters, digits, spaces
-- and hyphens only, 2 to 64 characters, as the theme's own rule.
-- migration-lint: allow unvalidated-constraint — the columns are added in this same migration.
ALTER TABLE "organization_brand_kit" ADD CONSTRAINT "organization_brand_kit_font_family_check"
  CHECK (("displayFontFamily" IS NULL
          OR "displayFontFamily" ~ '^[A-Za-z0-9][A-Za-z0-9 -]{0,62}[A-Za-z0-9]$')
         AND ("bodyFontFamily" IS NULL
          OR "bodyFontFamily" ~ '^[A-Za-z0-9][A-Za-z0-9 -]{0,62}[A-Za-z0-9]$'));

-- Each key is the one shape its own upload writes, under THIS organization's
-- prefix: never a pending upload, another organization's object or a path.
-- migration-lint: allow unvalidated-constraint — the columns are added in this same migration.
ALTER TABLE "organization_brand_kit" ADD CONSTRAINT "organization_brand_kit_font_key_check"
  CHECK (("displayFontKey" IS NULL
          OR "displayFontKey" ~ ('^organization-brand/' || "organizationId"
                                 || '/fonts/[A-Za-z0-9_-]+\.(woff2|ttf)$'))
         AND ("bodyFontKey" IS NULL
          OR "bodyFontKey" ~ ('^organization-brand/' || "organizationId"
                              || '/fonts/[A-Za-z0-9_-]+\.(woff2|ttf)$')));

-- migration-lint: allow unvalidated-constraint — the column is added in this same migration.
ALTER TABLE "organization_brand_kit" ADD CONSTRAINT "organization_brand_kit_hero_key_check"
  CHECK ("heroKey" IS NULL
         OR "heroKey" ~ ('^organization-brand/' || "organizationId"
                         || '/hero/[A-Za-z0-9_-]+\.(png|jpg)$'));

-- The website is compared by equality with the fetch rows below, so it is
-- stored only in the one normalized shape the server writes.
-- migration-lint: allow unvalidated-constraint — the column is added in this same migration.
ALTER TABLE "organization_brand_kit" ADD CONSTRAINT "organization_brand_kit_website_check"
  CHECK ("website" IS NULL OR "website" ~ '^https://[a-z0-9.-]+$');

-- migration-lint: allow unvalidated-constraint — the column is added in this same migration.
ALTER TABLE "organization_brand_kit" ADD CONSTRAINT "organization_brand_kit_version_check"
  CHECK ("version" >= 1);

-- migration-lint: allow unvalidated-constraint — the column is added in this same migration.
ALTER TABLE "project_recipient_brand" ADD CONSTRAINT "project_recipient_brand_logo_hash_check"
  CHECK ("logoHash" IS NULL OR "logoHash" ~ '^[0-9a-f]{64}$');

-- The fetch rows: an attempt is RUNNING, SUCCEEDED or FAILED, and only a
-- FAILED one carries a code. Colours reach CSS and SVG, so only lowercase
-- #rrggbb is representable.
ALTER TABLE "organization_brand_site_fetch" ADD CONSTRAINT "organization_brand_site_fetch_status_check"
  CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED')
         AND (("status" = 'FAILED') = ("failureCode" IS NOT NULL))
         AND ("failureCode" IS NULL OR "failureCode" ~ '^[a-z_]{1,40}$'));

ALTER TABLE "organization_brand_site_fetch" ADD CONSTRAINT "organization_brand_site_fetch_website_check"
  CHECK ("website" ~ '^https://[a-z0-9.-]+$'
         AND ("resultWebsite" IS NULL OR "resultWebsite" ~ '^https://[a-z0-9.-]+$'));

ALTER TABLE "organization_brand_site_fetch" ADD CONSTRAINT "organization_brand_site_fetch_colors_check"
  CHECK (("primaryColor" IS NULL OR "primaryColor" ~ '^#[0-9a-f]{6}$')
         AND cardinality("accentColors") <= 3
         AND array_position("accentColors", NULL) IS NULL
         AND array_to_string("accentColors", ',') ~ '^(#[0-9a-f]{6}(,#[0-9a-f]{6})*)?$');

ALTER TABLE "project_recipient_brand_suggestion" ADD CONSTRAINT "project_recipient_brand_suggestion_status_check"
  CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED')
         AND (("status" = 'FAILED') = ("failureCode" IS NOT NULL))
         AND ("failureCode" IS NULL OR "failureCode" ~ '^[a-z_]{1,40}$'));

ALTER TABLE "project_recipient_brand_suggestion" ADD CONSTRAINT "project_recipient_brand_suggestion_website_check"
  CHECK ("website" ~ '^https://[a-z0-9.-]+$'
         AND ("resultWebsite" IS NULL OR "resultWebsite" ~ '^https://[a-z0-9.-]+$'));

ALTER TABLE "project_recipient_brand_suggestion" ADD CONSTRAINT "project_recipient_brand_suggestion_fields_check"
  CHECK (("name" IS NULL OR char_length("name") <= 200)
         AND cardinality("colors") <= 3
         AND array_position("colors", NULL) IS NULL
         AND array_to_string("colors", ',') ~ '^(#[0-9a-f]{6}(,#[0-9a-f]{6})*)?$'
         AND ("logoHash" IS NULL OR "logoHash" ~ '^[0-9a-f]{64}$'));

-- A suggested logo is a server-issued object under THIS project's prefix.
ALTER TABLE "project_recipient_brand_suggestion" ADD CONSTRAINT "project_recipient_brand_suggestion_logo_key_check"
  CHECK ("logoKey" IS NULL
         OR "logoKey" ~ ('^project-brand/' || "projectId"
                         || '/recipient-brand/suggested/[A-Za-z0-9_-]+\.png$'));

ALTER TABLE "project_document_export_brand" ADD CONSTRAINT "project_document_export_brand_fields_check"
  CHECK ("format" IN ('PDF', 'DOCX')
         AND "themeTokenHash" ~ '^t[0-9]+:[0-9a-f]{16}$');
