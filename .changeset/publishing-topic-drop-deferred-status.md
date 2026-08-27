---
"fabric-app": patch
---

Remove the retired Deferred status from the publishing topic type, completing the move to the snooze overlay

Publishing Suite 1D-1b (Fizzy #2265) — the contract half of the expand/contract
pair whose expand half shipped in 1D-1.

1D-1 replaced the DEFERRED status with a snooze overlay (snoozedUntil /
snoozeReason on PublishingTopic), because a status cannot carry a snooze
without destroying the status the topic already had — which is the state FR8
routes by. It moved every existing DEFERRED topic to SUGGESTION but left the
enum VALUE in place on purpose: removing a label from a Postgres enum rebuilds
the type and rewrites every column of it, which would have broken any app
instance still running the previous version mid-deploy.

That release reached production on 2026-08-25, so this drops the value. Nothing
user-visible changes: the status procedure's input enum has listed the five
live statuses since 1D-1, and no path in packages/, apps/ or agents/ names
PublishingTopicStatus.DEFERRED outside generated output.

**The migration re-drains the value, takes the table lock explicitly before
doing so, and turns row security off for the duration.** Each of those three
lines exists because a review round found the version without it broken, and
each was reproduced rather than argued.

The drain is there because the expand release's backfill does not prove the
column is empty: it committed while instances on the previous release were
still up and still able to write the value — the pre-expand revision of the
status procedure does list six — so a row from that rolling window survives
with nothing to drain it, and would abort the deploy.

The explicit `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` is there because a
transaction boundary does not close that window; only the lock does. An UPDATE
takes ROW EXCLUSIVE, which excludes no other writer, so a concurrent INSERT of
a DEFERRED row lands between the drain and the swap and the USING cast then
aborts with 22P02 — staged with a real second session, that is exactly what
happens. Taking the lock first also removes a lock upgrade that the drain would
otherwise introduce, one a concurrent reader can turn into a deadlock the
migration itself loses at deadlock_timeout, where lock_timeout never gets a say.

`SET LOCAL row_security = off` is there because publishing_topic is FORCE ROW
LEVEL SECURITY and tenant_isolation falls through to `ELSE false` without tenant
context. A connection role without bypassrls gets `UPDATE 0` from the drain —
no error, nothing drained — while the DDL that follows is not RLS-filtered, sees
every row and aborts anyway. Verified both ways. The setting is a no-op for a
bypassing role and raises immediately, before any lock, for one that cannot, so
the migration no longer depends silently on which role carries DATABASE_URL.

**Both timeout bounds are set in the migration**, per
`20260820120000_validate_publishing_notification_delivery_leased_channel`:
promote runs three separate processes and a session GUC dies with its
connection, so preflight's bounds never reach this ALTER. `lock_timeout` bounds
the wait to acquire; `statement_timeout` bounds the rewrite, per statement.

**Measured on a production-shaped database**, after two earlier measurements
that were not: apply-rls-direct applied first so FORCE RLS and its policy are
live, then 500,000 topics with real-length text at 439 bytes a row and a 217 MB
heap, 501 of them stray DEFERRED. The whole deploy takes 3.4 seconds, drains
every stray row, rebuilds five indexes and restores the DEFAULT. It is still
local hardware and still an idle database, and the comment says so — an idle
database cannot measure the one thing that decides this migration's fate, which
is whether the lock can be acquired against live traffic.

Recovery is described honestly: a bound firing rolls back cleanly but leaves an
unresolved `_prisma_migrations` row, which blocks the next promotion of anything
— via preflight's ledger check on the promote path, via Prisma's own P3009 on
the Helm path — until a human runs `prisma migrate resolve` with the argument
chosen from `docs/database-promotion.md` rather than guessed.

Two cases pin this in `publishing-suite-schema.test.ts`. The first reads the
enum labels from the catalog, joining from the COLUMN outwards (pg_attribute to
atttypid to pg_enum) rather than matching a type by name, because a five-label
type that nothing uses is exactly what a half-applied rebuild leaves behind. The
second pins the restored column DEFAULT, which is the second dependent the
migration's header calls load-bearing and which nothing else in the repository
could see: dropped, every other gate stays green. Both were observed failing
before being trusted.
