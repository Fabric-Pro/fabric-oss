---
"fabric-app": patch
---

Bring the DB-gated wizard draft integration test back in line with the oRPC procedure shape so it runs green again

`apps/web/__tests__/integration/draft-add-link-roundtrip.test.ts` had not executed since the oRPC handler moved: it read each procedure's handler as `.handler`, which is `undefined` under `@orpc/server` 1.x, where the definition lives under the `"~orpc"` key (the shape every other DB-backed test in the repo already reads). All three cases failed with `TypeError: saveDraftHandler is not a function` — only locally, since the suite is gated on a reachable `DATABASE_URL` that the unit-tests CI job never provides. Found while serialising the root sweep (Fizzy #2411 / #2412); tracked as Fizzy #2414.

Running the file for the first time in a long while exposed one more piece of drift: case 12.2 expected `createProject` to return the bare project row, but the procedure returns `{ project, storySyncStarted, migratedContexts }`. The test now unwraps `project` and also asserts the activated status the procedure reports.

No production code changes. The `audit.write_failed` line the test logs is the fire-and-forget `project.created` audit write landing after teardown has already deleted the project; it does not affect the result.
