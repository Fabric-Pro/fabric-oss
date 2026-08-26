-- Monitoring / Error-rate + Integration Alerts — incident models + provider health.
--
-- All four new tables are GLOBAL (admin-only, no per-tenant column). RLS
-- policies are applied via `pnpm --filter @repo/database apply:rls` after
-- this migration runs.
--
-- This migration is purely additive — no existing tables are modified
-- (except the additive enum extension on NotificationType).

-- AlterEnum: extend NotificationType with two new values used by the
-- notify-incident activity (per-org integration rollups + admin SEV-1/2 pages).
-- Both values are added in this migration.
ALTER TYPE "NotificationType" ADD VALUE 'INTEGRATION_INCIDENT';
ALTER TYPE "NotificationType" ADD VALUE 'SYSTEM_INCIDENT';

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('SEV1', 'SEV2', 'SEV3');

-- CreateEnum
CREATE TYPE "IncidentEventType" AS ENUM ('FIRED', 'RE_FIRED', 'ACKNOWLEDGED', 'COMMENT', 'AUTO_RESOLVED', 'MANUAL_RESOLVED');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('FIRING', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ProviderHealthStatus" AS ENUM ('OPERATIONAL', 'DEGRADED', 'PARTIAL_OUTAGE', 'MAJOR_OUTAGE', 'MAINTENANCE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "IncidentDetectionMethod" AS ENUM ('STATUSPAGE_POLL', 'SYNTHETIC_PROBE', 'BREAKER_OPEN', 'ALERT_MANAGER', 'WEBHOOK');

-- CreateTable: ErrorRateIncident — one row per fired app-error burn-rate alert.
CREATE TABLE "error_rate_incident" (
    "id" TEXT NOT NULL,
    "alertName" TEXT NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "service" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "errorClass" TEXT,
    "status" "IncidentStatus" NOT NULL DEFAULT 'FIRING',
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "burnRate1h" DOUBLE PRECISION,
    "burnRate5m" DOUBLE PRECISION,
    "errorCount" INTEGER NOT NULL,
    "alertmanagerFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "error_rate_incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable: IntegrationIncident — one row per detected provider outage.
CREATE TABLE "integration_incident" (
    "id" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'FIRING',
    "severity" "IncidentSeverity" NOT NULL,
    "health" "ProviderHealthStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "detectionMethod" "IncidentDetectionMethod" NOT NULL,
    "statusPageUrl" TEXT,
    "statusPageIncidentId" TEXT,
    "affectedComponents" TEXT[],
    "summary" TEXT,
    "alertmanagerFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable: IncidentEvent — append-only audit log for any incident lifecycle transition.
-- XOR: exactly one of (errorRateIncidentId, integrationIncidentId) is non-null;
-- enforced by application logic, not by a DB CHECK constraint.
CREATE TABLE "incident_event" (
    "id" TEXT NOT NULL,
    "errorRateIncidentId" TEXT,
    "integrationIncidentId" TEXT,
    "eventType" "IncidentEventType" NOT NULL,
    "message" TEXT,
    "payload" JSONB,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable: IntegrationProviderRegistry — DB-backed mirror of the TS provider registry.
CREATE TABLE "integration_provider_registry" (
    "id" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "currentHealth" "ProviderHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastPolledAt" TIMESTAMP(3),
    "lastIncidentId" TEXT,
    "statusPageUrl" TEXT,
    "statusPageApiUrl" TEXT,
    "statusPagePolling" BOOLEAN NOT NULL DEFAULT true,
    "syntheticProbeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "syntheticProbeInterval" TEXT,
    "breakerKey" TEXT,
    "affectedFeatures" TEXT[],
    "dataConnectionProvider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_provider_registry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: error_rate_incident
CREATE UNIQUE INDEX "error_rate_incident_alertmanagerFingerprint_key" ON "error_rate_incident"("alertmanagerFingerprint");
CREATE INDEX "error_rate_incident_status_idx" ON "error_rate_incident"("status");
CREATE INDEX "error_rate_incident_severity_idx" ON "error_rate_incident"("severity");
CREATE INDEX "error_rate_incident_service_feature_idx" ON "error_rate_incident"("service", "feature");
CREATE INDEX "error_rate_incident_firedAt_idx" ON "error_rate_incident"("firedAt" DESC);

-- CreateIndex: integration_incident
CREATE UNIQUE INDEX "integration_incident_statusPageIncidentId_key" ON "integration_incident"("statusPageIncidentId");
CREATE UNIQUE INDEX "integration_incident_alertmanagerFingerprint_key" ON "integration_incident"("alertmanagerFingerprint");
CREATE INDEX "integration_incident_providerKey_status_idx" ON "integration_incident"("providerKey", "status");
CREATE INDEX "integration_incident_severity_idx" ON "integration_incident"("severity");
CREATE INDEX "integration_incident_startedAt_idx" ON "integration_incident"("startedAt" DESC);
CREATE INDEX "integration_incident_status_idx" ON "integration_incident"("status");

-- CreateIndex: incident_event
CREATE INDEX "incident_event_errorRateIncidentId_createdAt_idx" ON "incident_event"("errorRateIncidentId", "createdAt");
CREATE INDEX "incident_event_integrationIncidentId_createdAt_idx" ON "incident_event"("integrationIncidentId", "createdAt");

-- CreateIndex: integration_provider_registry
CREATE UNIQUE INDEX "integration_provider_registry_providerKey_key" ON "integration_provider_registry"("providerKey");
CREATE INDEX "integration_provider_registry_currentHealth_idx" ON "integration_provider_registry"("currentHealth");

-- AddForeignKey: error_rate_incident.acknowledgedBy -> user.id (SetNull on user delete)
ALTER TABLE "error_rate_incident" ADD CONSTRAINT "error_rate_incident_acknowledgedBy_fkey" FOREIGN KEY ("acknowledgedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: integration_incident.acknowledgedBy -> user.id (SetNull on user delete)
ALTER TABLE "integration_incident" ADD CONSTRAINT "integration_incident_acknowledgedBy_fkey" FOREIGN KEY ("acknowledgedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: incident_event -> parent incidents (Cascade on parent delete)
ALTER TABLE "incident_event" ADD CONSTRAINT "incident_event_errorRateIncidentId_fkey" FOREIGN KEY ("errorRateIncidentId") REFERENCES "error_rate_incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incident_event" ADD CONSTRAINT "incident_event_integrationIncidentId_fkey" FOREIGN KEY ("integrationIncidentId") REFERENCES "integration_incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: incident_event.actorUserId -> user.id (SetNull on user delete)
ALTER TABLE "incident_event" ADD CONSTRAINT "incident_event_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
