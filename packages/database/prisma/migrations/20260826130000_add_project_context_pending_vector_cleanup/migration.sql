-- Where the ids of already-deleted rows wait for their vectors (Fizzy #2228).
--
-- Unlinking a monitored channel deletes the pointer project_context row and the
-- conversation bundles that cascade from it BEFORE it deletes their vectors.
-- That ordering is deliberate and must not be reversed: row absence is the
-- state a concurrent embedder reads to decide whether to abandon its write or
-- compensate for it (see 20260826120200 and capture-conversation-bundle.ts).
--
-- Its cost is a window in which the ids exist only in one call's memory. A
-- vector-store failure inside that window stranded the points where no retry
-- could reach them: the retry found no context row, took the "nothing to
-- delete" path, and reported SUCCESS while the conversation text stayed
-- indexed. The Qdrant payload carries the message text, so the user was told
-- their conversations were removed from a third-party store that still held
-- them.
--
-- This table makes the IDS survive instead of reordering the deletes. A row is
-- written in the SAME transaction as the project_context delete, so the ids can
-- never be lost with the rows, and it is removed only once the vector store has
-- confirmed. Both a retried unlink and the scheduled recovery sweep drain it.
--
-- # Why it is not a child of project_context
--
-- Because outliving those rows is the entire point. A foreign key to
-- project_context would cascade this record away at exactly the moment it
-- becomes necessary. It hangs off the PROJECT instead — which is also the scope
-- an unlink drains by, and a project whose row is gone has had its whole
-- collection purged by project deletion, so cascading with the project strands
-- nothing.
--
-- # contextIds is an array, not a child table
--
-- The list is written once and read once, never joined, never filtered on, and
-- bounded by one channel's bundle count. A second table would add a second
-- write to the transaction that must not fail and buy nothing.
--
-- # The XOR CHECK, and no ownerKey
--
-- The same tenant XOR the two capture tables carry, and for the same reason:
-- exactly one owner, so a record can never name two and quietly resolve to one.
-- The organizationId is not only tenancy here — it DECIDES WHICH COLLECTION the
-- stranded points are in, so a drain reads it off the record rather than from
-- an ambient value.
--
-- There is deliberately NO generated ownerKey column. That column exists on the
-- capture tables to make an owner-inclusive composite foreign key possible;
-- this table references no project_context row, so there is nothing to compare
-- an owner against and the column would be decoration.
--
-- The CHECK is not expressible in schema.prisma and is declared only here. A
-- shadow-database diff cannot see it in the schema file; it is not drift. It is
-- documented on the model, the same way the capture tables' constraints are.
--
-- Every index and constraint below lands on the table this migration CREATEs,
-- so all of it is on an empty relation. The three foreign keys take a brief
-- SHARE ROW EXCLUSIVE on the referenced tables, hence the lock_timeout: per the
-- convention in this directory it comes FIRST, because a timeout set after the
-- statement that takes the lock guards nothing (see
-- 20260815120300_publishing_cycle_notification_outcome_at, whose header records
-- that mistake shipping once).
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "project_context_pending_vector_cleanup" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contextIds" TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_context_pending_vector_cleanup_pkey" PRIMARY KEY ("id"),
    -- Exactly one tenant column, like both capture tables.
    CONSTRAINT "project_context_pending_vector_cleanup_tenant_xor"
      CHECK (("userId" IS NULL) <> ("organizationId" IS NULL))
);

-- CreateIndex
CREATE INDEX "project_context_pending_vector_cleanup_projectId_idx" ON "project_context_pending_vector_cleanup"("projectId");

-- CreateIndex
CREATE INDEX "project_context_pending_vector_cleanup_userId_idx" ON "project_context_pending_vector_cleanup"("userId");

-- CreateIndex
CREATE INDEX "project_context_pending_vector_cleanup_organizationId_idx" ON "project_context_pending_vector_cleanup"("organizationId");

-- CreateIndex
-- The sweep's queue order: fewest failures first, oldest first within that, so
-- one record the vector store keeps refusing cannot sit at the head of every
-- bounded batch and starve the rest.
CREATE INDEX "project_context_pending_vector_cleanup_queue_idx" ON "project_context_pending_vector_cleanup"("attempts", "createdAt");

-- AddForeignKey
ALTER TABLE "project_context_pending_vector_cleanup" ADD CONSTRAINT "project_context_pending_vector_cleanup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_pending_vector_cleanup" ADD CONSTRAINT "project_context_pending_vector_cleanup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_context_pending_vector_cleanup" ADD CONSTRAINT "project_context_pending_vector_cleanup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
