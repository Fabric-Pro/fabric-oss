-- AlterTable: verifiable source link for a finding (repo file / commit URL).
ALTER TABLE "scan_finding" ADD COLUMN "sourceUrl" TEXT;
