-- Parlume webhook hardening.
--
-- Each bot's webhook URL now carries a random token for its session, stored
-- here only as a SHA-256 digest and cleared once nothing more is owed to the
-- bot's webhooks. It replaces a token derived from the service secret, which
-- never expired. A session invited before this change has no digest, so its
-- webhooks are refused; the stream close and the sweep still finalize it.
--
-- When Fabric has the Attendee project's webhook secret (the operator's from
-- the environment, or the one an organization saves with its own Attendee
-- key, encrypted like the key), a webhook must also carry Attendee's
-- signature. Without a secret the token alone is accepted.
--
-- A receipt per delivery that carries an idempotency key lets a redelivery be
-- acknowledged without acting on it twice.
--
-- Hand-written rather than generated: `prisma migrate dev` carries unrelated
-- drift between the migration history and schema.prisma, which must not ride
-- along with this change.
--
-- Tenancy: the receipt carries the session's projectId, organizationId and
-- userId. RLS (scripts/apply-rls-direct.ts) gives it `user_owned`, like the
-- session's other children.

-- AlterTable
ALTER TABLE "organization_parlume_settings"
  ADD COLUMN "encryptedAttendeeWebhookSecret" TEXT;

-- AlterTable
ALTER TABLE "parlume_meeting_session"
  ADD COLUMN "callbackTokenDigest" TEXT;

-- CreateTable
CREATE TABLE "parlume_webhook_receipt" (
  "sessionId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "parlume_webhook_receipt_pkey" PRIMARY KEY ("sessionId", "idempotencyKey"),
  CONSTRAINT "parlume_webhook_receipt_sessionId_fkey" FOREIGN KEY ("sessionId")
    REFERENCES "parlume_meeting_session"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "parlume_webhook_receipt_projectId_idx" ON "parlume_webhook_receipt"("projectId");
CREATE INDEX "parlume_webhook_receipt_organizationId_idx" ON "parlume_webhook_receipt"("organizationId");
