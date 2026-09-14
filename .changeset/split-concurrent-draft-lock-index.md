---
"fabric-app": patch
---

Split the publishing draft-lock index into its own migration so the concurrent build no longer runs inside a transaction

Fizzy #1851. `20260914090000_publishing_working_draft_advisory_lock` shipped an
`ALTER TABLE ... ADD COLUMN` and a `CREATE INDEX CONCURRENTLY` in one file.
Prisma wraps a multi-statement migration in a transaction and does not wrap a
single-statement one, and `CREATE INDEX CONCURRENTLY` cannot run inside a
transaction, so the migration failed on its first promotion with P3018 wrapping
SQLSTATE 25001 ("CREATE INDEX CONCURRENTLY cannot run inside a transaction
block"). The transaction rolled back whole, so no partial schema was left, but
the attempt stayed mid-flight in `_prisma_migrations` and the promotion
preflight then refused every subsequent deploy until the ledger was resolved by
hand.

The index now lives alone in
`20260914093000_publishing_working_draft_editing_user_index`, which is the shape
the expand/contract rules already required — a concurrent build belongs in a
migration of its own. Both files carry a comment saying so, because the linter
enforces only the `CONCURRENTLY` keyword and cannot see the one-statement rule
that has to hold alongside it.

Editing the original file in place is the sanctioned path here: a two-statement
file containing `CREATE INDEX CONCURRENTLY` fails on every apply path including
`migrate dev`, so it had never applied cleanly in any environment and no stored
checksum can reject the edit.

No schema change: `schema.prisma` already declared both columns and
`@@index([editingUserId])`, and still does.
