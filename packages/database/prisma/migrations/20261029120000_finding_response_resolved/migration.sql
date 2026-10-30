-- A finding answered by applying its recommendation to its section (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "ProjectDocumentFindingResponseKind" ADD VALUE IF NOT EXISTS 'RESOLVED';
