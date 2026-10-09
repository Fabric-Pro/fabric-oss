-- CreateEnum
CREATE TYPE "AiProviderPurpose" AS ENUM ('ALL', 'EMBEDDINGS_ONLY');

-- AlterTable
ALTER TABLE "cloud_provider_config" ADD COLUMN "purpose" "AiProviderPurpose" NOT NULL DEFAULT 'ALL';

-- AlterTable
ALTER TABLE "user_cloud_provider_config" ADD COLUMN "purpose" "AiProviderPurpose" NOT NULL DEFAULT 'ALL';
