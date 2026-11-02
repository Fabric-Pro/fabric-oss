-- CreateEnum
CREATE TYPE "ChatMediaKind" AS ENUM ('UPLOADED_IMAGE', 'GENERATED_IMAGE', 'TTS_AUDIO');

-- CreateTable
CREATE TABLE "chat_media_object" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "kind" "ChatMediaKind" NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "conversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_media_object_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_media_settings" (
    "id" TEXT NOT NULL,
    "legacyCutoffAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_media_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_media_object_storageKey_key" ON "chat_media_object"("storageKey");

-- CreateIndex
CREATE INDEX "chat_media_object_userId_idx" ON "chat_media_object"("userId");

-- CreateIndex
CREATE INDEX "chat_media_object_organizationId_idx" ON "chat_media_object"("organizationId");

-- CreateIndex
CREATE INDEX "chat_media_object_conversationId_idx" ON "chat_media_object"("conversationId");

-- AddForeignKey
ALTER TABLE "chat_media_object" ADD CONSTRAINT "chat_media_object_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_media_object" ADD CONSTRAINT "chat_media_object_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_media_object" ADD CONSTRAINT "chat_media_object_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the environment-relative drain window for old workers still writing
-- unrecorded objects while the new application version rolls out.
INSERT INTO "chat_media_settings" ("id", "legacyCutoffAt")
VALUES ('default', (now() AT TIME ZONE 'UTC') + interval '1 day');
