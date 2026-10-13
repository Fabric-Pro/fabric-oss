/**
 * Database-backed OAuth client provider for the MCP SDK transports.
 *
 * Implements `OAuthClientProvider` from `@modelcontextprotocol/sdk` (the
 * Streamable HTTP and SSE transports in `./client` are the SDK's, and they are
 * what call it). Every credential it hands the SDK is pinned to the
 * authorization server (AS) the config is bound to (`oauthBinding`):
 *
 * - `discoveryState()` returns that AS and its metadata, so the SDK's `auth()`
 *   never asks the MCP server where to send credentials;
 * - `tokens()` and `clientInformation()` carry `issuer` = the bound AS;
 * - every getter fails closed with `OAuthAuthorizationRequiredError` when the
 *   config is unbound or its grant generation moved since the provider was
 *   created (a cached client must not serve a newer or revoked grant);
 * - writes go through the credential module in `@repo/database`: a refresh is
 *   a compare-and-set, and no registration is ever created or replaced here.
 *
 * Fabric's shared refresh service (`refreshMcpOAuthAccessToken`) is the only
 * thing that refreshes these grants. `tokens()` never returns a refresh token,
 * and the SDK's `auth()` refreshes only when it gets one (SDK 1.32.1
 * `auth.js`, `if (tokens?.refresh_token)`), so on a 401 the SDK goes straight
 * to `redirectToAuthorization`, which throws `OAuthAuthorizationRequiredError`
 * on the server. The one refresh-and-resend after a 401 is Fabric's: the
 * transport fetch in `./client` calls `refreshAfterUnauthorized`.
 */

import type {
	OAuthClientProvider,
	OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
	credentialFingerprintMatches,
	getMcpConfigByIdInternal,
	getMcpServerDefaultTokenExpiry,
	isMcpOAuthBearerOnly,
	isPublicMcpOAuthClient,
	type McpOAuthBinding,
	markMcpOAuthReconnectRequired,
	parseMcpOAuthBinding,
	refreshMcpOAuthAccessToken,
	resolveMcpClientAuthMethod,
	sameAuthorizationServer,
} from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import {
	createGitLabConnectionAuthProvider,
	isGitLabPersonalMcpConfig,
} from "./gitlab-credential";

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
	/**
	 * The config's `oauthGrantGeneration` in the read the caller built its
	 * transport (URL, transport type) from. The provider then serves only that
	 * grant: if the row has moved on — a new URL or client retires the
	 * credentials and moves the generation — it fails closed instead of
	 * pairing the old URL with newer credentials or vice versa.
	 */
	expectedGrantGeneration?: number;
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
 * The provider `createOAuthClientProvider` returns for a config Fabric
 * refreshes itself. The transport fetch in `./client` calls
 * `refreshAfterUnauthorized` when the MCP server answers a request with 401.
 */
export interface FabricRefreshingOAuthClientProvider
	extends OAuthClientProvider {
	/**
	 * After the MCP server rejected `sentAccessToken` with a 401: the access
	 * token to resend with, or `null` to let the 401 stand (the SDK then ends
	 * it in `OAuthAuthorizationRequiredError`).
	 */
	refreshAfterUnauthorized(sentAccessToken: string): Promise<string | null>;
}

/** Whether `provider` can refresh after a 401 (see `refreshAfterUnauthorized`). */
export function isFabricRefreshingProvider(
	provider: OAuthClientProvider,
): provider is FabricRefreshingOAuthClientProvider {
	return (
		typeof (provider as Partial<FabricRefreshingOAuthClientProvider>)
			.refreshAfterUnauthorized === "function"
	);
}

/**
 * The SDK's `startAuthorization` dereferences `authorization_endpoint` and
 * `response_types_supported`; a binding written from a catalog entry or a
 * cache may lack them. Fill both with RFC 8414's defaults and force
 * `token_endpoint` to the binding's own.
 */
function sdkMetadataFor(binding: McpOAuthBinding): OAuthMetadata {
	const metadata = binding.authorizationServerMetadata;
	return {
		...metadata,
		issuer: metadata.issuer ?? binding.authorizationServerUrl,
		authorization_endpoint:
			metadata.authorization_endpoint ??
			new URL("/authorize", binding.authorizationServerUrl).href,
		token_endpoint: binding.tokenEndpoint,
		response_types_supported: metadata.response_types_supported ?? ["code"],
	} as OAuthMetadata;
}

/**
 * Creates the database-backed `OAuthClientProvider` the MCP SDK transports
 * use for an OAuth2 config.
 *
 * @example
 * ```typescript
 * const authProvider = await createOAuthClientProvider({
 *   configId: "config_123",
 *   userId: "user_456",
 *   organizationId: "org_789",
 *   redirectUri: "https://app.example.com/api/mcp/oauth/callback",
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
		expectedGrantGeneration,
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

	// GitLab personal servers: the credential is the person's GitLab
	// connection, owned (and refreshed) by the connection service. The SDK
	// must not refresh, store or invalidate anything for these configs.
	if (isGitLabPersonalMcpConfig(cfg)) {
		return createGitLabConnectionAuthProvider({
			config: cfg,
			userId,
			organizationId,
			redirectUri,
			clientMetadata,
			onAuthorizationRequired,
			authorizationRequired: (authorizationUrl) =>
				new OAuthAuthorizationRequiredError({
					configId,
					serverName,
					authorizationUrl: authorizationUrl.toString(),
				}),
		});
	}

	/**
	 * The grant this provider instance serves. A cached MCP client keeps its
	 * provider for minutes; once the config's credentials change (reconnect,
	 * revoke, re-registration, invalidation) this instance must not hand out
	 * whatever the row holds next.
	 */
	const generation = expectedGrantGeneration ?? cfg.oauthGrantGeneration;

	const authorizationRequired = (message?: string) =>
		new OAuthAuthorizationRequiredError({
			configId,
			serverName,
			message,
		});

	/**
	 * Reload the config and fail closed unless it still holds the grant this
	 * instance was created for, and that grant is either bound to an
	 * authorization server or an explicitly bearer-only import (a token
	 * imported by hand with no AS that may be trusted: served as a bearer
	 * until it expires, never refreshed, never used to authorize).
	 */
	async function loadCurrent() {
		const current = await getMcpConfigByIdInternal(configId);
		if (!current || current.oauthGrantGeneration !== generation) {
			throw authorizationRequired(
				`The OAuth connection for "${serverName}" changed. Reconnect or retry.`,
			);
		}
		const binding = parseMcpOAuthBinding(current.oauthBinding);
		const bearerOnly =
			!binding && isMcpOAuthBearerOnly(current.oauthBinding);
		if (!binding && !bearerOnly) {
			throw authorizationRequired(
				`OAuth authorization required for "${serverName}": reconnect it in MCP Settings to bind its credentials.`,
			);
		}
		return { current, binding, bearerOnly };
	}

	/** As `loadCurrent`, but only for a grant bound to an AS. */
	async function loadBound() {
		const { current, binding } = await loadCurrent();
		if (!binding) {
			// Bearer-only: there is no AS to authorize, refresh or register
			// with. The SDK reaches this on a 401 (its `auth()` asks for
			// `discoveryState()` first), so it ends in a reconnect prompt
			// without contacting any server.
			throw authorizationRequired(
				`The imported OAuth token for "${serverName}" is no longer accepted. Reconnect it in MCP Settings.`,
			);
		}
		return { current, binding };
	}

	// Unbound or moved on already: refuse before any transport is built.
	await loadCurrent();

	type StoredCredentials = {
		oauthClientId: string | null;
		encryptedOauthClientSecret: string | null;
		encryptedRefreshToken: string | null;
	};

	/**
	 * Fail closed — send nothing and flag the config for reconnect — unless
	 * the stored client id, client secret and refresh token are the set the
	 * binding was written with (its `credentialFingerprint`). A mismatch
	 * means a writer outside the credential module replaced one of them
	 * (the previous app version during a rolling deploy), so it may belong
	 * to another authorization server.
	 */
	async function requireIntactCredentials(
		current: StoredCredentials,
		binding: McpOAuthBinding,
	): Promise<void> {
		if (credentialFingerprintMatches(binding, current)) {
			return;
		}
		await markMcpOAuthReconnectRequired({
			configId,
			expectedGeneration: generation,
			reason: "Reconnect required: the stored OAuth credentials do not match the connection they were bound with.",
		});
		throw authorizationRequired();
	}

	/**
	 * The current access token, refreshed through the bound refresh path when
	 * it has expired (or is in the proactive window of a known short-lived
	 * server).
	 */
	async function readTokens(
		retryWhenSuperseded: boolean,
	): Promise<OAuthTokens | undefined> {
		const { current, binding, bearerOnly } = await loadCurrent();
		if (!current.encryptedAccessToken) {
			if (bearerOnly) {
				throw authorizationRequired();
			}
			return undefined;
		}

		const tokenExpiresAt = current.tokenExpiresAt;
		const now = Date.now();

		if (bearerOnly || !binding) {
			// The access token alone, until it expires: no refresh token, no
			// issuer, never a refresh.
			if (tokenExpiresAt && tokenExpiresAt.getTime() <= now) {
				throw authorizationRequired(
					`The imported OAuth token for "${serverName}" has expired. Reconnect it in MCP Settings.`,
				);
			}
			return {
				access_token: decryptApiKey(current.encryptedAccessToken),
				token_type: "Bearer",
				expires_in: tokenExpiresAt
					? Math.floor((tokenExpiresAt.getTime() - now) / 1000)
					: undefined,
			} as OAuthTokens;
		}
		// Expired, with a 60s buffer for clock skew.
		let isExpired = !!(
			tokenExpiresAt && tokenExpiresAt.getTime() < now + 60 * 1000
		);

		// For known short-lived-token servers with null tokenExpiresAt,
		// treat as hard-expired once past known lifetime.
		const knownExpiry = getMcpServerDefaultTokenExpiry(serverBaseUrl);
		const tokenAge = current.updatedAt
			? now - new Date(current.updatedAt).getTime()
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
			!!current.encryptedRefreshToken &&
			tokenAge > knownExpiry * 0.75 * 1000;

		if (isExpired || shouldProactivelyRefresh) {
			// Only a hard-expired token counts failures against the 3-strike
			// breaker; a soft-window miss falls through to the still-valid
			// current token.
			const outcome = await refreshMcpOAuthAccessToken(configId, {
				recordFailures: isExpired,
				expectedGeneration: generation,
			});
			if (outcome.status === "refreshed") {
				// No refresh token: see the module comment.
				return {
					access_token: outcome.accessToken,
					token_type: outcome.tokenType,
					expires_in: outcome.expiresIn ?? undefined,
					scope: outcome.scope ?? undefined,
					issuer: binding.authorizationServerUrl,
				} as OAuthTokens;
			}
			if (outcome.status === "reconnect-required") {
				throw authorizationRequired();
			}
			if (outcome.status === "superseded" && retryWhenSuperseded) {
				// Another refresh won, or the grant changed: read once more
				// (that read throws when the grant changed).
				return readTokens(false);
			}
			if (isExpired) {
				return undefined;
			}
		}

		// The access token only, never the refresh token (module comment).
		// The client and refresh token go to the token endpoint only from the
		// refresh service, which checks the credential fingerprint first. The
		// access token is checked here too: when the stored set is not the
		// one the binding was written with, the access token written
		// alongside may belong to another authorization server (the Google
		// Drive STDIO path refuses it on the same check).
		if (current.encryptedRefreshToken) {
			await requireIntactCredentials(current, binding);
		}
		return {
			access_token: decryptApiKey(current.encryptedAccessToken),
			token_type: "Bearer",
			expires_in: tokenExpiresAt
				? Math.floor((tokenExpiresAt.getTime() - now) / 1000)
				: undefined,
			issuer: binding.authorizationServerUrl,
		} as OAuthTokens;
	}

	/**
	 * The stored access token, when the config still holds this instance's
	 * grant, bound to an AS and not flagged for reconnect; otherwise `null`.
	 * A grant that changed or became unbound is `null` rather than an error:
	 * the 401 then stands, and the SDK's `auth()` fails closed on the same
	 * check (`discoveryState` → `loadBound`).
	 */
	async function storedAccessTokenOfThisGrant(): Promise<string | null> {
		let loaded: Awaited<ReturnType<typeof loadCurrent>>;
		try {
			loaded = await loadCurrent();
		} catch (error) {
			if (error instanceof OAuthAuthorizationRequiredError) {
				return null;
			}
			throw error;
		}
		const { current, binding } = loaded;
		if (!binding || current.needsReauth || !current.encryptedAccessToken) {
			return null;
		}
		// As `readTokens`: not an access token stored beside a credential set
		// its binding was not written with (this flags the config).
		if (current.encryptedRefreshToken) {
			try {
				await requireIntactCredentials(current, binding);
			} catch (error) {
				if (error instanceof OAuthAuthorizationRequiredError) {
					return null;
				}
				throw error;
			}
		}
		return decryptApiKey(current.encryptedAccessToken);
	}

	/**
	 * After the MCP server rejected `sentAccessToken`. Makes at most one
	 * token-endpoint call, through the shared refresh service, which counts a
	 * failure strike and condemns the grant only after its three-strike limit.
	 */
	async function refreshAfterUnauthorized(
		sentAccessToken: string,
	): Promise<string | null> {
		const stored = await storedAccessTokenOfThisGrant();
		if (stored === null) {
			// Bearer-only, needs reconnect, or the grant moved on: never
			// refreshed from here.
			return null;
		}
		if (stored !== sentAccessToken) {
			// Another caller or replica already refreshed after the token was
			// read: resend with that one, spending nothing.
			return stored;
		}
		const outcome = await refreshMcpOAuthAccessToken(configId, {
			recordFailures: true,
			expectedGeneration: generation,
		});
		if (outcome.status === "refreshed") {
			return outcome.accessToken;
		}
		// Superseded (another refresh won the compare-and-set, or the grant
		// changed), or failed: another replica's refresh may have rotated the
		// token, so this one's spend was rejected. Read once more: a newer
		// token of this grant is used, anything else lets the 401 stand.
		const reread = await storedAccessTokenOfThisGrant();
		return reread !== null && reread !== sentAccessToken ? reread : null;
	}

	const provider: FabricRefreshingOAuthClientProvider = {
		refreshAfterUnauthorized,

		/**
		 * The bound authorization server and its metadata, so `auth()` never
		 * re-discovers where to send credentials.
		 */
		async discoveryState(): Promise<OAuthDiscoveryState> {
			const { binding } = await loadBound();
			return {
				authorizationServerUrl: binding.authorizationServerUrl,
				authorizationServerMetadata: sdkMetadataFor(binding),
				...(binding.resource
					? { resourceMetadata: { resource: binding.resource } }
					: {}),
			};
		},

		/** The binding is written only by the connect flow. */
		async saveDiscoveryState(): Promise<void> {},

		/**
		 * Returns the current access token, refreshing it through the bound
		 * refresh path when it has expired (or is in the proactive window of a
		 * known short-lived server).
		 */
		async tokens(): Promise<OAuthTokens | undefined> {
			return readTokens(true);
		},

		/**
		 * Refuses everything. Tokens for these configs are written only by
		 * the connect flow and the shared refresh service; the SDK gets no
		 * refresh token to obtain new ones with, and an authorization-code
		 * exchange belongs to the connect flow, not to this provider.
		 */
		async saveTokens(): Promise<void> {
			throw authorizationRequired();
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
		 * Client metadata (the SDK reads it; registration never happens here).
		 */
		get clientMetadata(): OAuthClientMetadata {
			return clientMetadata;
		},

		/**
		 * The stored client, stamped with the bound AS. A config without a
		 * client fails closed: a background context never registers one.
		 */
		async clientInformation(): Promise<OAuthClientInformationMixed> {
			const { current, binding } = await loadBound();
			if (!current.oauthClientId) {
				throw authorizationRequired();
			}
			// The client id and secret go to the token endpoint: only the set
			// the binding was written with.
			await requireIntactCredentials(current, binding);
			const authMethod = resolveMcpClientAuthMethod(current);
			const info: Record<string, unknown> = {
				client_id: current.oauthClientId,
				token_endpoint_auth_method: authMethod,
				issuer: binding.authorizationServerUrl,
			};
			if (authMethod !== "none" && current.encryptedOauthClientSecret) {
				info.client_secret = decryptApiKey(
					current.encryptedOauthClientSecret,
				);
			}

			const dcrMetadata = current.dcrClientMetadata as {
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

			return info as OAuthClientInformationMixed;
		},

		/**
		 * The SDK calls this to re-stamp a client with the AS it was used
		 * with, or to save a registration it just made. Only the first is
		 * accepted, and only for the stored client (same id and secret) and
		 * the bound AS: there is nothing to write, since the binding already
		 * records the issuer and the stored metadata is kept. Anything else —
		 * a new or replaced registration, another AS — is refused: from a
		 * background context a registration is never created or replaced.
		 */
		async saveClientInformation(
			clientInfo: OAuthClientInformationMixed,
		): Promise<void> {
			const { current, binding } = await loadBound();
			const issuer = (clientInfo as { issuer?: unknown }).issuer;
			const sameClient =
				!!current.oauthClientId &&
				clientInfo.client_id === current.oauthClientId;
			let sameSecret = false;
			if (sameClient) {
				if (
					isPublicMcpOAuthClient(current) ||
					!current.encryptedOauthClientSecret
				) {
					sameSecret = !clientInfo.client_secret;
				} else {
					try {
						sameSecret =
							clientInfo.client_secret ===
							decryptApiKey(current.encryptedOauthClientSecret);
					} catch {
						sameSecret = false;
					}
				}
			}
			if (
				sameClient &&
				sameSecret &&
				typeof issuer === "string" &&
				sameAuthorizationServer(issuer, binding.authorizationServerUrl)
			) {
				return;
			}
			throw authorizationRequired(
				`Refusing to change the OAuth client registration for "${serverName}" outside the connect flow. Reconnect it in MCP Settings.`,
			);
		},

		/**
		 * Makes no durable change for any scope (`verifier` only drops this
		 * process's in-memory PKCE verifier). The SDK calls this when a token
		 * request it made is rejected (`invalid_grant`, `invalid_client`). It
		 * no longer refreshes (`tokens()` hands it no refresh token), and no
		 * Fabric code asks it for an authorization-code exchange (nothing
		 * calls the SDK's `auth()` with a code or a transport's `finishAuth`;
		 * checked by search when this was written, not by a test). A
		 * wipe here would also skip the strike count and could beat a
		 * concurrent refresh's compare-and-set, forcing a reconnect on a lost
		 * race. Only the refresh service's three-strike limit and an explicit
		 * revoke or reconnect condemn a grant.
		 */
		async invalidateCredentials(
			scope: "all" | "client" | "tokens" | "verifier" | "discovery",
		): Promise<void> {
			if (scope === "verifier") {
				oauthFlowStateStore.delete(configId);
			}
		},
	};

	return provider;
}

/**
 * Clean up OAuth flow state for a config (e.g., after auth completes or fails).
 */
export function cleanupOAuthFlowState(configId: string): void {
	oauthFlowStateStore.delete(configId);
}
