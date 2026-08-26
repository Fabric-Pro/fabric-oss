-- DropForeignKey
ALTER TABLE "release_notification_settings" DROP CONSTRAINT "release_notification_settings_projectId_fkey";

-- DropForeignKey
ALTER TABLE "release_notification_settings" DROP CONSTRAINT "release_notification_settings_userId_fkey";

-- DropForeignKey
ALTER TABLE "release_notification_settings" DROP CONSTRAINT "release_notification_settings_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "release_notification_webhook" DROP CONSTRAINT "release_notification_webhook_settingsId_fkey";

-- DropForeignKey
ALTER TABLE "release_notification_webhook" DROP CONSTRAINT "release_notification_webhook_projectId_fkey";

-- DropForeignKey
ALTER TABLE "release_notification_webhook" DROP CONSTRAINT "release_notification_webhook_userId_fkey";

-- DropForeignKey
ALTER TABLE "release_notification_webhook" DROP CONSTRAINT "release_notification_webhook_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "release_notification_send" DROP CONSTRAINT "release_notification_send_projectId_fkey";

-- DropForeignKey
ALTER TABLE "release_notification_send" DROP CONSTRAINT "release_notification_send_userId_fkey";

-- DropForeignKey
ALTER TABLE "release_notification_send" DROP CONSTRAINT "release_notification_send_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "release_notification_delivery" DROP CONSTRAINT "release_notification_delivery_sendId_fkey";

-- DropForeignKey
ALTER TABLE "release_notification_delivery" DROP CONSTRAINT "release_notification_delivery_webhookId_fkey";

-- DropForeignKey
ALTER TABLE "release_notification_delivery" DROP CONSTRAINT "release_notification_delivery_projectId_fkey";

-- DropForeignKey
ALTER TABLE "release_notification_delivery" DROP CONSTRAINT "release_notification_delivery_userId_fkey";

-- DropForeignKey
ALTER TABLE "release_notification_delivery" DROP CONSTRAINT "release_notification_delivery_organizationId_fkey";

-- DropTable
DROP TABLE "release_notification_settings";

-- DropTable
DROP TABLE "release_notification_webhook";

-- DropTable
DROP TABLE "release_notification_send";

-- DropTable
DROP TABLE "release_notification_delivery";

