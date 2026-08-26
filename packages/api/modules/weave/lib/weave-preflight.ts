import { ORPCError } from "@orpc/server";
import { resolveServiceUrl } from "@repo/utils";

/** How long the synchronous `/health` probe may take before aborting. */
const HEALTH_CHECK_TIMEOUT_MS = 3_000;

/**
 * Synchronous preflight gate for the Weave planner/reader services.
 *
 * Resolves the service base URL (never falling back to localhost in a
 * deployed environment) and verifies `GET {url}/health` answers 2xx within
 * 3 s. Throws `ORPCError("SERVICE_UNAVAILABLE")` with an actionable message
 * when the URL is unset in a deployed environment or the service is
 * unreachable, so procedures fail fast before creating any rows.
 *
 * The weave service `/health` endpoints are unauthenticated.
 *
 * @returns the resolved base URL for the subsequent A2A call.
 */
export async function assertWeaveServiceHealthy(opts: {
	envVarName: "WEAVE_PLANNERS_URL" | "WEAVE_READERS_URL";
	localFallback: string;
	serviceDescription: string;
}): Promise<string> {
	const resolved = resolveServiceUrl(opts.envVarName, opts.localFallback);
	if (!resolved.ok) {
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: `${opts.serviceDescription} is not configured for this environment — set ${opts.envVarName}.`,
		});
	}

	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		HEALTH_CHECK_TIMEOUT_MS,
	);
	try {
		const response = await fetch(`${resolved.url}/health`, {
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`Health check returned ${response.status}`);
		}
	} catch (error) {
		console.error(
			`[weave] ${opts.envVarName} health check failed for ${resolved.url}:`,
			error,
		);
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: `${opts.serviceDescription} is unreachable. It may be starting up or misconfigured — try again shortly or contact your administrator.`,
		});
	} finally {
		clearTimeout(timeout);
	}

	return resolved.url;
}
