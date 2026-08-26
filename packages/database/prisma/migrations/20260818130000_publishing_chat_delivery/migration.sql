-- Publishing Suite 1C-3: the per-channel BROADCAST ledger.
--
-- A SEPARATE TABLE from publishing_notification_delivery, and the reason is structural rather than
-- stylistic. That ledger's unique key is (cycleId, recipientUserId, channel), with recipientUserId
-- NOT NULL and an FK to "user" — it addresses a person. A broadcast addresses a room, so it has no
-- recipient to key on. Two workarounds were considered and refused: a row per recipient pointing at
-- one posted message makes every row assert something untrue (that this person was notified
-- individually), and making recipientUserId nullable silently disables the dedupe, because
-- PostgreSQL permits unlimited duplicate NULLs in a unique index — the trap that ledger's own
-- creating migration already records as the reason it keys on the recipient rather than the tenant
-- userId.
--
-- Shaped on newsletter_chat_delivery, which is the same kind of ledger for the same reason.
--
-- Both CHECKs are inline and VALIDATING rather than NOT VALID, which is correct precisely because
-- the table is created in this same file: there is no existing row to scan and no concurrent writer
-- to block. scripts/lint-migrations.ts encodes the same distinction by only flagging pre-existing
-- tables.
CREATE TABLE "publishing_chat_delivery" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "platform" TEXT NOT NULL,
    "externalTeamId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "errorMessage" TEXT,
    "postedMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "publishing_chat_delivery_pkey" PRIMARY KEY ("id")
);

-- The claim-before-post key, and the single gate the no-double-post guarantee rests on: the sender
-- claims by INSERT and reads a conflict as "already handled, do not post". Chat posts are not
-- idempotent and a duplicate in a shared channel cannot be withdrawn.
CREATE UNIQUE INDEX "publishing_chat_delivery_cycle_channel_key"
  ON "publishing_chat_delivery"("cycleId", "platform", "externalTeamId", "channelId");
CREATE INDEX "publishing_chat_delivery_projectId_createdAt_idx"
  ON "publishing_chat_delivery"("projectId", "createdAt");

ALTER TABLE "publishing_chat_delivery" ADD CONSTRAINT "publishing_chat_delivery_cycleId_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "publishing_suggestion_cycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant XOR, matching publishing_topic / publishing_suggestion_cycle / publishing_suite_settings /
-- publishing_notification_delivery. This also keeps the user_owned RLS policy meaningful: its
-- organization branch tests organizationId only.
ALTER TABLE "publishing_chat_delivery"
    ADD CONSTRAINT "publishing_chat_delivery_tenant_xor"
    CHECK (("organizationId" IS NULL) <> ("userId" IS NULL));

-- THE WHOLE STATUS SET IN ONE MIGRATION, which is a deliberate departure from the rule the sibling
-- ledger's creating migration states ("a status whose lifecycle has not shipped should not be
-- writable when making it unwritable is free"). Here it is NOT free, and the rule does not bite.
-- That rule protects a table that HAS writers from admitting a status its readers cannot handle;
-- this table has no writer at all until the sending slice, so nothing can write any of these four.
-- Shipping a narrower predicate now would buy zero protection and cost a NOT VALID widening on a
-- live table plus a validation obligation in pending-constraint-validations.json — a real deadline
-- taken on to guard against a writer that cannot exist.
ALTER TABLE "publishing_chat_delivery"
    ADD CONSTRAINT "publishing_chat_delivery_status_check"
    CHECK ("status" IN ('SENDING','SENT','FAILED','SKIPPED'));
