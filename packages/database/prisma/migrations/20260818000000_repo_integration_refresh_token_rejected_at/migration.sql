-- Marks a repository integration whose stored OAuth REFRESH token the provider
-- has rejected outright (a grant-shaped rejection such as GitHub's
-- `bad_refresh_token`), as opposed to a platform-side refresh failure.
--
-- The scheduled repo health check deliberately keeps re-sweeping TOKEN_EXPIRED
-- GitHub/GitLab OAuth rows, because for those a refresh normally recovers the
-- connection. When the grant itself is dead that retry can never succeed, so
-- the sweep re-probed and re-exchanged every 30 minutes indefinitely. This
-- column lets the sweep retire such rows until the user reconnects.
--
-- Nullable and defaulted to NULL: existing rows keep today's behaviour and are
-- re-evaluated on their next refresh attempt.
ALTER TABLE "project_repository_integration"
  ADD COLUMN "refreshTokenRejectedAt" TIMESTAMP(3);
