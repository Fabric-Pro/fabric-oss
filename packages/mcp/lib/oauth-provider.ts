/**
 * OAuth Client Provider Implementation for AI SDK v6
 *
 * Implements the OAuthClientProvider interface from @ai-sdk/mcp for automatic
 * token management and mid-session refresh. This replaces manual header-based
 * authentication with AI SDK's built-in OAuth handling.
 *
 * @see https://vercel.com/blog/ai-sdk-6 (authProvider documentation)
 */

import type {
	OAuthClientInformation,
	OAuthClientMetadata,
	OAuthClientProvider,
	OAuthTokens,
} from "@ai-sdk/mcp";
import {
	clearRefreshFailures,
	getCachedOAuthMetadata,
	getMcpConfigByIdInternal,
	isPermanentGrantFailure,
	recordRefreshFailure,
	updateMcpConfigTokens,
} from "@repo/database";
import { decryptApiKey, encryptApiKey, hashApiKey } from "@repo/utils";
import { refreshOAuthToken } from "@repo/utils/oauth-refresh";

/**
 * Error thrown when OAuth authorization is required but cannot be performed
 * in the current context (e.g., server-side execution).
 */
export class OAuthAuthorizationRequiredError extends Error {
	public readonly configId: string;
	public readonly serverName: string;
	public readonly authorizationUrl?: string;

	constructor(options: {
		configId: string;
		serverName: string;
		authorizationUrl?: string;
		message?: string;
	}) {
		super(
			options.message ||
				`OAuth authorization required for "${options.serverName}". Please authenticate in MCP Settings.`,
		);
		this.name = "OAuthAuthorizationRequiredError";
		this.configId = options.configId;
		this.serverName = options.serverName;
		this.authorizationUrl = options.authorizationUrl;
	}
}

/**
 * Configuration for creating an OAuth client provider
 */
export interface CreateOAuthProviderOptions {
	/** The MCP configuration ID */
	configId: string;
	/** The user ID for authentication and authorization */
	userId: string;
	/** The organization ID for tenant isolation (optional) */
	organizationId?: string | null;
	/** The redirect URI for OAuth callbacks */
	redirectUri: string;
	/**
	 * Callback invoked when authorization is required.
	 * In browser contexts, this can redirect the user.
	 * In server contexts, this should throw an error or signal the need for auth.
	 */
	onAuthorizationRequired?: (authUrl: URL) => void | Promise<void>;
}

/**
 * In-memory storage for OAuth state during the authorization flow.
 * This is session-scoped and cleared after use.
 */
interface OAuthFlowState {
	codeVerifier: string;
}

// Session-scoped storage for OAuth flow state (keyed by configId)
const oauthFlowStateStore = new Map<string, OAuthFlowState>();

/**
 * Module-local mutex for in-flight refresh-token requests, keyed by configId.
 *
 * Why this exists: providers like Atlassian Rovo use **single-use refresh
 * tokens** — every refresh issues a new refresh_token and immediately
 * invalidates the previous one. With concurrent MCP tool calls, two
 * `tokens()` invocations can both observe the access token as expired,
 * both load the *same* refresh_token from the DB, and both hit the
 * token endpoint in parallel. The first request rotates the refresh
 * token (saves the new one). The second request was already in flight
 * with the now-revoked old token, gets a 4xx `invalid_grant`, and
 * increments the 3-strike `recordRefreshFailure` counter. After 3 such
 * races the config is flipped to `needsReauth: true` even though
 * nothing on the user's side is actually broken.
 *
 * Deduplicating refresh attempts per configId at the process boundary
 * eliminates the within-replica race. Cross-replica (multiple temporal
 * workers refreshing the same config simultaneously) is handled by
 * the retry-on-`invalid_grant` path inside the actual refresh logic.
 */
const inFlightRefreshes = new Map<string, Promise<OAuthTokens | undefined>>();

/**
 * Creates an OAuthClientProvider for the AI SDK v6 MCP client.
 *
 * This provider integrates with our database-backed OAuth storage to:
 * - Retrieve stored access/refresh tokens
 * - Automatically save refreshed tokens
 * - Handle PKCE code verifier storage
 * - Support Dynamic Client Registration (DCR)
 *
 * @example
 * ```typescript
 * const authProvider = await createOAuthClientProvider({
 *   configId: "config_123",
 *   userId: "user_456",
 *   organizationId: "org_789",
 *   redirectUri: "https://app.example.com/api/mcp/oauth/callback",
 * });
 *
 * const client = await createMCPClient({
 *   transport: { type: "http", url: serverUrl, authProvider },
 * });
 * ```
 */
export async function createOAuthClientProvider(
	options: CreateOAuthProviderOptions,
): Promise<OAuthClientProvider> {
	const {
		configId,
		userId,
		organizationId,
		redirectUri,
		onAuthorizationRequired,
	} = options;

	// Load the MCP config to get OAuth credentials
	const cfg = await getMcpConfigByIdInternal(configId);
	if (!cfg) {
		throw new Error(`MCP config not found: ${configId}`);
	}

	// Verify tenant isolation
	if (cfg.userId && cfg.userId !== userId) {
		throw new Error(
			"Unauthorized: MCP config does not belong to this user",
		);
	}
	if (organizationId !== undefined) {
		if (organizationId && cfg.organizationId !== organizationId) {
			throw new Error(
				"Unauthorized: MCP config does not belong to the specified organization",
			);
		}
		if (organizationId === null && cfg.organizationId !== null) {
			throw new Error(
				"Unauthorized: MCP config is not a personal config",
			);
		}
	}

	const server = cfg.mcpServer as {
		name?: string;
		defaultUrl?: string;
		oauthDiscoveryUrl?: string;
		oauthTokenEndpoint?: string;
	} | null;

	const serverName = cfg.displayName || server?.name || "MCP Server";
	const serverBaseUrl = cfg.baseUrl || server?.defaultUrl || null;

	// Build client metadata for DCR (if needed)
	const clientMetadata: OAuthClientMetadata = {
		redirect_uris: [redirectUri],
		client_name: serverName,
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "client_secret_basic",
		scope: cfg.scopes?.join(" ") || undefined,
	};

	/**
	 * Get the token endpoint from cached metadata or server config.
	 * Discovery is handled separately during OAuth flow initialization.
	 */
	async function getTokenEndpoint(): Promise<string | null> {
		// Check cached metadata first (populated during OAuth start flow)
		const cachedMetadata = await getCachedOAuthMetadata({ configId });
		if (cachedMetadata?.tokenEndpoint) {
			return cachedMetadata.tokenEndpoint as string;
		}

		// Fall back to server-configured endpoint
		if (server?.oauthTokenEndpoint) {
			return server.oauthTokenEndpoint;
		}

		// Derive from base URL via OAuth discovery (RFC 8414)
		if (serverBaseUrl) {
			try {
				const origin = new URL(serverBaseUrl).origin;
				const discoveryUrl = `${origin}/.well-known/oauth-authorization-server`;
				const res = await fetch(discoveryUrl, {
					method: "GET",
					headers: { Accept: "application/json" },
					signal: AbortSignal.timeout(5000),
				});
				if (res.ok) {
					const metadata = await res.json();
					if (metadata?.token_endpoint) {
						return metadata.token_endpoint as string;
					}
				}
			} catch {
				// Discovery failed — fall through to known endpoints
			}
		}

		// Fall back to known token endpoints for servers without RFC 8414 discovery
		if (serverBaseUrl) {
			const knownEndpoint = getKnownTokenEndpoint(serverBaseUrl);
			if (knownEndpoint) {
				return knownEndpoint;
			}
		}

		return null;
	}

	/**
	 * Refresh the access token using the refresh token.
	 *
	 * Concurrent-safe: deduplicates in-flight refreshes per configId via
	 * the module-level `inFlightRefreshes` mutex map. The first caller
	 * runs the real refresh; subsequent callers await the same promise
	 * and reuse the result. Critical for providers with single-use
	 * refresh-token rotation (Atlassian Rovo) — see the comment above
	 * `inFlightRefreshes` for the full failure mode.
	 *
	 * Cross-replica safety: when two temporal-worker replicas refresh
	 * the same config in parallel, the mutex doesn't help (each replica
	 * has its own map). One refresh rotates the token + saves the new
	 * one; the other races, gets `invalid_grant` from the provider,
	 * RELOADS the MCPConfig from DB (now has the just-rotated refresh
	 * token from the winning replica), and retries ONCE with the fresh
	 * value. The retry succeeds because the new refresh token is now
	 * the canonical one.
	 *
	 * @param options.recordFailures  Whether to increment the refresh-failure counter
	 *   on failure. Set to `false` for proactive refreshes in the soft (75%–100%)
	 *   window — those misses are non-fatal (the caller falls through to the still-
	 *   valid current token), so counting them against the 3-strike circuit breaker
	 *   would incorrectly flip the config to `needsReauth`/`UNAVAILABLE` on
	 *   transient 5xx/network errors.
	 */
	async function refreshAccessToken(options?: {
		recordFailures?: boolean;
	}): Promise<OAuthTokens | undefined> {
		// Dedup concurrent refreshes per configId. If another call is
		// already mid-flight for the same config, await it and return its
		// result rather than racing the token endpoint.
		const existing = inFlightRefreshes.get(configId);
		if (existing) {
			console.log(
				"[OAuth Provider] Deduplicating concurrent refresh request",
				{ configId },
			);
			return existing;
		}

		const work = doRefreshAccessToken(options);
		inFlightRefreshes.set(configId, work);
		try {
			return await work;
		} finally {
			inFlightRefreshes.delete(configId);
		}
	}

	/**
	 * The actual refresh logic. Called from inside the mutex wrapper.
	 * Implements retry-on-`invalid_grant` for cross-replica races where
	 * a different worker just rotated the refresh token between our
	 * config-load and our token-endpoint POST.
	 */
	async function doRefreshAccessToken(options?: {
		recordFailures?: boolean;
	}): Promise<OAuthTokens | undefined> {
		const recordFailures = options?.recordFailures ?? true;

		// Reload config to get latest tokens
		const currentCfg = await getMcpConfigByIdInternal(configId);

		// Circuit breaker: once `recordRefreshFailure` has tripped
		// `needsReauth`, the refresh token is known-dead until the user
		// re-authenticates. Refuse further attempts — this is the choke point
		// for every refresh in this provider, so it also stops clients cached
		// before the breaker tripped from retrying for the rest of their TTL.
		// Deliberately does NOT record a failure: we never contacted the
		// provider, so counting it would inflate the failure metadata. Must
		// run before the missing-refresh-token branch below so a tripped
		// config that also lacks a refresh token never records a further
		// failure either.
		if (currentCfg?.needsReauth) {
			return undefined;
		}

		if (!currentCfg?.encryptedRefreshToken) {
			if (recordFailures) {
				// Local configuration gap, not evidence about the grant —
				// see `permanent` on `recordRefreshFailure`.
				await recordRefreshFailure({
					configId,
					errorMessage: "No refresh token available",
					permanent: false,
				});
			}
			return undefined;
		}

		const tokenEndpoint = await getTokenEndpoint();
		if (!tokenEndpoint) {
			if (recordFailures) {
				await recordRefreshFailure({
					configId,
					errorMessage: "Token endpoint not available for refresh",
					permanent: false,
				});
			}
			return undefined;
		}

		// For public OAuth clients (token_endpoint_auth_method: 'none'),
		// client_secret is not required
		const isPublicClient = isPublicOAuthClient(currentCfg);
		if (!currentCfg.oauthClientId) {
			if (recordFailures) {
				await recordRefreshFailure({
					configId,
					errorMessage: "OAuth client ID not configured",
					permanent: false,
				});
			}
			return undefined;
		}
		if (!isPublicClient && !currentCfg.encryptedOauthClientSecret) {
			if (recordFailures) {
				await recordRefreshFailure({
					configId,
					errorMessage: "OAuth client secret not configured",
					permanent: false,
				});
			}
			return undefined;
		}

		const refreshToken = decryptApiKey(currentCfg.encryptedRefreshToken);
		// Ciphertext of the refresh token this call actually spends. The
		// rotation-race retry below replaces it with the value the winning
		// refresh persisted, so a rejection is always recorded against the
		// row version the PROVIDER passed judgement on — not the one we
		// happened to load first.
		let spentEncryptedRefreshToken = currentCfg.encryptedRefreshToken;
		// Its plaintext, tracked in lockstep. A provider that rotates only
		// sometimes returns no `refresh_token` on success, and both the row
		// and the `OAuthTokens` we hand back then fall back to what we spent.
		// They have to fall back to the SAME token: returning the value loaded
		// before the race would hand the caller a refresh token the retry
		// already proved dead, while the row correctly kept the live one.
		let spentRefreshToken = refreshToken;
		const clientSecret =
			!isPublicClient && currentCfg.encryptedOauthClientSecret
				? decryptApiKey(currentCfg.encryptedOauthClientSecret)
				: undefined;

		let result = await refreshOAuthToken({
			tokenEndpoint,
			refreshToken,
			clientId: currentCfg.oauthClientId,
			clientSecret,
		});

		// Cross-replica race recovery: if the provider says the refresh
		// token is invalid, reload the MCPConfig — a parallel replica
		// may have just rotated it — and retry ONCE with the fresh
		// value. `isPermanentGrantFailure` is the shared spelling of the
		// two codes that mean "refresh token revoked or otherwise
		// invalid" (RFC 6749 §5.2 `invalid_grant`, plus `invalid_token`
		// as used by some IdPs); the message regex additionally catches
		// providers that bury it in prose. Any other error code is a real
		// failure, not a race, so we don't retry.
		const isRotationRace =
			!result.ok &&
			(isPermanentGrantFailure(result.errorCode) ||
				/invalid[\s_]+refresh[\s_]+token/i.test(result.errorMessage));
		if (isRotationRace) {
			const reloadedCfg = await getMcpConfigByIdInternal(configId);
			const reloadedRefreshToken = reloadedCfg?.encryptedRefreshToken
				? decryptApiKey(reloadedCfg.encryptedRefreshToken)
				: null;
			if (reloadedRefreshToken && reloadedRefreshToken !== refreshToken) {
				console.log(
					"[OAuth Provider] invalid_grant + refresh token rotated by a parallel refresh — retrying once with fresh token",
					{ configId },
				);
				// From here on the retried token is the one under judgement.
				spentEncryptedRefreshToken =
					reloadedCfg?.encryptedRefreshToken ??
					spentEncryptedRefreshToken;
				spentRefreshToken = reloadedRefreshToken;
				result = await refreshOAuthToken({
					tokenEndpoint,
					refreshToken: reloadedRefreshToken,
					clientId: currentCfg.oauthClientId,
					clientSecret,
				});
			}
		}

		if (!result.ok) {
			console.error(
				"[OAuth Provider] Token refresh error:",
				result.errorMessage,
			);
			if (recordFailures) {
				// Only a provider rejection of the grant itself may condemn
				// the credential. The message-regex arm above is a retry
				// heuristic, deliberately not a condemnation signal — a
				// classified error code is required to spend a strike.
				await recordRefreshFailure({
					configId,
					errorMessage: `Token refresh failed: ${result.errorMessage}`,
					permanent: isPermanentGrantFailure(result.errorCode),
					// Binds a condemnation to the row still holding the token
					// that was rejected. This is what covers the retry above:
					// it can lose a SECOND race (a third caller rotates again
					// while the retry is in flight) and there is no further
					// reload to catch that, so the write declines instead.
					expectedRefreshToken: spentEncryptedRefreshToken,
				});
			}
			return undefined;
		}

		// Use server-specific default for known servers, preserve null for unknown
		const serverDefaultExpiry = getServerDefaultTokenExpiry(serverBaseUrl);
		const effectiveExpiresIn =
			result.expiresIn ?? serverDefaultExpiry ?? undefined;

		const tokens: OAuthTokens = {
			access_token: result.accessToken,
			token_type: result.tokenType || "Bearer",
			expires_in: effectiveExpiresIn,
			// Same fallback as the row write below: the token this call SPENT,
			// which after a rotation-race retry is not the one first loaded.
			refresh_token: result.refreshToken ?? spentRefreshToken,
			scope: result.scope ?? undefined,
		};

		const now = Date.now();
		const expiresAt = effectiveExpiresIn
			? new Date(now + effectiveExpiresIn * 1000)
			: null;

		await updateMcpConfigTokens({
			configId,
			encryptedAccessToken: encryptApiKey(tokens.access_token),
			accessTokenHash: hashApiKey(tokens.access_token),
			// Skip re-encryption when the provider did not rotate;
			// `encryptApiKey` is non-deterministic. The fallback is the token
			// this call SPENT, not the one it first loaded: after a
			// rotation-race retry those differ, and writing back the value we
			// loaded would clobber the winner's live token with a spent one.
			encryptedRefreshToken: result.refreshToken
				? encryptApiKey(result.refreshToken)
				: spentEncryptedRefreshToken,
			tokenExpiresAt: expiresAt,
		});

		await clearRefreshFailures(configId);

		console.log("[OAuth Provider] Token refreshed successfully");
		return tokens;
	}

	// Create the provider implementation
	const provider: OAuthClientProvider = {
		/**
		 * Returns current access token if present and valid.
		 * Attempts refresh if token is expired but refresh token is available.
		 */
		async tokens(): Promise<OAuthTokens | undefined> {
			// Reload config to get latest tokens
			const currentCfg = await getMcpConfigByIdInternal(configId);
			if (!currentCfg?.encryptedAccessToken) {
				return undefined;
			}

			const accessToken = decryptApiKey(currentCfg.encryptedAccessToken);
			const tokenExpiresAt = currentCfg.tokenExpiresAt;

			// Check if token is expired (with 60s buffer for clock skew)
			const now = Date.now();
			let isExpired = !!(
				tokenExpiresAt && tokenExpiresAt.getTime() < now + 60 * 1000
			);

			// For known short-lived-token servers with null tokenExpiresAt,
			// treat as hard-expired once past known lifetime.
			const knownExpiry = getServerDefaultTokenExpiry(serverBaseUrl);
			const tokenAge = currentCfg.updatedAt
				? now - new Date(currentCfg.updatedAt).getTime()
				: Number.POSITIVE_INFINITY;

			if (
				!tokenExpiresAt &&
				knownExpiry !== null &&
				tokenAge > knownExpiry * 1000
			) {
				isExpired = true;
			}

			// Proactive refresh: between 75%-100% of known lifetime
			const shouldProactivelyRefresh =
				!isExpired &&
				!tokenExpiresAt &&
				knownExpiry !== null &&
				currentCfg.encryptedRefreshToken &&
				tokenAge > knownExpiry * 0.75 * 1000;

			if (isExpired || shouldProactivelyRefresh) {
				// Only count failures against the 3-strike circuit breaker when the
				// token is hard-expired. Proactive misses in the 75%–100% soft window
				// are recoverable (we fall through to the still-valid current token),
				// so transient 5xx/network errors there must not flip the config to
				// needsReauth/UNAVAILABLE.
				const refreshedTokens = await refreshAccessToken({
					recordFailures: isExpired,
				});
				if (refreshedTokens) {
					return refreshedTokens;
				}
				// Refresh failed — hard-expired returns undefined to trigger re-auth;
				// soft window (75%-100%) falls through to return current token
				if (isExpired) {
					return undefined;
				}
			}

			// Token is still valid (or expiry unknown and proactive refresh wasn't needed/failed gracefully)
			const tokens: OAuthTokens = {
				access_token: accessToken,
				token_type: "Bearer",
				expires_in: tokenExpiresAt
					? Math.floor((tokenExpiresAt.getTime() - now) / 1000)
					: undefined,
				refresh_token: currentCfg.encryptedRefreshToken
					? decryptApiKey(currentCfg.encryptedRefreshToken)
					: undefined,
			};

			return tokens;
		},

		/**
		 * Saves new tokens (e.g., after refresh by the transport).
		 */
		async saveTokens(tokens: OAuthTokens): Promise<void> {
			const now = Date.now();
			const serverDefaultExpiry =
				getServerDefaultTokenExpiry(serverBaseUrl);
			const effectiveExpiresIn =
				tokens.expires_in ?? serverDefaultExpiry ?? undefined;
			const expiresAt = effectiveExpiresIn
				? new Date(now + effectiveExpiresIn * 1000)
				: null;

			await updateMcpConfigTokens({
				configId,
				encryptedAccessToken: encryptApiKey(tokens.access_token),
				accessTokenHash: hashApiKey(tokens.access_token),
				encryptedRefreshToken: tokens.refresh_token
					? encryptApiKey(tokens.refresh_token)
					: null,
				tokenExpiresAt: expiresAt,
			});

			await clearRefreshFailures(configId);
		},

		/**
		 * Handles redirect to authorization URL.
		 * In server contexts, this throws an error indicating auth is required.
		 * In browser contexts, the callback can handle the redirect.
		 */
		async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
			if (onAuthorizationRequired) {
				await onAuthorizationRequired(authorizationUrl);
			} else {
				// No handler provided - throw an error with context
				throw new OAuthAuthorizationRequiredError({
					configId,
					serverName,
					authorizationUrl: authorizationUrl.toString(),
				});
			}
		},

		/**
		 * Saves the PKCE code verifier for the current authorization flow.
		 */
		async saveCodeVerifier(codeVerifier: string): Promise<void> {
			oauthFlowStateStore.set(configId, { codeVerifier });
		},

		/**
		 * Retrieves the stored PKCE code verifier.
		 */
		async codeVerifier(): Promise<string> {
			const state = oauthFlowStateStore.get(configId);
			if (!state?.codeVerifier) {
				throw new Error(
					"Code verifier not found - OAuth flow may have expired",
				);
			}
			return state.codeVerifier;
		},

		/**
		 * The redirect URL for OAuth callbacks.
		 */
		get redirectUrl(): string {
			return redirectUri;
		},

		/**
		 * Client metadata for Dynamic Client Registration (DCR).
		 */
		get clientMetadata(): OAuthClientMetadata {
			return clientMetadata;
		},

		/**
		 * Returns stored client information (from DCR or manual configuration).
		 */
		async clientInformation(): Promise<OAuthClientInformation | undefined> {
			// Reload to get latest
			const currentCfg = await getMcpConfigByIdInternal(configId);
			if (!currentCfg?.oauthClientId) {
				return undefined;
			}

			const info: OAuthClientInformation = {
				client_id: currentCfg.oauthClientId,
				client_secret: currentCfg.encryptedOauthClientSecret
					? decryptApiKey(currentCfg.encryptedOauthClientSecret)
					: undefined,
			};

			// Include DCR-specific fields if available
			const dcrMetadata = currentCfg.dcrClientMetadata as {
				client_id_issued_at?: number;
				client_secret_expires_at?: number;
			} | null;

			if (dcrMetadata?.client_id_issued_at) {
				info.client_id_issued_at = dcrMetadata.client_id_issued_at;
			}
			if (dcrMetadata?.client_secret_expires_at) {
				info.client_secret_expires_at =
					dcrMetadata.client_secret_expires_at;
			}

			return info;
		},

		/**
		 * Saves client information after DCR registration.
		 */
		async saveClientInformation(
			clientInfo: OAuthClientInformation,
		): Promise<void> {
			const { updateMcpConfigAfterDcr } = await import("@repo/database");

			await updateMcpConfigAfterDcr({
				configId,
				oauthClientId: clientInfo.client_id,
				encryptedOauthClientSecret: clientInfo.client_secret
					? encryptApiKey(clientInfo.client_secret)
					: null,
				dcrClientMetadata: {
					client_id_issued_at: clientInfo.client_id_issued_at,
					client_secret_expires_at:
						clientInfo.client_secret_expires_at,
				},
				dcrRegisteredAt: new Date(),
			});
		},

		/**
		 * Optional: Invalidate stored credentials when the server indicates they're invalid.
		 */
		async invalidateCredentials(
			scope: "all" | "client" | "tokens" | "verifier",
		): Promise<void> {
			if (scope === "verifier") {
				oauthFlowStateStore.delete(configId);
				return;
			}

			if (scope === "tokens" || scope === "all") {
				await updateMcpConfigTokens({
					configId,
					encryptedAccessToken: null,
					accessTokenHash: null,
					encryptedRefreshToken: null,
					tokenExpiresAt: null,
				});
			}

			if (scope === "client" || scope === "all") {
				const { updateMcpConfigAfterDcr } = await import(
					"@repo/database"
				);
				await updateMcpConfigAfterDcr({
					configId,
					oauthClientId: null,
					encryptedOauthClientSecret: null,
					dcrClientMetadata: null,
					dcrRegistrationEndpoint: null,
					dcrRegisteredAt: null,
				});
			}
		},
	};

	return provider;
}

/**
 * Check if an MCP config has valid OAuth tokens without creating a full provider.
 * Useful for quick status checks.
 */
export async function hasValidOAuthTokens(configId: string): Promise<boolean> {
	const cfg = await getMcpConfigByIdInternal(configId);
	if (!cfg?.encryptedAccessToken) {
		return false;
	}

	// Check if token is expired
	if (cfg.tokenExpiresAt) {
		const now = Date.now();
		const expiresAt = cfg.tokenExpiresAt.getTime();
		// Consider expired if less than 60 seconds remaining
		if (expiresAt < now + 60 * 1000) {
			// Has refresh token? Might be refreshable
			return !!cfg.encryptedRefreshToken;
		}
	}

	return true;
}

/**
 * Clean up OAuth flow state for a config (e.g., after auth completes or fails).
 */
export function cleanupOAuthFlowState(configId: string): void {
	oauthFlowStateStore.delete(configId);
}

/**
 * Default token expiry (in seconds) for known OAuth servers that omit `expires_in`.
 * Only add servers here that are known to issue short-lived tokens.
 * For unknown servers, returns null to preserve `tokenExpiresAt: null`.
 */
const SERVER_DEFAULT_TOKEN_EXPIRY: Array<{
	hostname: string;
	expirySeconds: number;
}> = [
	{ hostname: "mcp.notion.com", expirySeconds: 3600 }, // Notion tokens expire in ~1 hour
];

function getServerDefaultTokenExpiry(
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
 * Known token endpoints for OAuth servers that don't support RFC 8414/9728 discovery.
 * Used as a fallback in the refresh path when cached metadata is unavailable.
 */
const KNOWN_TOKEN_ENDPOINTS: Array<{
	hostname: string;
	tokenEndpoint: string;
}> = [
	{
		hostname: "api.githubcopilot.com",
		tokenEndpoint: "https://github.com/login/oauth/access_token",
	},
	{
		hostname: "gitlab.com",
		tokenEndpoint: "https://gitlab.com/oauth/token",
	},
];

function getKnownTokenEndpoint(
	baseUrl: string | null | undefined,
): string | null {
	if (!baseUrl) {
		return null;
	}
	try {
		const parsed = new URL(baseUrl);
		for (const entry of KNOWN_TOKEN_ENDPOINTS) {
			if (parsed.hostname === entry.hostname) {
				return entry.tokenEndpoint;
			}
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Check if the OAuth client is a public client (no client_secret required).
 * Based on token_endpoint_auth_method from DCR response.
 */
function isPublicOAuthClient(cfg: { dcrClientMetadata?: unknown }): boolean {
	const metadata = cfg.dcrClientMetadata as Record<string, unknown> | null;
	const authMethod = metadata?.token_endpoint_auth_method;
	return authMethod === "none";
}
