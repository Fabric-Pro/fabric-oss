-- An Atlas run approved to resume now on API billing, before its resume claims it (own migration: ALTER TYPE ... ADD VALUE).
ALTER TYPE "AtlasRunStatus" ADD VALUE IF NOT EXISTS 'PENDING';
