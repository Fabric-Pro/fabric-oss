-- CreateTable
CREATE TABLE "oauth_authorization_resource" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_authorization_resource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "oauth_authorization_resource_expiresAt_idx" ON "oauth_authorization_resource"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorization_resource_clientId_codeChallenge_key" ON "oauth_authorization_resource"("clientId", "codeChallenge");
