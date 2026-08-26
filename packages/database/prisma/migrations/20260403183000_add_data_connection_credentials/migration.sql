CREATE TABLE "data_connection_credential" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "provider" "DataConnectionProvider" NOT NULL,
    "name" TEXT NOT NULL,
    "credentialType" TEXT,
    "encryptedPayload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "data_connection_credential_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "data_connection"
ADD COLUMN "credentialId" TEXT;

ALTER TABLE "data_connection_credential"
ADD CONSTRAINT "data_connection_credential_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "data_connection_credential"
ADD CONSTRAINT "data_connection_credential_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "data_connection_credential"
ADD CONSTRAINT "data_connection_credential_createdBy_fkey"
FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "data_connection"
ADD CONSTRAINT "data_connection_credentialId_fkey"
FOREIGN KEY ("credentialId") REFERENCES "data_connection_credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "data_connection_credential_userId_idx" ON "data_connection_credential"("userId");
CREATE INDEX "data_connection_credential_organizationId_idx" ON "data_connection_credential"("organizationId");
CREATE INDEX "data_connection_credential_provider_idx" ON "data_connection_credential"("provider");
CREATE INDEX "data_connection_credential_createdBy_idx" ON "data_connection_credential"("createdBy");
CREATE INDEX "data_connection_credentialId_idx" ON "data_connection"("credentialId");
