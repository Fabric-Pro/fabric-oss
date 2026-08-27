---
"fabric-app": patch
---

Stop the scan-procedures suite failing intermittently in CI by paying its module transform once instead of inside a test's timeout.

Fabric item 897. `scan-procedures.test.ts` loads each procedure with `await import(...)` inside the test body, so whichever test reaches a handler module first pays that module's cold transform against its own `testTimeout`. The dep graph behind these handlers is the expensive one `packages/api/vitest.config.ts` already warns about — Prisma client, ai-sdk, `@repo/temporal`, and slower to transform under Vitest 4's module runner than under v3, with heavy-import tests previously observed at 10009ms against the old 10s ceiling.

Measured in this file: the test that times out in CI runs 4077ms locally, against 5-19ms for every other test in it. Those four seconds are the import, not anything the test asserts, which is why the failure tracked machine load rather than the code under test.

That also explains the second failure it always dragged with it. Vitest fails a test at the timeout but cannot cancel its promise, so the abandoned continuation drains the three `mockResolvedValueOnce` values queued by "applies the patch to each id" into whichever test is running when it lands — and the next one, asserting a single call, saw four. One timeout, two failures, and the visible one named a mock count rather than the import that actually broke.

The seven handler modules are now imported once at the top level of the file, before any test runs. Deliberately top level and not a `beforeAll`: a hook is governed by `hookTimeout`, which this package never sets and which therefore defaults to 10s — half the budget the import was already exceeding — so a hook would have failed sooner than the bug it replaced. Both numbers were measured rather than assumed: a `beforeAll` sleeping 30s reports "Hook timed out in 10000ms", while a 15s top-level await completes, because collection is bound by neither budget. `vi.mock` calls are hoisted above the warm-up, so mocks are registered before it evaluates, and isolation is unchanged: `vi.resetModules()` still hands each test a fresh module instance, because it resets the module registry and not Vite's transform cache. The offending test goes from 4077ms to 5ms and is now the slowest in the file; 28/28 pass across three consecutive runs, and the full `@repo/api` suite passes at 529 files / 5407 tests. No assertion was weakened and no timeout was raised — both would have hidden the leak rather than removed it.

Two things this does not do. It removes the trigger, not the underlying vitest behaviour: any test that times out mid-flight can still leak an abandoned continuation into the next one, which is a property of the runner rather than of this file. And it is a same-shape risk anywhere else a suite imports inside the test body rather than in a hook.
