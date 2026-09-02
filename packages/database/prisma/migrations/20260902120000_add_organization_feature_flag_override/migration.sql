-- CreateTable
CREATE TABLE "organization_feature_flag_override" (
    "key" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "organization_feature_flag_override_pkey" PRIMARY KEY ("key","organizationId")
);

-- AddForeignKey
ALTER TABLE "organization_feature_flag_override" ADD CONSTRAINT "organization_feature_flag_override_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

