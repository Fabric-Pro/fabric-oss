import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		globals: true,
		include: [
			"__tests__/**/*.test.ts",
			"src/**/__tests__/**/*.test.ts",
			// Co-located newsletter unit tests sit next to the source they
			// exercise rather than in a __tests__/ folder. Scoped to the
			// newsletter directories so the broad glob does not sweep in
			// pre-existing non-vitest scripts (e.g. the tsx-run
			// verify-operation.test.ts) that the narrow globs deliberately skip.
			"src/activities/newsletter/**/*.test.ts",
			"src/workflows/newsletter-release-split.test.ts",
			"src/workflows/newsletter-release-select.test.ts",
		],
		exclude: ["**/node_modules/**", "**/dist/**"],
		// Cold-cache TS transform of the workflows barrel and its dep graph is
		// slow on the first import. Vitest 4's module runner (which replaced
		// vite-node) transforms it more slowly than v3 — heavy-import tests were
		// observed tipping just past the old 5s default (5012ms). 20s gives
		// headroom without letting truly hung tests block CI.
		testTimeout: 20000,
		// Force vitest to exit even if open handles remain — see
		// vitest.global-teardown.ts. Without this, the main vitest
		// process hangs 2-5 min between turbo packages because tests
		// transitively load @repo/database (PrismaPg pool) and other
		// connection-holding modules.
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
		// parallelism AND no transform reuse. On a 30-file subset that showed
		// as 30.2s of import against 0.49s of actual test execution.
		//
		// Measured: this does NOT reliably shorten CI. On the 8-core runner
		// three heavy packages run concurrently under `turbo --concurrency=4`,
		// so the suite is bound by aggregate CPU — the cores freed here go to
		// apps/web, which sets no cap and rose from ~314s to ~484s while this
		// suite fell from ~558s to ~402s. Across three full uncached runs a
		// side the step mean moved 645s -> 617s on ranges that overlap almost
		// entirely, which is noise: treat CI wall clock as unchanged.
		// The dependable gain is local, where one package runs at a time.
		// Shortening CI needs more cores (sharding the job), not a different
		// worker count here.
		//
		// A percentage rather than a fixed count so this scales with whatever
		// it runs on — CI's 8-core runner resolves it to 4, a 2-core box to 1,
		// a dev machine to half its cores. A hard-coded number tuned for CI
		// would oversubscribe the small runners and starve the large ones.
		// Full suite: >600s at one worker (killed at a 10-minute cap) against
		// 91s at 10, with 491 files / 5575 tests passing either way.
		//
		// Leave `isolate` at its default (true). Do NOT set isolate:false —
		// measured directly, it fails 8 files / 69 tests in this suite.
		maxWorkers: "50%",
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: ["node_modules/", "**/*.config.*", "coverage/"],
		},
		env: {
			// Set DATABASE_URL for tests that import database client.
			//
			// Deferring to an inherited value matters for the RUN_DB_INTEGRATION
			// tests (#2105): `test.env` overrides the real process env, so
			// hardcoding this unconditionally pointed every DB-backed run at a
			// database that does not exist, and the placeholder won even when the
			// caller had explicitly supplied a live URL. Unit runs set nothing and
			// still get the placeholder, exactly as before.
			DATABASE_URL:
				process.env.DATABASE_URL ??
				"postgresql://test:test@localhost:5432/test",
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
});
