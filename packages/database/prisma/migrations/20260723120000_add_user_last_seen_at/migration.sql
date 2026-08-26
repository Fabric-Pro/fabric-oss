-- Fizzy #1709: "last active" recency for the org User Activity dashboard.
-- The dashboard previously sourced recency from auth.login.success audit
-- events, but sessions last 30 days with rolling refresh, so an active user
-- never re-authenticates and reads as dormant.

ALTER TABLE "user" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

-- Backfill from all session rows (live or expired). Better Auth bumps
-- session."updatedAt" on every rolling refresh, and expired rows are never
-- pruned, giving each user their most recent session's updatedAt. This is a
-- truthful (if ~24h-granular) record of last activity. Only users with no
-- session row at all stay NULL and render as "Never active".
--
-- `impersonatedBy IS NULL` is load-bearing, not defensive. An admin
-- impersonating a user gets a session row whose "userId" is the IMPERSONATED
-- user, so without this filter every dormant account a support engineer has
-- ever opened backfills as recently active — the same corruption
-- touchLastSeenMiddleware skips impersonated sessions to avoid, and the same
-- rule packages/auth/auth.ts applies in session.create.after. It matters more
-- here than on the live write path: this is a one-time, irreversible write
-- against production data, and the accounts support opens skew toward exactly
-- the disengaged users this dashboard exists to surface.
UPDATE "user" u
SET "lastSeenAt" = s.max_updated
FROM (
    SELECT "userId", MAX("updatedAt") AS max_updated
    FROM "session"
    WHERE "impersonatedBy" IS NULL
    GROUP BY "userId"
) s
WHERE u.id = s."userId";
