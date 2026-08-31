---
"fabric-app": patch
---

Add the personal-context surface map: what must exist in an organization before personal context can be removed

Fizzy #1875 blocks progress until every surface that exists only in personal workspace context carries an approved disposition. The audit produced that inventory, and its findings led the product owner to rule against migrating the data at all: the work is preserving the functionality, not moving anyone's rows.

Why migrating was declined — each of these is recorded with its evidence. The strict-isolation tenancy class filters organization context on an empty user column, so a migrated row would have matched neither branch and billing records would have become invisible. The audit-log table is append-only under a trigger that binds even the table owner and permits exactly one mutation, the opposite of the one a migration needs; the single precedent required a per-run product-owner authorisation and refused a standing bypass. Eighty-six models would have lost their per-user predicate, becoming readable to every member on the first invitation with no second decision in between. A restorable ninety-day archive is new capability rather than reuse — the existing retention precedent ends in irreversible deletion and no restore has ever been tested. And tenancy is also encoded outside the database, in object-storage keys and in physically separate vector-store collections, so rows would have moved while files and embeddings stayed behind.

Two corrections to the ticket. Notification settings, its own worked example, need nothing done — both preference tables are already account-global and no caller populates their organization column; two tables it does not mention do carry personal state. And its acceptance criteria do not reach every entry point it affects: the versioned REST query flag and the command-line context selector are governed by none of them.

Dispositions distinguish a code path that must stop resolving to personal from data that stays where it is. Under the ruling the data is left in place and becomes unreachable, which the map records as a deliberate deferral with the retention obligation it creates, not as a resolution.

The drift guard checks existence only — that every model, tenancy class and path the map spells out still resolves. Counts move with ordinary feature work and would make the test a chore; the map states each derivation command instead. The repository's other surface map is backed by an equivalent test and is alive, while the one prior tenant-isolation audit had no guard and was deleted rather than revalidated.

Both the map and its plan are held out of the open-source seed by an entry in the export's deletion array, not only by a classification row — they name a cross-tenant isolation defect that is unfixed at the time of writing.
