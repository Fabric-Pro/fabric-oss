-- Send-by-email log for report-template-instance artifacts.
-- One row per recipient per Send-button click; rows of the same click share
-- a `sendId` so the history UI can collapse N recipients into a single entry.
-- Parent FK targets `template_instance_artifact` (the table the workflow
-- actually writes generated reports to; not the parallel unused
-- `report_artifact` model).

CREATE TYPE "ReportEmailDeliveryStatus" AS ENUM ('SENT', 'FAILED');

CREATE TABLE "template_instance_artifact_email_delivery" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "sendId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "recipientUserId" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "messageBody" TEXT,
    "status" "ReportEmailDeliveryStatus" NOT NULL DEFAULT 'SENT',
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_instance_artifact_email_delivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "template_instance_artifact_email_delivery_artifactId_sentAt_idx"
    ON "template_instance_artifact_email_delivery" ("artifactId", "sentAt" DESC);

CREATE INDEX "tia_email_delivery_artifact_send_idx"
    ON "template_instance_artifact_email_delivery" ("artifactId", "sentAt" DESC, "sendId");

CREATE INDEX "template_instance_artifact_email_delivery_userId_idx"
    ON "template_instance_artifact_email_delivery" ("userId");

CREATE INDEX "template_instance_artifact_email_delivery_organizationId_idx"
    ON "template_instance_artifact_email_delivery" ("organizationId");

ALTER TABLE "template_instance_artifact_email_delivery"
    ADD CONSTRAINT "template_instance_artifact_email_delivery_artifactId_fkey"
    FOREIGN KEY ("artifactId") REFERENCES "template_instance_artifact"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "template_instance_artifact_email_delivery"
    ADD CONSTRAINT "template_instance_artifact_email_delivery_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "template_instance_artifact_email_delivery"
    ADD CONSTRAINT "template_instance_artifact_email_delivery_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "template_instance_artifact_email_delivery"
    ADD CONSTRAINT "template_instance_artifact_email_delivery_recipientUserId_fkey"
    FOREIGN KEY ("recipientUserId") REFERENCES "user"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
