---
"fabric-app": patch
---

Repair the generated Zod barrel so database schemas import cleanly again.

Internal context (not published):

A recent feature PR committed the raw `prisma generate` output for
`packages/database/prisma/zod/index.ts`, which references `Prisma.Decimal` in
seven `z.instanceof` sites without importing it and emits three BigInt defaults
as strings — every suite that imports the barrel fails at import time with
"ReferenceError: Prisma is not defined" (the second recurrence of this class).
Regenerated through the sanctioned pipeline (`pnpm --filter @repo/database
generate`), whose fix-zod-imports step replaces the instanceof sites with
scalar-safe validators and coerces the BigInt literals; the commit is exactly
the pipeline output.
