-- A nomination is waiting for the admin tier that can decide it (Fizzy #2068 FR16).
--
-- Adding an enum value is a one-way door in Postgres, so this is written by
-- hand and made idempotent: a re-run against a database that already has the
-- value must not fail the deploy.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PROMPT_NOMINATION_PENDING';
