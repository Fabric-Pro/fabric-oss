-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationCategory" ADD VALUE 'CONTEXT_INDEXING_STARTED';
ALTER TYPE "NotificationCategory" ADD VALUE 'CONTEXT_INDEXING_COMPLETED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'CONTEXT_INDEXING_STARTED';
ALTER TYPE "NotificationType" ADD VALUE 'CONTEXT_INDEXING_COMPLETED';

-- NOTE: Prisma auto-bundled `CREATE INDEX "mcp_server_default_enabled_idx"` here
-- because the worktree branched from origin/main BEFORE that index was committed
-- in a separate migration. Stripped to avoid the "relation already exists" conflict
-- on a local DB seeded from main. Pure enum-only migration as intended.
