-- SOC 2 CC6.1 — opt-in organization-wide MFA enforcement flag.
-- Default false so enabling the feature changes nothing for any existing org
-- until an owner/admin turns it on. Additive, backward-compatible column add.
ALTER TABLE "organization" ADD COLUMN "requireTwoFactor" BOOLEAN NOT NULL DEFAULT false;
