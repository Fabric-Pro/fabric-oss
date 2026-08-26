-- ComponentIncident — Fabric subsystem outages (Temporal worker stalled,
-- Prisma migration drift, RAG indexer queue backed up, agent rail down, etc.)
-- Mirrors the IntegrationIncident shape so the admin monitoring dashboard
-- can list all three incident types (errorRate / integration / component)
-- side-by-side. Tenant scope is GLOBAL.

-- AlterTable
ALTER TABLE "incident_event" ADD COLUMN "componentIncidentId" TEXT;

-- CreateTable
CREATE TABLE "component_incident" (
    "id" TEXT NOT NULL,
    "componentKey" TEXT NOT NULL,
    "componentName" TEXT NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'FIRING',
    "severity" "IncidentSeverity" NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,
    "autoResolved" BOOLEAN NOT NULL DEFAULT false,
    "summary" TEXT,
    "alertmanagerFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "component_incident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "component_incident_alertmanagerFingerprint_key" ON "component_incident"("alertmanagerFingerprint");
CREATE INDEX "component_incident_componentKey_status_idx" ON "component_incident"("componentKey", "status");
CREATE INDEX "component_incident_severity_idx" ON "component_incident"("severity");
CREATE INDEX "component_incident_firedAt_idx" ON "component_incident"("firedAt" DESC);
CREATE INDEX "component_incident_status_idx" ON "component_incident"("status");

-- IncidentEvent.componentIncidentId — extend the polymorphic relation so the
-- existing timeline ledger renders ComponentIncident events alongside the
-- other two types.
CREATE INDEX "incident_event_componentIncidentId_createdAt_idx" ON "incident_event"("componentIncidentId", "createdAt");

-- AddForeignKey
ALTER TABLE "incident_event" ADD CONSTRAINT "incident_event_componentIncidentId_fkey" FOREIGN KEY ("componentIncidentId") REFERENCES "component_incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "component_incident" ADD CONSTRAINT "component_incident_acknowledgedBy_fkey" FOREIGN KEY ("acknowledgedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
