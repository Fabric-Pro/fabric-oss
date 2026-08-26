-- Spec §2.3 — how a Fabric-driven run signs in to a ProjectEnvironment.
--
-- The secret column is encrypted at rest by the application (AES-256-GCM via
-- `encryptApiKey`, the same helper the repo credentials use). Postgres stores
-- ciphertext; nothing here should ever contain a readable password.
--
-- PRODUCTION environments are allowed to carry credentials. That is a product
-- decision taken 2026-07-26 — it is the customer's call — and it is why the
-- write path warns and every use is audited. Fabric holding a credential that
-- signs in to a customer's live system is a materially different posture from
-- holding a repo read token, and the schema comment should say so rather than
-- leave the next reader to discover it.
--
-- Additive and nullable throughout: every existing row is NONE, which stores no
-- secret at all, so this migration cannot change the behaviour of any
-- environment that already exists.

CREATE TYPE "environment_auth_kind" AS ENUM ('NONE', 'FORM', 'TOKEN', 'HEADER');

ALTER TABLE "project_environment"
    ADD COLUMN "authKind" "environment_auth_kind" NOT NULL DEFAULT 'NONE',
    ADD COLUMN "authUsername" TEXT,
    ADD COLUMN "encryptedAuthSecret" TEXT,
    ADD COLUMN "authHeaderName" TEXT,
    ADD COLUMN "authUpdatedAt" TIMESTAMP(3);
