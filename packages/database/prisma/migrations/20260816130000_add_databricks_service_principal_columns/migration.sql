-- Service-principal (OAuth M2M) credentials for AI provider configs.
-- Nullable and additive: existing rows keep authenticating with
-- `encrypted_api_key`. A row carries either a static key/PAT or a service
-- principal (client_id + encrypted_client_secret), never both — the XOR is
-- enforced at the API boundary, not by a DB constraint, so that legacy rows
-- and future providers stay writable.

-- AlterTable
ALTER TABLE "cloud_provider_config" ADD COLUMN     "client_id" TEXT,
ADD COLUMN     "encrypted_client_secret" TEXT;

-- AlterTable
ALTER TABLE "user_cloud_provider_config" ADD COLUMN     "client_id" TEXT,
ADD COLUMN     "encrypted_client_secret" TEXT;
