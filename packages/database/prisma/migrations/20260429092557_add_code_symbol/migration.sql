-- CreateTable
CREATE TABLE "code_symbol" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "lineStart" INTEGER NOT NULL,
    "lineEnd" INTEGER,
    "signature" TEXT,
    "language" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_symbol_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "code_symbol_projectId_name_idx" ON "code_symbol"("projectId", "name");

-- CreateIndex
CREATE INDEX "code_symbol_projectId_type_idx" ON "code_symbol"("projectId", "type");

-- CreateIndex
CREATE INDEX "code_symbol_userId_idx" ON "code_symbol"("userId");

-- CreateIndex
CREATE INDEX "code_symbol_organizationId_idx" ON "code_symbol"("organizationId");

-- AddForeignKey
ALTER TABLE "code_symbol" ADD CONSTRAINT "code_symbol_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_symbol" ADD CONSTRAINT "code_symbol_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_symbol" ADD CONSTRAINT "code_symbol_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
