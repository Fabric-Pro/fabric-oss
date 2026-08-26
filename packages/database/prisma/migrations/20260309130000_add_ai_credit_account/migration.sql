-- CreateTable
CREATE TABLE "ai_credit_account" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "usedCreditUsd" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_credit_account_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_credit_account_tenant_xor" CHECK ((("organizationId" IS NOT NULL) AND ("userId" IS NULL)) OR (("organizationId" IS NULL) AND ("userId" IS NOT NULL)))
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_credit_account_organizationId_key" ON "ai_credit_account"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_credit_account_userId_key" ON "ai_credit_account"("userId");

-- CreateIndex
CREATE INDEX "ai_credit_account_organizationId_idx" ON "ai_credit_account"("organizationId");

-- CreateIndex
CREATE INDEX "ai_credit_account_userId_idx" ON "ai_credit_account"("userId");

-- AddForeignKey
ALTER TABLE "ai_credit_account" ADD CONSTRAINT "ai_credit_account_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_credit_account" ADD CONSTRAINT "ai_credit_account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
