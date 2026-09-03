-- CreateTable
CREATE TABLE "retired_prompt_key" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredBy" TEXT NOT NULL,

    CONSTRAINT "retired_prompt_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "retired_prompt_key_key_key" ON "retired_prompt_key"("key");
