-- Add NOT_CONFIGURED to the ProviderHealthStatus enum.
--
-- NOT_CONFIGURED represents a provider whose synthetic-probe activity
-- cannot run because the required environment variables (e.g.,
-- STRIPE_SECRET_KEY, AWS_S3_BUCKET) are not set in this environment.
-- It is distinct from MAJOR_OUTAGE — the provider itself is not down,
-- we just can't probe it from here. The admin UI renders it as a
-- neutral/gray "Not configured" badge and the active-incidents banner
-- ignores it so missing staging credentials don't trip SEV-1 paging.
--
-- This is an additive enum change: no existing rows reference the new
-- value, no tables are altered, and Postgres `ADD VALUE` is safe to run
-- against a live cluster.

ALTER TYPE "ProviderHealthStatus" ADD VALUE 'NOT_CONFIGURED';
