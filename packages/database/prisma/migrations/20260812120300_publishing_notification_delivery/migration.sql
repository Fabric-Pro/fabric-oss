-- Publishing Suite 1C-2b: the per-recipient, per-channel delivery ledger (§5.2).
--
-- Both CHECKs are inline and validating rather than NOT VALID, and that is correct here precisely
-- because the table is created in this same file: there is no existing row to scan and no
-- concurrent writer to block. The rule "every CHECK on a live table uses the expand sequence" is
-- about live tables; scripts/lint-migrations.ts encodes the same distinction by only flagging
-- pre-existing tables.
CREATE TABLE "publishing_notification_delivery" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "recipientUserId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "publishing_notification_delivery_pkey" PRIMARY KEY ("id")
);

-- The dedupe key AND, for IN_APP, the fence. recipientUserId, never the tenant userId: in
-- organization context the tenant userId is NULL, and PostgreSQL permits unlimited duplicate NULLs
-- in a unique index — keying on it would have silently disabled retry dedupe for exactly the org
-- projects, with no error to notice.
CREATE UNIQUE INDEX "publishing_notification_delivery_cycle_recipient_channel_key"
  ON "publishing_notification_delivery"("cycleId", "recipientUserId", "channel");
CREATE INDEX "publishing_notification_delivery_projectId_createdAt_idx"
  ON "publishing_notification_delivery"("projectId", "createdAt");

ALTER TABLE "publishing_notification_delivery" ADD CONSTRAINT "publishing_notification_delivery_cycleId_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "publishing_suggestion_cycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "publishing_notification_delivery" ADD CONSTRAINT "publishing_notification_delivery_recipientUserId_fkey"
    FOREIGN KEY ("recipientUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant XOR, matching publishing_topic / publishing_suggestion_cycle / publishing_suite_settings.
-- Personal context => organizationId NULL; organization context => userId NULL. Never both, never
-- neither. This also keeps the user_owned RLS policy meaningful: its organization branch tests
-- organizationId only.
ALTER TABLE "publishing_notification_delivery"
    ADD CONSTRAINT "publishing_notification_delivery_tenant_xor"
    CHECK (("organizationId" IS NULL) <> ("userId" IS NULL));

-- 1C-2b writes exactly three statuses. SENDING arrives in 1C-2c alongside the lease columns that
-- produce it; DEFERRED and EXPIRED in 1C-2d alongside the sweep that discharges them. A status
-- whose lifecycle has not shipped should not be writable when making it unwritable is free.
ALTER TABLE "publishing_notification_delivery"
    ADD CONSTRAINT "publishing_notification_delivery_status_check"
    CHECK ("status" IN ('SENT','FAILED','SKIPPED'));
