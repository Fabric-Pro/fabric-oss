/**
 * Skip-gate for api-package integration tests that hit a real Postgres.
 * Mirrors packages/database/__tests__/_helpers/db-availability.ts: the CI
 * unit workflow sets a placeholder DATABASE_URL that must never be dialed.
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
