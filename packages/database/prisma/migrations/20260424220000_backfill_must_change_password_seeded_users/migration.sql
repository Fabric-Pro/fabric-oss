-- Backfill mustChangePassword = true for seeded users.
-- The original upstream environment backfilled a specific set of pre-seeded
-- accounts by email; that internal account list is intentionally omitted here.
-- On a fresh install there are no pre-seeded accounts to backfill, so this is a
-- no-op — the seed script sets mustChangePassword on create/update directly.
UPDATE "user"
SET "mustChangePassword" = true
WHERE false;
