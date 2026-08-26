CREATE TABLE "project_qa_webhook" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "secretHint" TEXT NOT NULL,
    "previousEncryptedSecret" TEXT,
    "previousSecretRetiresAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "lastDeliveryAt" TIMESTAMP(3),
    "deliveryCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_qa_webhook_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_qa_webhook_tenant_xor" CHECK (
        ("userId" IS NULL) <> ("organizationId" IS NULL)
    ),
    CONSTRAINT "project_qa_webhook_previous_secret_pair" CHECK (
        ("previousEncryptedSecret" IS NULL) =
        ("previousSecretRetiresAt" IS NULL)
    )
);

CREATE TABLE "project_qa_webhook_delivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "bodyDigest" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_qa_webhook_delivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_qa_webhook_projectId_key"
    ON "project_qa_webhook"("projectId");
CREATE INDEX "project_qa_webhook_userId_idx"
    ON "project_qa_webhook"("userId");
CREATE INDEX "project_qa_webhook_organizationId_idx"
    ON "project_qa_webhook"("organizationId");
CREATE UNIQUE INDEX "project_qa_webhook_delivery_webhookId_provider_deliveryId_key"
    ON "project_qa_webhook_delivery"("webhookId", "provider", "deliveryId");
CREATE UNIQUE INDEX "project_qa_webhook_delivery_webhookId_provider_bodyDigest_key"
    ON "project_qa_webhook_delivery"("webhookId", "provider", "bodyDigest");
CREATE INDEX "project_qa_webhook_delivery_webhookId_receivedAt_idx"
    ON "project_qa_webhook_delivery"("webhookId", "receivedAt");

ALTER TABLE "project_qa_webhook"
    ADD CONSTRAINT "project_qa_webhook_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_qa_webhook"
    ADD CONSTRAINT "project_qa_webhook_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_qa_webhook"
    ADD CONSTRAINT "project_qa_webhook_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_qa_webhook_delivery"
    ADD CONSTRAINT "project_qa_webhook_delivery_webhookId_fkey"
    FOREIGN KEY ("webhookId") REFERENCES "project_qa_webhook"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
