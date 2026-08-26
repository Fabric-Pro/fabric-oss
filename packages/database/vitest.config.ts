import { defineConfig } from "vitest/config";

// Integration tests that hit a real Postgres (RLS, seeded fixtures, etc.)
// are excluded from the default `test` run because CI does not provide a
// DATABASE_URL. They have dedicated scripts (`test:rls`, etc.) for local
// or integration-CI invocation.
const INTEGRATION_TESTS = [
	"__tests__/authority.test.ts",
	"__tests__/authority-policy.test.ts",
	"__tests__/frames.test.ts",
	"__tests__/frame-sharing.test.ts",
	"__tests__/frame-templates.test.ts",
	"__tests__/project-members-invite.test.ts",
	"__tests__/rls-isolation.test.ts",
	// Monitoring/incident RLS regression (admin_only policy). Requires
	// DATABASE_URL + `apply:rls` to have run. Self-skips via
	// `describe.skipIf` when env is missing, but we exclude here so the
	// default run does not load the suite at all.
	"__tests__/rls/incident-tables.test.ts",
	// Excalidraw default-MCP backfill migration replay.
	// Requires DATABASE_URL to run the migration's data-write steps
	// against a real Postgres. The test's
	// `describe.skipIf(!process.env.DATABASE_URL)` also makes a direct
	// run a no-op if the env is missing, but we exclude here so the
	// default `pnpm --filter @repo/database test` run doesn't load the
	// suite and spin up Prisma.
	"__tests__/migrations/backfill-default-excalidraw.test.ts",
	// Audit-log perf smoke — seeds 5k rows on a live DB and measures
	// query latency. Self-skips when DATABASE_URL is unset (the
	// describe.skipIf guard) but excluded here so the default run
	// does not load the suite and connect to Prisma.
	"__tests__/audit-log-perf-smoke.test.ts",
	// Audit-log sealing DB layer — seals a far-future window, deletes a
	// row via the WORM bypass GUC, and asserts detection + the
	// audit_log_seal append-only trigger. Self-skips without a reachable
	// DATABASE_URL; excluded here so the default run doesn't load it.
	"__tests__/audit-log-seal.integration.test.ts",
];

// Document-Assistant chat-history tests (spec 2026-05-19 §4.1) hit a real
// Postgres but stay *included* in the default suite — they self-skip via
// `describe.skipIf(!hasReachableDatabaseUrl())` (see
// `__tests__/_helpers/db-availability.ts`). That predicate rejects both an
// unset `DATABASE_URL` AND the well-known CI placeholder URL
// (`postgresql://test:test@localhost:5432/test`) that the unit-tests
// workflow exports so the Prisma singleton can initialize. The lazy-client
// proxy in `prisma/client.ts` keeps the import side-effect-free, so the
// suite still loads cleanly on CI even though it short-circuits at the
// describe boundary. Leaving them in the include list lets contributors
// run them by file path against a real DB without an exclude carve-out.

// RUN_DB_INTEGRATION=1 lifts the INTEGRATION_TESTS exclude so a suite can be
// targeted directly (`vitest run <path>`) against a real Postgres — a bare
// file-path argument to `vitest run` does NOT override a config-level
// `exclude`, so `test:rls` and friends were previously unrunnable outside a
// vitest.config.ts edit. This is a pure opt-in: neither `unit-tests.yml` nor
// local `pnpm test` / `pnpm --filter @repo/database test` ever set
// RUN_DB_INTEGRATION, so their behavior is byte-for-byte unchanged. Only the
// dedicated real-Postgres CI gate (`.github/workflows/db-integration.yml`)
// sets it, and only to run specific target suites (never the full
// INTEGRATION_TESTS list — several of those need seeded fixtures that gate
// doesn't create).
const runDbIntegration = process.env.RUN_DB_INTEGRATION === "1";

// The well-known placeholder the unit-tests workflow exports so the lazy
// Prisma client can construct without a database. A handful of default-suite
// tests need the client OBJECT — e.g. to spy on a model delegate and assert a
// query was NOT issued — and the proxy in `prisma/client.ts` throws at first
// property access when DATABASE_URL is unset, which made a bare local
// `pnpm --filter @repo/database test` fail while the same run passed on CI.
// Defaulting here (never overriding — a real DATABASE_URL from the shell,
// `test:rls`, or db-integration.yml always wins) matches CI's DATABASE_URL
// behavior for the default run. Suites that need a real database gate on
// `hasReachableDatabaseUrl()` (`__tests__/_helpers/db-availability.ts`),
// which rejects this exact placeholder, so they self-skip under it the same
// way they do on CI — presence-only `Boolean(process.env.DATABASE_URL)`
// gates are NOT safe under this default and were converted in the same
// change that introduced it. The default is withheld entirely in
// RUN_DB_INTEGRATION mode: that mode exists to hit a real Postgres, and a
// missing DATABASE_URL there should keep failing loudly at client
// construction rather than silently pointing at a placeholder host.
const CI_PLACEHOLDER_DATABASE_URL =
	"postgresql://test:test@localhost:5432/test";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		env: runDbIntegration
			? {}
			: {
					DATABASE_URL:
						process.env.DATABASE_URL ?? CI_PLACEHOLDER_DATABASE_URL,
				},
		// Top-level `__tests__/**` carries the legacy suite; co-located
		// `__tests__/` folders sit next to the query helpers they exercise
		// (see `prisma/queries/projects/__tests__/`).
		include: [
			"__tests__/**/*.test.ts",
			"prisma/queries/**/__tests__/**/*.test.ts",
			// Co-located unit tests for pure helpers and query modules.
			"src/**/*.test.ts",
			"prisma/queries/**/*.test.ts",
		],
		exclude: [
			"node_modules/**",
			"dist/**",
			...(runDbIntegration ? [] : INTEGRATION_TESTS),
		],
		// ONE DATABASE, SO ONE FILE AT A TIME. Every RUN_DB_INTEGRATION suite in
		// this package shares a single Postgres, and vitest's default is to run
		// test FILES in parallel workers. That is safe only while every suite
		// scopes every read to rows it created — and some deliberately cannot.
		//
		// The reconciliation sweep is the worked example. Its statements carry no
		// project or cycle predicate, because that is the shape production runs,
		// so its bounded-pass cases assert EXACT GLOBAL counts
		// (`residual === 100`). Any suite that COMMITS a PENDING cycle while
		// those run is the 101st row. Measured, deterministically, 3 runs out of
		// 3: `publishing-reconcile-sweep.test.ts` and
		// `publishing-clock-rule.test.ts` in one parallel invocation gave
		// `2 failed | 32 passed (34)`; the same two files with file parallelism
		// off gave `34 passed (34)`. The FAILURE COUNT is the finding and it has
		// not moved across three re-takes; the totals are point-in-time and were
		// `2 failed | 27 passed` / `29 passed` when this comment was first
		// written, before the two files gained cases.
		//
		// The fix is here rather than as a `--no-file-parallelism` flag on one CI
		// step because the collision is a property of SHARING A DATABASE, not of
		// those two files: a step that forgets the flag, or a suite added to a
		// different real-Postgres step, reopens it. Answering it once, where the
		// database-backed mode is already declared, is what makes it hold for
		// suites nobody has written yet.
		//
		// The cost is bounded and was measured, not assumed: the twelve-file
		// publishing-schema step 17.5 s -> 54.2 s, the four-file Postgres-suites
		// step 1.6 s -> 3.2 s. Both single-file steps are unaffected by
		// definition. The DEFAULT unit-test run never sets RUN_DB_INTEGRATION —
		// see the comment above `runDbIntegration` — so `pnpm test` keeps full
		// file parallelism and is byte-for-byte unchanged.
		fileParallelism: !runDbIntegration,
		testTimeout: 30000,
	},
});
