---
"fabric-app": patch
---

Run the root `pnpm test` sweep one turbo task at a time so CPU-bound suites stop timing out from starvation (Fizzy #2411)

Root `pnpm test` ran `turbo test` with no `--concurrency`, so on a many-core machine turbo launched every workspace's vitest task at once (37 tasks on a 32-core box), each of which then spawns its own worker pool sized to the machine (`@repo/web` defaults to cores-1, `@repo/api` and `@repo/temporal` set `maxWorkers: "50%"`). The resulting oversubscription pushed CPU-bound cases in `@repo/rag`, `@repo/api`, `@repo/temporal` and `@repo/web` past per-test ceilings those packages had already raised. Each file passes in isolation and the failing case moves between runs, the signature of starvation rather than a logic defect. Fizzy #2410 had just fixed the same symptom for `packages/auth` by raising its ceiling.

The first candidate was CI's `--concurrency=4` (`.github/workflows/unit-tests.yml`). Measured twice with `--force --continue` on the 32-core box it did not hold: the sweeps took 7m50s and 8m43s, the 1-minute load average peaked at 94, and 35 timeout failures (32 tests, 3 hooks) remained across api, temporal and web, because four concurrent tasks still put about 65 vitest workers on 32 cores. Only the early phase improved: the rag image-downscale case that fails at the default sweep passed.

`--concurrency=1`, measured twice on the same box, removed every timeout at comparable wall time: 8m28s and 8m32s, load peaking at 38, and the three heavy packages ran in 75 s (api), 97 s (temporal) and 127 s (web) instead of 342 s, 258 s and 355 s. Each package now runs under the profile its ceilings were tuned against, the isolated `pnpm --filter <pkg> test`. The heavy suites can saturate the host on their own, which is why serializing them cost so little here; on a smaller machine (8 cores, where api and temporal resolve to 4 workers each) light tasks that could have overlapped cleanly will now queue, so the serialized sweep may be somewhat slower there. Reliability of the sweep as a proof was judged worth that. A cap in `turbo.json` was rejected because it would also throttle `build`; `dev` and `type-check` already set their own concurrency on the script.

Turbo rejects a duplicated `--concurrency`, so `pnpm test --concurrency=N` errors; the override is `pnpm dotenv -e .env.test.local -- turbo test --concurrency=N`, noted in CLAUDE.md.

The only failure left in the serialized sweep is unrelated: `apps/web/__tests__/integration/draft-add-link-roundtrip.test.ts` reads `.handler` off oRPC procedures that expose it under `["~orpc"].handler`, fails in isolation in 9 ms, and runs only when `.env.test.local` provides a database, so CI never executes it. Tracked as Fizzy #2414.
