-- Global, instance-wide feature-flag overrides. A row in this table overrides the
-- corresponding FABRIC_FEATURE_* environment variable for that flag. An empty table
-- reproduces pre-feature behavior exactly, and `DELETE FROM feature_flag_override`
-- is a complete rollback with no deploy.

CREATE TABLE "feature_flag_override" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "feature_flag_override_pkey" PRIMARY KEY ("key")
);
