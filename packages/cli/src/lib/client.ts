/**
 * Returns a configured FabricClient for CLI commands.
 * Exits with a clear error if no API key is available.
 */

import { FabricAuthError, FabricClient } from "@fabricorg/sdk";
import { getApiKey, getBaseUrl, getOAuth, hasStoredApiKey } from "./config.js";
import { createOAuthFetch } from "./oauth/session.js";
import { printError } from "./output.js";

export interface ClientOverrides {
	/**
	 * Retry policy. The SDK's default retries twice, and its timeout is PER
	 * ATTEMPT, so a "5 second" call can really take about 15.75 seconds with
	 * backoff. Session-hook mode turns retries off so its own deadline is the
	 * only bound that matters.
	 */
	retry?: { maxRetries: number };
	/**
	 * Per-request timeout. The SDK sets this on the CLIENT, not per call, so
	 * a command that must answer fast — the session-start instructions check
	 * — builds its own client rather than reaching for a per-call option that
	 * does not exist.
	 */
	timeoutMs?: number;
}

export function getClient(overrides: ClientOverrides = {}): FabricClient {
	const apiKey = hasStoredApiKey() ? getApiKey() : undefined;
	const oauth = apiKey ? undefined : getOAuth();

	if (!apiKey && !oauth) {
		printError(
			"Not authenticated. Run:\n  fabric auth login\nor, for CI:\n  fabric auth login --key <api-key>",
			3,
		);
	}

	try {
		return new FabricClient({
			// A browser sign-in's token is refreshed per request by the fetch
			// below, which overwrites the Authorization header; what is passed
			// here only satisfies the client's need for a credential.
			apiKey: apiKey ?? oauth?.accessToken,
			...(oauth ? { fetch: createOAuthFetch() } : {}),
			baseUrl: getBaseUrl(),
			...(overrides.timeoutMs !== undefined
				? { timeoutMs: overrides.timeoutMs }
				: {}),
			...(overrides.retry !== undefined
				? { retry: overrides.retry }
				: {}),
		});
	} catch (err: unknown) {
		if (err instanceof FabricAuthError) {
			printError(err.message, 3);
		}
		throw err;
	}
}
