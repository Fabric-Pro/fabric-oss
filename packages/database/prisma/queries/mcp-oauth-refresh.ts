/**
 * The one refresh path for an MCP config's own OAuth grant.
 *
 * Shared by `getValidAccessToken`, the `@repo/mcp` OAuth provider (its
 * proactive refresh) and the `mcp.oauth.refresh` procedure. It:
 *
 * - takes ONE snapshot of the config (generation, binding, client, auth
 *   method, refresh token) and uses only it;
 * - never contacts anything for an unbound config (reconnect required);
 * - posts only to `binding.tokenEndpoint`, through the guarded outbound fetch
 *   with redirects refused — no discovery, no MCP-origin or known-host
 *   fallback;
 * - authenticates the client with the method it was registered with;
 * - saves the result as a compare-and-set on the generation and the refresh
 *   token it spent (`saveMcpOAuthRefresh`), so a refresh that lost a race to
 *   a revoke, re-registration or reconnect changes nothing;
 * - records only sanitized error text.
 */

import {
	credentialFingerprintMatches,
	type McpOAuthBinding,
	markMcpOAuthReconnectRequired,
	parseMcpOAuthBinding,
	resolveMcpClientAuthMethod,
	sameMcpOAuthBinding,
	saveMcpOAuthRefresh,
} from "./mcp-oauth-credentials";

/** A refreshed token set, as written to the config. */
export type McpOAuthRefreshedTokens = {
	accessToken: string;
	/** The refresh token now on the row (rotated, or the one spent). */
	refreshToken: string;
	/** Its ciphertext as written. */
	encryptedRefreshToken: string;
	/** Effective lifetime in seconds (provider value or known default). */
	expiresIn: number | null;
	tokenType: string;
	scope: string | null;
	/** The generation the refresh was made under (unchanged by it). */
	generation: number;
	binding: McpOAuthBinding;
};

export type McpOAuthRefreshOutcome =
	| ({ status: "refreshed" } & McpOAuthRefreshedTokens)
	/** Unbound: no request was made. The config needs a reconnect. */
	| { status: "reconnect-required" }
	/**
	 * The config changed under the refresh (new generation or binding, or
	 * another refresh rotated the token first). Nothing was written and no
	 * failure was counted.
	 */
	| { status: "superseded" }
	/** Nothing to refresh with, or the breaker has tripped. No request made. */
	| { status: "skipped"; reason: string }
	| {
			status: "failed";
			errorCode: string;
			/** Sanitized; safe to log. */
			errorMessage: string;
	  };

export type RefreshMcpOAuthOptions = {
	/**
	 * Whether a failure counts against the 3-strike circuit breaker. `false`
	 * for proactive refreshes in the soft (75%–100%) window, where the caller
	 * still holds a valid access token.
	 */
	recordFailures?: boolean;
	/**
	 * Whether an unbound config is flagged `needsReauth` (no strike).
	 * Defaults to `recordFailures`: a soft-window attempt leaves a still-valid
	 * token usable.
	 */
	markReconnectRequired?: boolean;
	/**
	 * The generation the caller holds. When the config has moved past it the
	 * refresh does nothing and reports `superseded` (a cached provider instance
	 * never refreshes a grant it was not created for).
	 */
	expectedGeneration?: number;
};

const FINGERPRINT_REASON =
	"Reconnect required: the stored OAuth credentials do not match the connection they were bound with.";

const UNBOUND_REASON =
	"Reconnect required: these OAuth credentials are not bound to a known authorization server.";

/**
 * Default token lifetime (seconds) for known servers that omit `expires_in`.
 * Only servers known to issue short-lived tokens; anything else keeps
 * `tokenExpiresAt: null`.
 */
const SERVER_DEFAULT_TOKEN_EXPIRY: Array<{
	hostname: string;
	expirySeconds: number;
}> = [
	{ hostname: "mcp.notion.com", expirySeconds: 3600 }, // Notion tokens expire in ~1 hour
];

export function getMcpServerDefaultTokenExpiry(
	baseUrl: string | null | undefined,
): number | null {
	if (!baseUrl) {
		return null;
	}
	try {
		const parsed = new URL(baseUrl);
		for (const entry of SERVER_DEFAULT_TOKEN_EXPIRY) {
			if (parsed.hostname === entry.hostname) {
				return entry.expirySeconds;
			}
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * In-flight refreshes per config, so concurrent callers in one process share
 * one token-endpoint request. Providers with single-use refresh tokens
 * (Atlassian Rovo) would otherwise reject the second request and count a
 * strike against a working grant. Cross-process races are handled by the
 * rotation-race retry and the compare-and-set write.
 */
const inFlightRefreshes = new Map<string, Promise<McpOAuthRefreshOutcome>>();

/**
 * Refresh a config's OAuth access token. Never throws for a provider or
 * network failure; database errors propagate.
 */
export async function refreshMcpOAuthAccessToken(
	configId: string,
	options: RefreshMcpOAuthOptions = {},
): Promise<McpOAuthRefreshOutcome> {
	const existing = inFlightRefreshes.get(configId);
	if (existing) {
		const outcome = await existing;
		// A caller pinned to another generation must not adopt a result made
		// for a different grant.
		if (
			outcome.status === "refreshed" &&
			options.expectedGeneration !== undefined &&
			outcome.generation !== options.expectedGeneration
		) {
			return { status: "superseded" };
		}
		return outcome;
	}
	const work = doRefresh(configId, options);
	inFlightRefreshes.set(configId, work);
	try {
		return await work;
	} finally {
		inFlightRefreshes.delete(configId);
	}
}

async function doRefresh(
	configId: string,
	options: RefreshMcpOAuthOptions,
): Promise<McpOAuthRefreshOutcome> {
	const recordFailures = options.recordFailures ?? true;
	const markReconnect = options.markReconnectRequired ?? recordFailures;
	const {
		getMcpConfigByIdInternal,
		recordRefreshFailure,
		isPermanentGrantFailure,
	} = await import("./mcp");

	// The one snapshot every request below is built from.
	const snapshot = await getMcpConfigByIdInternal(configId);
	if (!snapshot) {
		return { status: "skipped", reason: "config-not-found" };
	}
	const generation = snapshot.oauthGrantGeneration;
	if (
		options.expectedGeneration !== undefined &&
		generation !== options.expectedGeneration
	) {
		return { status: "superseded" };
	}

	// Circuit breaker: the refresh token is known dead until the user
	// reconnects. No request and no further strike.
	if (snapshot.needsReauth) {
		return { status: "skipped", reason: "needs-reauth" };
	}

	const preflightFailure = async (errorMessage: string) => {
		if (recordFailures) {
			// A local configuration gap, not evidence about the grant.
			await recordRefreshFailure({
				configId,
				errorMessage,
				permanent: false,
				expectedGeneration: generation,
			});
		}
		return { status: "skipped" as const, reason: errorMessage };
	};

	if (!snapshot.encryptedRefreshToken) {
		return preflightFailure("No refresh token available");
	}

	const binding = parseMcpOAuthBinding(snapshot.oauthBinding);
	if (!binding) {
		// Unbound: there is no authorization server Fabric may send this
		// refresh token to. Never ask the MCP server for one.
		if (markReconnect) {
			await markMcpOAuthReconnectRequired({
				configId,
				expectedGeneration: generation,
				reason: UNBOUND_REASON,
			});
		}
		return { status: "reconnect-required" };
	}

	// The stored credential set (client id, secret, refresh token) must be the
	// one the binding was written with — its fingerprint. A mismatch means
	// some writer replaced a credential without this module (the previous app
	// version writes by id alone during a rolling deploy), so what is stored
	// may belong to another AS: send nothing (nor decrypt it).
	if (!credentialFingerprintMatches(binding, snapshot)) {
		console.error(
			"[MCP OAuth] Stored OAuth credentials do not match their binding; not sending them",
			{ configId },
		);
		await markMcpOAuthReconnectRequired({
			configId,
			expectedGeneration: generation,
			reason: FINGERPRINT_REASON,
		});
		return { status: "reconnect-required" };
	}

	if (!snapshot.oauthClientId) {
		return preflightFailure("OAuth client ID not configured");
	}
	const authMethod = resolveMcpClientAuthMethod(snapshot);
	if (authMethod !== "none" && !snapshot.encryptedOauthClientSecret) {
		return preflightFailure("OAuth client secret not configured");
	}

	const { decryptApiKey, encryptApiKey, hashApiKey } = await import(
		"@repo/utils"
	);
	const { refreshOAuthToken } = await import("@repo/utils/oauth-refresh");

	const clientId = snapshot.oauthClientId;
	const clientSecret =
		authMethod !== "none" && snapshot.encryptedOauthClientSecret
			? decryptApiKey(snapshot.encryptedOauthClientSecret)
			: undefined;

	// The ciphertext and plaintext of the refresh token under judgement. The
	// rotation-race retry swaps both for the value a parallel refresh wrote.
	let spentEncryptedRefreshToken = snapshot.encryptedRefreshToken;
	let spentRefreshToken = decryptApiKey(spentEncryptedRefreshToken);

	const post = (refreshToken: string) =>
		refreshOAuthToken({
			tokenEndpoint: binding.tokenEndpoint,
			refreshToken,
			clientId,
			clientSecret,
			clientAuthMethod: authMethod,
		});

	let result = await post(spentRefreshToken);
	// The binding as stored beside the token under judgement (its endpoint is
	// the snapshot's; only the fingerprint can differ after a retry).
	let spentBinding = binding;

	// Cross-process rotation race: another replica may have rotated the
	// refresh token while this request was in flight. Retry ONCE with the
	// reloaded token — but only when the reload shows the SAME grant (same
	// generation and binding). The retry reuses this snapshot's endpoint,
	// client and secret; anything else means the credentials changed and this
	// refresh stops.
	const looksLikeRotationRace =
		!result.ok &&
		(isPermanentGrantFailure(result.errorCode) ||
			/invalid[\s_]+refresh[\s_]+token/i.test(result.errorMessage));
	if (looksLikeRotationRace) {
		const reloaded = await getMcpConfigByIdInternal(configId);
		if (
			!reloaded ||
			reloaded.oauthGrantGeneration !== generation ||
			!sameMcpOAuthBinding(
				parseMcpOAuthBinding(reloaded.oauthBinding),
				binding,
			)
		) {
			return { status: "superseded" };
		}
		const reloadedBinding = parseMcpOAuthBinding(reloaded.oauthBinding);
		const reloadedRefreshToken = reloaded.encryptedRefreshToken
			? decryptApiKey(reloaded.encryptedRefreshToken)
			: null;
		if (
			reloaded.encryptedRefreshToken &&
			reloadedRefreshToken &&
			reloadedRefreshToken !== spentRefreshToken &&
			reloadedBinding &&
			// The rotated token must be the one the winning refresh wrote
			// beside the binding — not one an old-version writer left — and
			// the client this retry sends must still be the stored one.
			credentialFingerprintMatches(reloadedBinding, reloaded) &&
			reloaded.oauthClientId === snapshot.oauthClientId &&
			reloaded.encryptedOauthClientSecret ===
				snapshot.encryptedOauthClientSecret
		) {
			console.log(
				"[MCP OAuth] invalid_grant after a parallel refresh rotated the token; retrying once with the rotated token",
				{ configId },
			);
			spentEncryptedRefreshToken = reloaded.encryptedRefreshToken;
			spentRefreshToken = reloadedRefreshToken;
			spentBinding = reloadedBinding;
			result = await post(spentRefreshToken);
		}
	}

	if (!result.ok) {
		// `errorMessage` is already sanitized by `refreshOAuthToken`.
		console.error("[MCP OAuth] Token refresh failed", {
			configId,
			errorCode: result.errorCode,
			errorMessage: result.errorMessage,
		});
		if (recordFailures) {
			await recordRefreshFailure({
				configId,
				errorMessage: `Token refresh failed (${result.errorCode}): ${result.errorMessage}`,
				// Only a provider rejection of the grant itself may condemn it.
				permanent: isPermanentGrantFailure(result.errorCode),
				// Bound to the row still holding the token that was rejected
				// and to this grant generation.
				expectedRefreshToken: spentEncryptedRefreshToken,
				expectedGeneration: generation,
			});
		}
		return {
			status: "failed",
			errorCode: result.errorCode,
			errorMessage: result.errorMessage,
		};
	}

	const server = snapshot.mcpServer as { defaultUrl?: string | null } | null;
	const expiresIn =
		result.expiresIn ??
		getMcpServerDefaultTokenExpiry(snapshot.baseUrl || server?.defaultUrl);
	const refreshToken = result.refreshToken ?? spentRefreshToken;
	// Skip re-encryption when the provider did not rotate: `encryptApiKey` is
	// non-deterministic, and the spent ciphertext is what is on the row.
	const encryptedRefreshToken = result.refreshToken
		? encryptApiKey(result.refreshToken)
		: spentEncryptedRefreshToken;

	const saved = await saveMcpOAuthRefresh({
		configId,
		expectedGeneration: generation,
		expectedRefreshToken: spentEncryptedRefreshToken,
		tokens: {
			encryptedAccessToken: encryptApiKey(result.accessToken),
			accessTokenHash: hashApiKey(result.accessToken),
			encryptedRefreshToken,
			tokenExpiresAt: expiresIn
				? new Date(Date.now() + expiresIn * 1000)
				: null,
		},
		binding: spentBinding,
		client: {
			oauthClientId: snapshot.oauthClientId,
			encryptedOauthClientSecret: snapshot.encryptedOauthClientSecret,
		},
	});
	if (saved === "superseded") {
		console.log(
			"[MCP OAuth] Refresh result dropped: the config's credentials changed while it was in flight",
			{ configId },
		);
		return { status: "superseded" };
	}

	return {
		status: "refreshed",
		accessToken: result.accessToken,
		refreshToken,
		encryptedRefreshToken,
		expiresIn: expiresIn ?? null,
		tokenType: result.tokenType || "Bearer",
		scope: result.scope,
		generation,
		binding,
	};
}
