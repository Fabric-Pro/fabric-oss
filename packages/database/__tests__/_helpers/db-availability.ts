/**
 * Shared skip-gate predicate for integration tests that hit a real Postgres.
 *
 * # Why this helper exists
 *
 * The default Vitest CI workflow (`.github/workflows/unit-tests.yml`) sets
 * `DATABASE_URL='postgresql://test:test@localhost:5432/test'` so the
 * `@repo/database` Prisma singleton can initialize at module load — but the
 * URL is intentionally **never connected to**. That makes the previously
 * common gate
 *
 * ```ts
 * describe.skipIf(!process.env.DATABASE_URL)(...)
 * ```
 *
 * insufficient: on CI the env var is set, the gate fires false, and the
 * test runs straight into `PrismaClientKnownRequestError: ECONNREFUSED`.
 *
 * `hasReachableDatabaseUrl()` adds a second check that rejects the
 * well-known CI placeholder. Local contributors who set a real
 * `DATABASE_URL` (Aspire-spun-up dev Postgres, staging clone, etc.) still
 * run the suite end-to-end; CI skips the suite cleanly without burning
 * minutes on connection refusals.
 *
 * Keep this in sync with the workflow's `DATABASE_URL` placeholder. If the
 * placeholder ever changes, update `CI_PLACEHOLDER_DATABASE_URLS` below.
 */

const CI_PLACEHOLDER_DATABASE_URLS: ReadonlySet<string> = new Set([
	"postgresql://test:test@localhost:5432/test",
]);

export function hasReachableDatabaseUrl(): boolean {
	const url = process.env.DATABASE_URL;
	if (!url) {
		return false;
	}
	if (CI_PLACEHOLDER_DATABASE_URLS.has(url)) {
		return false;
	}
	return true;
}
