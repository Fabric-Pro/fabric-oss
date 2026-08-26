/**
 * Service-URL resolution with a never-localhost guard for deployed
 * environments.
 *
 * Background: server-side code resolved internal service URLs as
 * `process.env.X || "http://localhost:PORT"`. In a deployed environment an
 * unset variable silently pointed the API or the Temporal worker at
 * localhost, producing dead requests with no visible error — the same bug
 * class `lib/base-url.ts` documents for APP_URL (localhost URLs leaking out
 * of the worker container).
 *
 * These helpers keep the localhost fallback for local development but turn
 * an unset variable in a deployed environment into a loud, actionable
 * configuration error naming the variable.
 */

/** True when running in any deployed environment (Vercel or the Azure worker). */
export function isDeployedEnvironment(): boolean {
	return Boolean(
		// Vercel (preview/staging/prod) — set on every Vercel deployment.
		process.env.VERCEL_ENV ||
			// Explicit per-project override (see require-permission.ts: Vercel
			// runs every deployment with NODE_ENV=production, so FABRIC_ENV is
			// the explicit environment discriminator).
			process.env.FABRIC_ENV ||
			// Azure temporal worker: no VERCEL_ENV, but the container app runs
			// with NODE_ENV=production. A locally-run production build also
			// trips this — acceptable: fail loud beats silent localhost.
			process.env.NODE_ENV === "production",
	);
}

export type ServiceUrlResult =
	| { ok: true; url: string }
	| { ok: false; error: string };

/**
 * Resolve a service base URL from the environment.
 *
 * - env var set → its value (trailing slash stripped).
 * - unset + local dev → `localFallback` (previous behavior, unchanged).
 * - unset + deployed → `{ ok: false, error }` naming the variable.
 */
export function resolveServiceUrl(
	envVarName: string,
	localFallback: string,
): ServiceUrlResult {
	const value = process.env[envVarName];
	if (value) {
		return { ok: true, url: value.replace(/\/+$/, "") };
	}
	if (isDeployedEnvironment()) {
		return {
			ok: false,
			error: `The service is not configured for this environment — set ${envVarName}.`,
		};
	}
	return { ok: true, url: localFallback };
}

/**
 * Throwing convenience for worker activities: returns the resolved URL or
 * throws `Error(error)` when the variable is unset in a deployed
 * environment. The thrown error surfaces as a clear activity failure
 * instead of a silent localhost request.
 */
export function requireServiceUrl(
	envVarName: string,
	localFallback: string,
): string {
	const result = resolveServiceUrl(envVarName, localFallback);
	if (!result.ok) {
		throw new Error(result.error);
	}
	return result.url;
}
