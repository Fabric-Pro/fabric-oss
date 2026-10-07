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
	saveMcpOAuthRefresh,
	wipeMcpOAuthTokens,
} from "@repo/database";
import { decryptApiKey, encryptApiKey, hashApiKey } from "@repo/utils";
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

	/**
	 * The refresh-token ciphertext this instance last handed the SDK. The
	 * SDK's own refresh spends that token, so `saveTokens` writes only while
	 * the row still holds it.
	 */
	let handedRefreshCiphertext: string | null = null;

	const authorizationRequired = (message?: string) =>
		new OAuthAuthorizationRequiredError({
			configId,
			serverName,
			message,
		});

	/**
	 * Reload the config and fail closed unless it still holds the grant this
	 * instance was created for, bound to an authorization server.
	 */
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
	const clientOf = (row: StoredCredentials) => ({
		oauthClientId: row.oauthClientId,
		encryptedOauthClientSecret: row.encryptedOauthClientSecret,
	});
	/** The client stored when this instance handed out a refresh token. */
	let handedClient: ReturnType<typeof clientOf> | null = null;

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
				handedRefreshCiphertext = outcome.encryptedRefreshToken;
				// The refresh service wrote only while the stored client was
				// this one (its write is fenced on it).
				handedClient = clientOf(current);
				return {
					access_token: outcome.accessToken,
					token_type: outcome.tokenType,
					expires_in: outcome.expiresIn ?? undefined,
					refresh_token: outcome.refreshToken,
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

		// The SDK can send this refresh token itself (on a 401). Hand it out
		// only when the stored credential set is the one the binding was
		// written with — the same check the refresh service makes before
		// sending one.
		if (current.encryptedRefreshToken) {
			await requireIntactCredentials(current, binding);
		}
		const refreshToken = current.encryptedRefreshToken
			? decryptApiKey(current.encryptedRefreshToken)
			: undefined;
		handedRefreshCiphertext = current.encryptedRefreshToken;
		handedClient = clientOf(current);
		return {
			access_token: decryptApiKey(current.encryptedAccessToken),
			token_type: "Bearer",
			expires_in: tokenExpiresAt
				? Math.floor((tokenExpiresAt.getTime() - now) / 1000)
				: undefined,
			refresh_token: refreshToken,
			issuer: binding.authorizationServerUrl,
		} as OAuthTokens;
	}

	const provider: OAuthClientProvider = {
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
		 * Saves tokens the SDK obtained by refreshing (it only ever refreshes
		 * against the bound token endpoint, see `discoveryState`). Refuses a
		 * stamp that is not the bound AS, and writes only while the row still
		 * holds this grant and the refresh token this instance handed out.
		 */
		async saveTokens(tokens: OAuthTokens): Promise<void> {
			const { binding } = await loadBound();
			const issuer = (tokens as { issuer?: unknown }).issuer;
			if (
				typeof issuer !== "string" ||
				!sameAuthorizationServer(issuer, binding.authorizationServerUrl)
			) {
				throw authorizationRequired(
					`Refusing OAuth tokens for "${serverName}" that were not issued by its bound authorization server.`,
				);
			}
			if (!handedRefreshCiphertext || !handedClient) {
				// This instance never handed out a refresh token, so this is
				// not a refresh of its grant. Grants are saved only by the
				// connect flow.
				throw authorizationRequired();
			}

			const effectiveExpiresIn =
				tokens.expires_in ??
				getMcpServerDefaultTokenExpiry(serverBaseUrl) ??
				undefined;
			const encryptedRefreshToken = tokens.refresh_token
				? encryptApiKey(tokens.refresh_token)
				: handedRefreshCiphertext;
			const outcome = await saveMcpOAuthRefresh({
				configId,
				expectedGeneration: generation,
				expectedRefreshToken: handedRefreshCiphertext,
				tokens: {
					encryptedAccessToken: encryptApiKey(tokens.access_token),
					accessTokenHash: hashApiKey(tokens.access_token),
					encryptedRefreshToken,
					tokenExpiresAt: effectiveExpiresIn
						? new Date(Date.now() + effectiveExpiresIn * 1000)
						: null,
				},
				binding,
				// Written only while the stored client is still the one the
				// handed-out refresh token was checked with.
				client: handedClient,
			});
			if (outcome === "written") {
				handedRefreshCiphertext = encryptedRefreshToken;
			} else {
				console.log(
					"[OAuth Provider] Refreshed tokens dropped: the config's credentials changed meanwhile",
					{ configId },
				);
			}
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
		 * The SDK calls this when the AS rejects the grant (`tokens`) or the
		 * client (`all`). Each durable scope wipes the tokens, increments the
		 * grant generation and flags the config for reconnect, conditional on
		 * this instance's grant still being the config's; `client` and `all`
		 * also clear the client. The binding is kept: only the connect flow
		 * rebinds. `discovery` and `verifier` make no durable change.
		 */
		async invalidateCredentials(
			scope: "all" | "client" | "tokens" | "verifier" | "discovery",
		): Promise<void> {
			if (scope === "verifier") {
				oauthFlowStateStore.delete(configId);
				return;
			}
			if (scope === "discovery") {
				return;
			}
			await wipeMcpOAuthTokens({
				configId,
				expectedGeneration: generation,
				// A rejected refresh token that is no longer the row's (another
				// refresh rotated it) says nothing about the live one.
				...(scope === "tokens" && handedRefreshCiphertext
					? { expectedRefreshToken: handedRefreshCiphertext }
					: {}),
				clearClient: scope === "client" || scope === "all",
				needsReauth: true,
			});
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
