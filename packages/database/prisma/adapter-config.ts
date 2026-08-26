import type { PoolConfig } from "pg";

/**
 * Database connection auth strategy, selected via DATABASE_AUTH_PROVIDER.
 *
 * - "password" (default): credentials live in DATABASE_URL — works for every
 *   Postgres host (local, Neon, RDS, Lakebase native password roles).
 * - "databricks-oauth": Databricks Lakebase OAuth roles. Tokens expire after
 *   1 hour (enforced at login only), so each NEW pool connection fetches a
 *   fresh token via the async `password` callback and connections are
 *   recycled with `maxLifetimeSeconds`. DATABASE_URL should omit a password
 *   in this mode. Note: Lakebase's built-in PgBouncer pooler does NOT accept
 *   OAuth roles — use the direct endpoint, or password roles for pooling.
 */
export type DatabaseAuthProvider = "password" | "databricks-oauth";

// Lakebase enforces token expiry only at login, so live connections outlast
// their token. Recycling exists to stay well under Lakebase's 3-day max
// connection life, not to chase the 1-hour token window.
const OAUTH_CONNECTION_MAX_LIFETIME_SECONDS = 6 * 60 * 60;

/** pg's own default when `max` is unset. Kept so request handlers do not move. */
const DEFAULT_POOL_MAX = 10;

/**
 * Connections the pg pool may open. `pg` defaults to 10 when `max` is unset,
 * which is a sensible number for a serverless request handler and far too few
 * for the Temporal worker: that process hosts twelve Workers whose activity
 * concurrency sums well past it, all sharing this one pool. Once the pool is
 * saturated, `connectionTimeoutMillis` also bounds how long a queued caller
 * waits, so oversubscription shows up as a steady drip of timeout-shaped
 * `PrismaClientKnownRequestError`s rather than as anything obviously
 * pool-related.
 *
 * The default stays at pg's 10 so request handlers are unchanged. Processes
 * that know their own concurrency budget set `DATABASE_POOL_MAX` — the worker
 * derives it from the activity slots it actually declares.
 */
function resolveDatabasePoolMax(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.DATABASE_POOL_MAX?.trim();
	if (!raw) {
		return DEFAULT_POOL_MAX;
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(
			`Invalid DATABASE_POOL_MAX "${raw}" — expected a positive integer`,
		);
	}
	return parsed;
}

export function getDatabaseAuthProvider(
	env: NodeJS.ProcessEnv = process.env,
): DatabaseAuthProvider {
	const raw = env.DATABASE_AUTH_PROVIDER?.trim().toLowerCase();
	if (!raw || raw === "password") {
		return "password";
	}
	if (raw === "databricks-oauth") {
		return "databricks-oauth";
	}
	throw new Error(
		`Unsupported DATABASE_AUTH_PROVIDER "${raw}" — expected "password" or "databricks-oauth"`,
	);
}

/**
 * Build the pg PoolConfig handed to PrismaPg. Pure — never opens
 * connections, so it is safe to call at module-eval time and in tests.
 * `getOAuthToken` is only invoked by pg when a connection is actually
 * established in "databricks-oauth" mode.
 */
export function buildPgPoolConfig(
	env: NodeJS.ProcessEnv,
	getOAuthToken: () => Promise<string>,
): PoolConfig {
	const connectionString = env.DATABASE_URL;
	if (!connectionString) {
		throw new Error("DATABASE_URL is not set");
	}
	const max = resolveDatabasePoolMax(env);
	if (getDatabaseAuthProvider(env) === "databricks-oauth") {
		return {
			connectionString,
			max,
			password: () => getOAuthToken(),
			maxLifetimeSeconds: OAUTH_CONNECTION_MAX_LIFETIME_SECONDS,
		};
	}
	return { connectionString, max };
}
