---
"fabric-app": patch
---

Run @repo/temporal's real-Postgres test files one at a time so the publishing drain and redrive suites stop failing each other in CI (Fizzy #2382)

The non-required `Temporal publishing tests (real Postgres)` job failed three times on 2026-09-03 on PRs that touched nothing near publishing. db-integration.yml runs `publishing-reconcile-activity`, `redrive-publishing-notification` and `publishing-drain-activity` in one vitest invocation, and `packages/temporal/vitest.config.ts` ran test files in parallel workers against the one shared database.

The drain activity pages every DEFERRED email row in the table, which is what production does, so the two suites collide in both directions: the drain test's mocked `sendEmail` marks the redrive test's freshly seeded DEFERRED row SENT and the redrive script's duplicate guard exits 0 instead of 1; or the redrive row lands inside the drain test's "EXACTLY full backlog" and `moreWorkRemains` flips to true.

Reproduced against a throwaway Postgres 17: the CI invocation with the old config failed the redrive case 3 runs out of 3; with `fileParallelism: !runDbIntegration` it passed 26/26 in 3 runs out of 3. This mirrors the gate `packages/database/vitest.config.ts` already carries and for the same reason: the collision is a property of sharing a database, not of these files, so it lives in the config rather than as a `--no-file-parallelism` flag one CI step could forget. The default unit run never sets RUN_DB_INTEGRATION and keeps full file parallelism. Cost: the three-file step went from ~20 s to ~40 s on an idle machine.
