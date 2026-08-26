-- CreateTable: RequestSpan — tail-sampled spans persisted on failure.
-- Append-only. Trace viewer joins to AuditLog rows via correlationId.
-- Storage is bounded because spans only persist when the originating
-- request errored (success path drops the in-memory buffer).
CREATE TABLE "request_span" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "correlationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "attributes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_span_pkey" PRIMARY KEY ("id")
);

-- Trace viewer's primary query: pull every span for a correlationId
-- ordered by startedAt. (correlationId, startedAt) covers it.
CREATE INDEX "request_span_correlationId_startedAt_idx"
    ON "request_span"("correlationId", "startedAt");

-- Retention sweep + tenant-scoped diagnostics.
CREATE INDEX "request_span_organizationId_createdAt_idx"
    ON "request_span"("organizationId", "createdAt" DESC);

CREATE INDEX "request_span_userId_createdAt_idx"
    ON "request_span"("userId", "createdAt" DESC);
