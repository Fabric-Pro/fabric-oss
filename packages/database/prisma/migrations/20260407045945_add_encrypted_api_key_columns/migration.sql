-- AlterTable
ALTER TABLE "cloud_provider_config" ADD COLUMN     "encrypted_api_key" TEXT;

-- AlterTable
ALTER TABLE "user_cloud_provider_config" ADD COLUMN     "encrypted_api_key" TEXT;
