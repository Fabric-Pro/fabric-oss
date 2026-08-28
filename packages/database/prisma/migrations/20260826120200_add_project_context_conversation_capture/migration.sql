-- The two tables conversation capture writes to (Fizzy #2228).
--
-- A linked Teams or Slack channel's project_context row is a POINTER: it stores
-- a cursor and dedup markers, never the messages. So a monitored channel
-- exported as "Content unavailable" and the assistant could not cite it, while
-- a code comment claimed the opposite. project_context_conversation_bundle is
-- where an analyzed bundle now actually lands — durable, individually embedded,
-- and exportable like any other content.
--
-- project_context_conversation_claim is what makes that capture idempotent by
-- construction rather than by retry logic. A bundle is written over exactly the
-- messages whose claim rows the same transaction managed to INSERT, so a repeat
-- or concurrent write of a message loses the uniqueness race and contributes
-- nothing instead of duplicating, and two workers racing one thread produce
-- disjoint bundles regardless of what each fetched. Claim and bundle share a
-- transaction: claims committing without their bundle would leave a retry with
-- an empty claim set and no row to attach to, losing the messages permanently.
--
-- # Why the constraints below are shaped the way they are
--
-- Both tables carry the same tenant columns, the same XOR CHECK and the same
-- owner-inclusive composite foreign key. That is not symmetry for its own sake.
-- The claim table holds tenant-associated provider message identifiers and it
-- GATES whether a message can ever be captured — an unprivileged cross-tenant
-- write there could suppress capture through a uniqueness conflict without ever
-- touching content. It needs the same floor as the table holding the text.
--
-- The composite foreign key against project_context (id, projectId, ownerKey)
-- is the point of the pair of migrations preceding this one; see
-- 20260826120000 for why an owner-blind key is not enough and why the owner
-- identity has to be a generated column. MATCH FULL rather than the default
-- MATCH SIMPLE so the check does not depend on the CHECK constraint holding:
-- under MATCH SIMPLE a NULL ownerKey would satisfy the key trivially, which is
-- exactly the failure mode this whole design exists to remove.
--
-- ON UPDATE NO ACTION, not CASCADE: ownerKey is a generated column and cannot
-- be assigned by a cascade. A parent changing tenant while it still has
-- captured children is therefore refused rather than silently carrying the
-- content across the isolation boundary — the right answer either way.
--
-- The composite foreign keys and the CHECK constraints are NOT expressible in
-- schema.prisma and are declared only here. Modelling the composite key as a
-- Prisma relation would put the generated ownerKey into every INSERT, which
-- Postgres rejects. A shadow-database diff cannot see them in the schema file
-- and may read the foreign keys as drift and try to DROP them; they are not
-- drift. Both are documented on the models in schema.prisma, the same way the
-- partial index on project_readiness_item_state is.
--
-- Every index, constraint and key below lands on a table this migration
-- CREATEs, so all of it is on an empty relation and takes no lock anybody else
-- can see.

-- CreateTable
CREATE TABLE "project_context_conversation_bundle" (
    "id" TEXT NOT NULL,
    "parentContextId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "providerThreadId" TEXT,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "bundleStartedAt" TIMESTAMP(3) NOT NULL,
    "bundleEndedAt" TIMESTAMP(3),
    "qdrantId" TEXT,
    -- Claimed by compare-and-set before embedding starts. `embeddedAt` is NEVER
    -- the claim: a crash between claiming and the vector write would leave it
    -- non-null with no vector, and the recovery pass — which looks for a null
    -- `embeddedAt` and no live lease — would skip that row forever.
    "embeddingLeaseAt" TIMESTAMP(3),
    "embeddedAt" TIMESTAMP(3),
    "extractionStatus" "ExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "extractionError" TEXT,
    "userId" TEXT,
    "organizationId" TEXT,
    "ownerKey" TEXT GENERATED ALWAYS AS (COALESCE("organizationId", "userId")) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_context_conversation_bundle_pkey" PRIMARY KEY ("id"),
    -- Exactly one tenant column. The generated column above depends on it:
    -- COALESCE over two NULLs is NULL, and a row naming both owners would
    -- silently resolve to the organization.
    CONSTRAINT "project_context_conversation_bundle_tenant_xor"
      CHECK (("userId" IS NULL) <> ("organizationId" IS NULL))
);

-- CreateTable
CREATE TABLE "project_context_conversation_claim" (
    "id" TEXT NOT NULL,
    "parentContextId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "providerThreadId" TEXT,
    "messageCreatedAt" TIMESTAMP(3),
    -- NULL only inside the claiming transaction, before the bundle row exists.
    "bundleId" TEXT,
    "userId" TEXT,
    "organizationId" TEXT,
    "ownerKey" TEXT GENERATED ALWAYS AS (COALESCE("organizationId", "userId")) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_context_conversation_claim_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_context_conversation_claim_tenant_xor"
      CHECK (("userId" IS NULL) <> ("organizationId" IS NULL))
);

-- CreateIndex
-- The claim itself: one row per provider message per monitored context. This is
-- what a second writer loses on, and losing is how capture stays idempotent.
CREATE UNIQUE INDEX "project_context_conversation_claim_message_key" ON "project_context_conversation_claim"("parentContextId", "providerMessageId");

-- CreateIndex
CREATE INDEX "project_context_conversation_bundle_parentContextId_idx" ON "project_context_conversation_bundle"("parentContextId");

-- CreateIndex
CREATE INDEX "project_context_conversation_bundle_projectId_idx" ON "project_context_conversation_bundle"("projectId");

-- CreateIndex
CREATE INDEX "project_context_conversation_bundle_qdrantId_idx" ON "project_context_conversation_bundle"("qdrantId");

-- CreateIndex
CREATE INDEX "project_context_conversation_bundle_extractionStatus_idx" ON "project_context_conversation_bundle"("extractionStatus");

-- CreateIndex
CREATE INDEX "project_context_conversation_bundle_userId_idx" ON "project_context_conversation_bundle"("userId");

-- CreateIndex
CREATE INDEX "project_context_conversation_bundle_organizationId_idx" ON "project_context_conversation_bundle"("organizationId");

-- CreateIndex
-- Chronological read-back for one channel, and the coverage window an export
-- states.
CREATE INDEX "project_context_conversation_bundle_parent_started_idx" ON "project_context_conversation_bundle"("parentContextId", "bundleStartedAt");

-- CreateIndex
-- The recovery sweep's predicate: null embeddedAt with no live lease.
CREATE INDEX "project_context_conversation_bundle_embed_sweep_idx" ON "project_context_conversation_bundle"("embeddedAt", "embeddingLeaseAt");

-- CreateIndex
CREATE INDEX "project_context_conversation_claim_parentContextId_idx" ON "project_context_conversation_claim"("parentContextId");

-- CreateIndex
CREATE INDEX "project_context_conversation_claim_projectId_idx" ON "project_context_conversation_claim"("projectId");

-- CreateIndex
CREATE INDEX "project_context_conversation_claim_bundleId_idx" ON "project_context_conversation_claim"("bundleId");

-- CreateIndex
CREATE INDEX "project_context_conversation_claim_userId_idx" ON "project_context_conversation_claim"("userId");

-- CreateIndex
CREATE INDEX "project_context_conversation_claim_organizationId_idx" ON "project_context_conversation_claim"("organizationId");

-- AddForeignKey
ALTER TABLE "project_context_conversation_bundle" ADD CONSTRAINT "project_context_conversation_bundle_parentContextId_fkey" FOREIGN KEY ("parentContextId") REFERENCES "project_context"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- The one that actually holds tenancy together. Read the header.
ALTER TABLE "project_context_conversation_bundle" ADD CONSTRAINT "project_context_conversation_bundle_owner_fkey" FOREIGN KEY ("parentContextId", "projectId", "ownerKey") REFERENCES "project_context"("id", "projectId", "ownerKey") MATCH FULL ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "project_context_conversation_bundle" ADD CONSTRAINT "project_context_conversation_bundle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_conversation_bundle" ADD CONSTRAINT "project_context_conversation_bundle_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_conversation_claim" ADD CONSTRAINT "project_context_conversation_claim_parentContextId_fkey" FOREIGN KEY ("parentContextId") REFERENCES "project_context"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_conversation_claim" ADD CONSTRAINT "project_context_conversation_claim_owner_fkey" FOREIGN KEY ("parentContextId", "projectId", "ownerKey") REFERENCES "project_context"("id", "projectId", "ownerKey") MATCH FULL ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "project_context_conversation_claim" ADD CONSTRAINT "project_context_conversation_claim_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "project_context_conversation_bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_conversation_claim" ADD CONSTRAINT "project_context_conversation_claim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_conversation_claim" ADD CONSTRAINT "project_context_conversation_claim_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
