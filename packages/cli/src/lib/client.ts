/**
 * Returns a configured FabricClient for CLI commands.
 * Exits with a clear error if no API key is available.
 *
 * The credential is the one stored for the deployment the request goes to: a
 * hook or a `--base-url` names that deployment, and a sign-in issued by one is
 * never sent to another (`createOAuthFetch`).
 */

import { FabricAuthError, FabricClient } from "@fabricorg/sdk";
import { getApiKey, getBaseUrl, getOAuth, hasStoredApiKey } from "./config.js";
import { fabricCommand } from "./launcher.js";
import { createOAuthFetch } from "./oauth/session.js";
import {
	BAD_BASE_URL_LINE,
	DEFAULT_ORIGIN,
	normalizeOrigin,
} from "./origin.js";
import { printError } from "./output.js";
import { cliUserAgent, recordUpgradeNotice } from "./user-agent.js";

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
	/**
	 * The deployment for THIS invocation (`--base-url`), instead of the one
	 * `FABRIC_BASE_URL` or the profile names.
	 */
	baseUrl?: string;
	/**
	 * The project the command is for. Its own browser sign-in is used when it
	 * has one, before the deployment's credential, and a sign-in that reaches
	 * one project is never used for a command that names none.
	 */
	project?: string;
}

function resolveClientOrigin(overrides: ClientOverrides): string {
	const origin = normalizeOrigin(
		overrides.baseUrl ?? getBaseUrl() ?? DEFAULT_ORIGIN,
	);
	if (origin === null) {
		// The request would go to the raw address, so the credential must be
		// the one for that address: there is none to pick, and the default
		// deployment's is never a substitute.
		printError(BAD_BASE_URL_LINE, 2);
	}
	return origin;
}

function resolveClientAuth(overrides: ClientOverrides) {
	const origin = resolveClientOrigin(overrides);
	// The order is `FABRIC_API_KEY`, the project's own sign-in, then what the
	// deployment has stored (`getApiKey` in `config.ts`).
	const projectOAuth =
		overrides.project === undefined || process.env.FABRIC_API_KEY
			? undefined
			: getOAuth(origin, overrides.project);
	const apiKey = projectOAuth
		? undefined
		: hasStoredApiKey(origin)
			? getApiKey(origin)
			: undefined;
	const oauth = projectOAuth ?? (apiKey ? undefined : getOAuth(origin));

	if (!apiKey && !oauth) {
		printError(
			`Not authenticated. Run:\n  ${fabricCommand(`auth login${overrides.project === undefined ? "" : ` --project ${overrides.project}`}`, origin)}\nor, for CI:\n  ${fabricCommand("auth login --key <api-key>", origin)}`,
			3,
		);
	}
	return { origin, apiKey, oauth, projectOAuth };
}

/**
 * Authenticated fetch for the MCP gateway.
 *
 * Browser sign-ins currently store one access token selected for the REST API
 * resource (or one project's REST resource). The gateway correctly refuses
 * that token as the wrong audience, and retrying it would only rotate the
 * refresh token before returning the same 401. Require the supported API-key
 * credential before any MCP request instead.
 */
export function getMcpAuthenticatedFetch(overrides: ClientOverrides = {}): {
	origin: string;
	fetch: typeof globalThis.fetch;
	authorizationHeader: string;
} {
	const origin = resolveClientOrigin(overrides);
	// MCP supports API keys, not the REST token selected for a project's
	// browser sign-in. Read the key independently so that adding a project
	// sign-in does not hide an environment or deployment-profile key.
	const apiKey = hasStoredApiKey(origin) ? getApiKey(origin) : undefined;
	if (!apiKey) {
		printError(
			"Browser sign-in tokens are not valid for the MCP Gateway. Set FABRIC_API_KEY or run fabric auth login --key <api-key> before using fabric mcp tools or fabric mcp call.",
			3,
		);
	}
	return {
		origin,
		fetch: globalThis.fetch,
		authorizationHeader: `Bearer ${apiKey}`,
	};
}

export function getClient(overrides: ClientOverrides = {}): FabricClient {
	const { origin, apiKey, oauth, projectOAuth } =
		resolveClientAuth(overrides);

	try {
		return new FabricClient({
			// A browser sign-in's token is refreshed per request by the fetch
			// below, which overwrites the Authorization header; what is passed
			// here only satisfies the client's need for a credential.
			apiKey: apiKey ?? oauth?.accessToken,
			...(oauth
				? {
						fetch: createOAuthFetch({
							origin,
							...(projectOAuth
								? { projectId: overrides.project }
								: {}),
						}),
					}
				: {}),
			baseUrl: overrides.baseUrl ?? getBaseUrl(),
			userAgent: cliUserAgent(),
			onUpgradeNotice: recordUpgradeNotice,
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
