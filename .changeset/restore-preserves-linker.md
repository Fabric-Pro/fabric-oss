---
"fabric-app": patch
---

Keep who linked a meeting when it is restored from the recovery archive, instead of silently clearing it.

On a linked meeting the `userId` column records who linked it — linking writes the caller's id there for organization projects too, since the table's RLS is user-owned and an organization row carries both columns. Restore rebuilt the row through the tenant expression instead, which resolves to null for any organization project, so every restored meeting came back with its linker erased. The archive did not capture the field either, so the information was gone in both directions.

Nothing reads that column yet, which is precisely why this could rot unnoticed — and it is the attribution that per-linker meeting syncing would depend on. Archives written before this change do not carry the field; a restore from one of those keeps the previous behaviour rather than inventing an owner.
