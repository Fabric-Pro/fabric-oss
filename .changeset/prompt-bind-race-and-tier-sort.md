---
"fabric-app": patch
---

Recover a lost prompt-bind race in a fresh transaction, and rank the picker's default by the binding's tier

A second independent review of the previous prompt-tier fix found two defects in
that fix itself. Both are reproduced below.

**The P2002 recovery could never have worked.** The previous change caught the
unique violation and then re-read and updated on the *same* transaction client.
Postgres marks a transaction aborted the moment a statement in it errors — every
later command returns `25P02 current transaction is aborted, commands ignored
until end of transaction block` — so the recovery raised a second, stranger error
instead of adopting the winner's row, and the demote that transaction had already
performed was rolled back with it. Verified on PostgreSQL 17.10: the read placed
after a unique violation inside one transaction returns exactly that error. The
retry is now a fresh transaction, which re-demotes and then finds the winner's
row on its read. The mock-based test could not see this, so it now asserts a
second transaction is opened.

**The picker ranked by the wrong field.** The tie-break added for the PROJECT
tier guarded on `a.scope === b.scope`, but `scope` on that mapped object is the
bound *prompt's* catalog scope, not the binding's tier — a project-tier binding
can point at a SYSTEM prompt, in which case the guard is false exactly when it
needs to fire and the org-wide row was badged Default instead. Ranking now goes
through the `effectiveTier`/`SCOPE_RANK` helper the other readers already share,
applied to the bindings before they are mapped. The `projectId` field added to
that response last time is withdrawn: it existed only to feed the broken sort.

**The unique key is now pinned in CI.** The previous change proved the NULL
semantics by hand and left nothing in the repo, so the claim rested on the
author's word. A real-Postgres integration test now inserts the duplicate row
shapes directly and asserts the constraint refuses each, while the tiers still
coexist. Against the pre-migration index three of its four cases fail.

**Two corrections to what the last change claimed.** Its commit message said the
project-belongs-to-organization check "existed three times over" — it existed
twice; the third procedure had no check because it took no project at all. And
the migration comment justifies a blocking index build by calling the table
small, which is a claim about shape (one row per action per tier owner, growing
with projects and users rather than per event) that was asserted rather than
measured. The migration has since applied to staging without incident. Both are
left as written because editing an applied migration changes its checksum and
would fail the next `migrate deploy`.
