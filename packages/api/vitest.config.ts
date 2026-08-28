import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// The QA feature is env-flag-gated: every test-cases/test-plans
		// procedure calls `assertTestCasesFeatureEnabled()`, which throws NOT_FOUND
		// unless this is exactly "true". Enable it for the suite so those procedure
		// tests exercise their real logic instead of the gate. The gate itself is
		// covered by `modules/projects/lib/__tests__/test-cases-feature.test.ts`.
		env: {
			FABRIC_FEATURE_TEST_CASES: "true",
			// Living Documents auto-refresh is env-flag-gated the same way: the
			// enrollment procedures throw NOT_FOUND unless this is exactly "true".
			// Enable it so those procedure tests exercise real logic instead of the
			// gate; the gate itself is covered in `packages/utils`.
			FABRIC_FEATURE_LIVING_DOCS_REFRESH: "true",
		},
		include: [
			"modules/**/__tests__/**/*.test.ts",
			"lib/__tests__/**/*.test.ts",
			"orpc/**/__tests__/**/*.test.ts",
			"__tests__/**/*.test.ts",
		],
		// Cold-cache TS transform of this package's dep graph (Prisma client,
		// ai-sdk, @repo/temporal, etc.) is slow on the first import. Vitest 4's
		// module runner (which replaced vite-node) transforms this graph more
		// slowly than v3 under full-suite singleFork load — heavy-import
		// integration tests were observed tipping just past the old 10s ceiling
		// (10009ms). 20s gives headroom without letting truly hung tests block CI.
		testTimeout: 20000,
		// The same cold-import cost lands in HOOKS, which kept vitest's 10s
		// default while the ceiling above was raised: a `beforeEach` that awaits
		// `import("@repo/database")` pays the identical transform. Observed in
		// lib/__tests__/subscription-fanout.test.ts — "Hook timed out in
		// 10000ms", then `db.subscription.findMany.mockReset is not a function`
		// because the timed-out hook never finished wiring the mock. The file
		// passes in ~11.3s when it completes, so it sits just OVER the hook
		// ceiling and just under the test one. Turbo hid this: a warm cache
		// replays the previous log, so the suite reports green without running.
		// It surfaces on any cold run — notably the OSS publication tree, which
		// has no cache to hit.
		hookTimeout: 20000,
		// Force vitest to exit even if open handles remain — see
		// vitest.global-teardown.ts. Without this, the main vitest
		// process hangs 2-5 min between turbo packages because tests
		// transitively load @repo/database (PrismaPg pool) etc.
		globalSetup: ["./vitest.global-teardown.ts"],
		// Use forks pool so test workers are real child processes vitest
		// can SIGKILL on close. The default `threads` pool keeps workers
		// alive when worker_threads hold open handles (vitest #3077,
		// #3909) and the parent process can't return.
		pool: "forks",
		// Vitest 4 removed `poolOptions`. `forks.singleFork: true` was ported
		// here as `maxWorkers: 1`, but the two are not equivalent: singleFork
		// reused ONE warm fork, whereas `maxWorkers: 1` with `isolate` at its
		// default spawns a fresh fork per file and runs them serially — no
		// parallelism AND no transform reuse. The cost was visible in CI as
		// import time dwarfing test time (341s import vs 72s tests), and this
		// suite pinned to one core of an 8-core runner while apps/web, which
		// sets no worker cap, cleared 55% more files in half the wall time.
		//
		// Measured: this does NOT reliably shorten CI — see the note in
		// packages/temporal/vitest.config.ts. The runner is bound by
		// aggregate CPU, so the cores freed here go to apps/web. This suite
		// fell from ~513s to ~421s across three full uncached runs a side
		// while the step as a whole stayed flat. The dependable gain is local.
		//
		// A percentage rather than a fixed count so this scales with whatever
		// it runs on — CI's 8-core runner resolves it to 4, a 2-core box to 1,
		// a dev machine to half its cores. A hard-coded number tuned for CI
		// would oversubscribe the small runners and starve the large ones.
		// Full suite: 491s on CI at one worker against 94s at 10, with
		// 493 files / 4963 tests passing.
		//
		// Leave `isolate` at its default (true). Do NOT set isolate:false —
		// measured directly, it fails 8 files / 69 tests in this suite.
		maxWorkers: "50%",
	},
});
