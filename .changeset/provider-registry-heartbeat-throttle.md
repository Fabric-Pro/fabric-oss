---
"fabric-app": patch
---

Stop rewriting the integration provider registry on every API boot and every monitoring poll.

The `integration_provider_registry` table (33 rows) was being rewritten at roughly 19 UPDATEs
per minute on an environment with no users at all. Two writers were responsible.

**Boot sync.** `syncIntegrationProviderRegistry` issued a Prisma `upsert` per registered
provider, and an upsert against an existing row always issues an UPDATE — bumping `updatedAt`
even when every synced column already held the value being written. The web app runs
serverless, so each cold start replayed the whole registry; staging recorded four boot syncs
in six minutes, each rewriting all 33 rows. The sync now reads the synced columns once and
writes only the rows that differ, so a steady-state boot costs one SELECT and no writes. It
returns a `{ created, updated, skipped, failed }` breakdown instead of a bare count. If that
read fails the database is unreachable, so the sync logs once, counts every registration as
failed, attempts no writes, and lets the next boot reconcile — as it already did for a failed
boot sync.

**Monitoring activities.** Five write sites across `markProviderNotConfigured`,
`upsertIntegrationIncident` and `closeIntegrationIncident` rewrote the row on every call,
unconditionally, largely to move `lastPolledAt` forward — and wrote `currentHealth` and
`lastIncidentId` whether or not they had changed. They now go through one internal
`touchProviderRegistry` helper (deliberately not exported from the activities barrel, since
every export there becomes a schedulable activity) that writes only when a value actually
changed, or when the stored heartbeat is older than a 3-minute floor.

Three minutes is chosen against the two real cadences: a healthy provider gets a stamp
opportunity every ~4 minutes (2-minute poll, cleared by the 2-poll operational hysteresis) and
a provider with an open incident every 2 minutes. Both land at ~4 minutes of worst-case
staleness, well under the 10-minute "background processing degraded" threshold that
`getLastBackgroundWorkAt()` feeds — still at least two missed heartbeats away.

One test contract changed deliberately: `markProviderNotConfigured` no longer refreshes
`lastPolledAt` on *every* call, only once the stored timestamp is older than the heartbeat
interval. Its `updated` flag still means "transitioned into NOT_CONFIGURED", unchanged. The
admin "Last poll" tooltip copy now says the timestamp is refreshed a few minutes at a time.

Fizzy #2438
