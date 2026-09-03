import { ORPCError } from "@orpc/server";
import {
	clearRefreshFailures,
	createOauthState,
	db,
	deleteOauthState,
	getCachedOAuthMetadata,
	getGoogleAccountEmail,
	getMcpConfigByIdInternal,
	getOauthState,
	getOrganizationById,
	updateMcpConfigTokens,
	updateOAuthMetadataCache,
} from "@repo/database";
import { triggerMcpToolIngestion } from "@repo/temporal";
import { decryptApiKey, encryptApiKey, hashApiKey } from "@repo/utils";
import {
	assertSafeOutboundUrl,
	safeFetchOutbound,
} from "@repo/utils/url-security";
import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import {
	discoverOAuthEndpoints as discoverOAuthEndpointsRFC,
	generateCodeChallenge,
	generateCodeVerifier,
	generateStructuredState,
	type MCPOAuthMetadata,
} from "../lib/oauth-discovery";

/**
 * Derive OAuth discovery URL from MCP base URL
 */
function deriveDiscoveryUrlFromBaseUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	return url.origin;
}

/**
 * Check if the OAuth client is a public client (no client_secret required)
 * Based on token_endpoint_auth_method from DCR response
 */
function isPublicOAuthClient(cfg: { dcrClientMetadata?: unknown }): boolean {
	const metadata = cfg.dcrClientMetadata as Record<string, unknown> | null;
	const authMethod = metadata?.token_endpoint_auth_method;
	return authMethod === "none";
}

/**
 * Known MCP servers that use OAuth client allowlists.
 * These servers accept DCR registration but only authorize pre-approved clients.
 * Third-party apps like Fabric Portal cannot use OAuth with these servers.
 */
const OAUTH_ALLOWLIST_SERVERS: Array<{
	pattern: RegExp;
	name: string;
	alternativeAuth: string;
	docsUrl?: string;
}> = [
	{
		pattern: /^https?:\/\/mcp\.vercel\.com/i,
		name: "Vercel MCP",
		alternativeAuth:
			"Use the Vercel CLI MCP (npx -y @vercel/mcp) with API key authentication instead",
		docsUrl: "https://vercel.com/docs/mcp/vercel-mcp",
	},
	{
		pattern: /^https?:\/\/mcp\.figma\.com/i,
		name: "Figma MCP",
		alternativeAuth:
			"Figma's remote MCP server only allows pre-approved OAuth clients (Claude, Cursor). Use the community Figma MCP server (npx figma-developer/figma-mcp) with a Personal Access Token instead",
		docsUrl:
			"https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens",
	},
];

/**
 * Check if a URL belongs to an MCP server that uses OAuth client allowlists
 */
function getOAuthAllowlistInfo(
	baseUrl: string | null | undefined,
): (typeof OAUTH_ALLOWLIST_SERVERS)[0] | null {
	if (!baseUrl) {
		return null;
	}
	for (const server of OAUTH_ALLOWLIST_SERVERS) {
		if (server.pattern.test(baseUrl)) {
			return server;
		}
	}
	return null;
}

/**
 * Hostname-keyed error messages for OAuth credential failures.
 *
 * Surface a server-specific, actionable message instead of the generic
 * "OAuth client ID not configured" when DCR has demonstrably failed and we
 * can identify the upstream MCP server from `cfg.baseUrl` or `server.key`.
 *
 * Mirrors `ENV_OAUTH_CREDENTIALS` (hostname-first, then serverKey) so the
 * lookup is strict — no suffix-match attacks on lookalike domains.
 */
const OAUTH_CREDENTIAL_ERROR_MESSAGES: Array<{
	hostname?: string;
	serverKey?: string;
	message: string;
}> = [
	{
		hostname: "mcp.atlassian.com",
		serverKey: "atlassian",
		message:
			"Could not register Fabric with Atlassian's MCP server. Retry from the tile; if it keeps failing, contact your Fabric administrator and reference the Atlassian connection.",
	},
];

/**
 * Resolve a server-specific OAuth-credential error message for the given
 * config, or `null` if no registry entry matches. Hostname match takes
 * precedence over serverKey (mirrors `getEnvOAuthCredentials`).
 */
export function getOAuthCredentialErrorMessage(
	baseUrl: string | null | undefined,
	serverKey: string | null | undefined,
): string | null {
	// Try strict hostname match first (for HTTP/SSE servers with a baseUrl).
	if (baseUrl) {
		try {
			const parsed = new URL(baseUrl);
			if (parsed.protocol === "https:" || parsed.protocol === "http:") {
				for (const entry of OAUTH_CREDENTIAL_ERROR_MESSAGES) {
					if (entry.hostname && parsed.hostname === entry.hostname) {
						return entry.message;
					}
				}
			}
		} catch {
			// Invalid URL — fall through to serverKey match.
		}
	}
	// Then fall back to serverKey (for STDIO or unrecognised baseUrl shapes).
	if (serverKey) {
		for (const entry of OAUTH_CREDENTIAL_ERROR_MESSAGES) {
			if (entry.serverKey && entry.serverKey === serverKey) {
				return entry.message;
			}
		}
	}
	return null;
}

/**
 * Known MCP servers that don't support DCR but can use pre-configured
 * OAuth credentials from environment variables.
 *
 * These servers expose proper OAuth discovery (RFC 9728/8414) but have
 * no registration_endpoint, so clients must be pre-registered.
 */
const ENV_OAUTH_CREDENTIALS: Array<{
	hostname?: string;
	serverKey?: string;
	clientIdEnvVar: string;
	clientSecretEnvVar: string;
}> = [
	{
		hostname: "mcp.slack.com",
		clientIdEnvVar: "SLACK_CLIENT_ID",
		clientSecretEnvVar: "SLACK_CLIENT_SECRET",
	},
	{
		hostname: "api.githubcopilot.com",
		clientIdEnvVar: "FABRIC_GITHUB_CLIENT_ID",
		clientSecretEnvVar: "FABRIC_GITHUB_CLIENT_SECRET",
	},
	{
		serverKey: "google-drive",
		clientIdEnvVar: "GOOGLE_CLIENT_ID",
		clientSecretEnvVar: "GOOGLE_CLIENT_SECRET",
	},
	{
		serverKey: "gitlab",
		clientIdEnvVar: "GITLAB_CLIENT_ID",
		clientSecretEnvVar: "GITLAB_CLIENT_SECRET",
	},
];

/**
 * Known OAuth endpoints for MCP servers that don't support RFC 9728/8414 discovery.
 * Used as a fallback when both server.oauthAuthorizationEndpoint and discovery fail.
 */
const KNOWN_OAUTH_ENDPOINTS: Array<{
	hostname?: string;
	serverKey?: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
}> = [
	{
		hostname: "api.githubcopilot.com",
		authorizationEndpoint: "https://github.com/login/oauth/authorize",
		tokenEndpoint: "https://github.com/login/oauth/access_token",
	},
	{
		serverKey: "gitlab",
		authorizationEndpoint: "https://gitlab.com/oauth/authorize",
		tokenEndpoint: "https://gitlab.com/oauth/token",
	},
];

/**
 * Default OAuth scopes for known servers that don't advertise scopes_supported
 * in their discovery document. Without these, the authorization URL gets an
 * empty scope parameter and the provider only grants minimal (public) access.
 */
const KNOWN_DEFAULT_SCOPES: Array<{
	hostname?: string;
	serverKey?: string;
	scopes: string[];
}> = [
	{
		hostname: "api.githubcopilot.com",
		scopes: ["repo", "read:org", "read:user"],
	},
	{
		serverKey: "google-drive",
		scopes: [
			"https://www.googleapis.com/auth/drive.readonly",
			"https://www.googleapis.com/auth/userinfo.profile",
			"https://www.googleapis.com/auth/userinfo.email",
		],
	},
	{
		serverKey: "gitlab",
		scopes: ["api", "read_user"],
	},
];

/**
 * Default token expiry (in seconds) for OAuth servers that omit `expires_in`.
 * Only add servers here that are known to issue short-lived tokens without
 * including `expires_in` in the response. For unknown servers, we preserve
 * `tokenExpiresAt: null` to avoid prematurely expiring long-lived tokens.
 */
const SERVER_DEFAULT_TOKEN_EXPIRY: Array<{
	hostname: string;
	expirySeconds: number;
}> = [
	{ hostname: "mcp.notion.com", expirySeconds: 3600 }, // Notion tokens expire in ~1 hour
];

/**
 * Get default token expiry for a known server when `expires_in` is missing.
 * Returns null for unknown servers (preserves null tokenExpiresAt).
 */
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
 * Get default scopes for a known server when discovery doesn't provide them.
 */
function getKnownDefaultScopes(
	baseUrl: string | null | undefined,
	serverKey?: string | null,
): string[] | null {
	// Try hostname match first (for HTTP/SSE servers with a baseUrl)
	if (baseUrl) {
		try {
			const parsed = new URL(baseUrl);
			for (const entry of KNOWN_DEFAULT_SCOPES) {
				if (entry.hostname && parsed.hostname === entry.hostname) {
					return entry.scopes;
				}
			}
		} catch {
			// Invalid URL, fall through to serverKey match
		}
	}
	// Then try server key match (for STDIO servers with no baseUrl)
	if (serverKey) {
		for (const entry of KNOWN_DEFAULT_SCOPES) {
			if (entry.serverKey && entry.serverKey === serverKey) {
				return entry.scopes;
			}
		}
	}
	return null;
}

/**
 * Get known OAuth endpoints for servers that don't support standard discovery.
 */
function getKnownOAuthEndpoints(
	baseUrl: string | null | undefined,
	serverKey?: string | null,
): { authorizationEndpoint: string; tokenEndpoint: string } | null {
	for (const entry of KNOWN_OAUTH_ENDPOINTS) {
		if (entry.serverKey && serverKey && entry.serverKey === serverKey) {
			return {
				authorizationEndpoint: entry.authorizationEndpoint,
				tokenEndpoint: entry.tokenEndpoint,
			};
		}
	}
	if (!baseUrl) {
		return null;
	}
	try {
		const parsed = new URL(baseUrl);
		for (const entry of KNOWN_OAUTH_ENDPOINTS) {
			if (entry.hostname && parsed.hostname === entry.hostname) {
				return {
					authorizationEndpoint: entry.authorizationEndpoint,
					tokenEndpoint: entry.tokenEndpoint,
				};
			}
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Get pre-configured OAuth credentials from environment variables
 * for known MCP servers that don't support DCR.
 * Uses strict hostname matching to prevent credential leakage to lookalike domains.
 */
function getEnvOAuthCredentials(
	baseUrl: string | null | undefined,
	serverKey?: string | null,
): { clientId: string; clientSecret: string } | null {
	// Try hostname match first (for HTTP/SSE servers with a baseUrl)
	if (baseUrl) {
		try {
			const parsed = new URL(baseUrl);
			if (parsed.protocol === "https:" || parsed.protocol === "http:") {
				for (const entry of ENV_OAUTH_CREDENTIALS) {
					if (entry.hostname && parsed.hostname === entry.hostname) {
						const clientId = process.env[entry.clientIdEnvVar];
						const clientSecret =
							process.env[entry.clientSecretEnvVar];
						if (clientId && clientSecret) {
							return { clientId, clientSecret };
						}
					}
				}
			}
		} catch {
			// Invalid URL, fall through to serverKey match
		}
	}
	// Then try server key match (for STDIO servers with no baseUrl)
	if (serverKey) {
		for (const entry of ENV_OAUTH_CREDENTIALS) {
			if (entry.serverKey && entry.serverKey === serverKey) {
				const clientId = process.env[entry.clientIdEnvVar];
				const clientSecret = process.env[entry.clientSecretEnvVar];
				if (clientId && clientSecret) {
					return { clientId, clientSecret };
				}
			}
		}
	}
	return null;
}

/**
 * Discovery function using RFC 9728/8414
 * Returns legacy-compatible format for backward compatibility
 */
async function discoverOAuthEndpoints(baseUrlOrDiscoveryUrl?: string | null) {
	if (!baseUrlOrDiscoveryUrl) {
		return null;
	}
	try {
		const url = new URL(baseUrlOrDiscoveryUrl);
		assertSafeOutboundUrl(url.toString());

		// If the URL is a direct well-known endpoint (e.g., OIDC discovery URL),
		// fetch it directly instead of going through RFC 9728 discovery
		if (url.pathname.includes("/.well-known/")) {
			const res = await safeFetchOutbound(baseUrlOrDiscoveryUrl, {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(10000),
			});
			if (!res.ok) {
				return null;
			}
			const json = (await res.json()) as Record<string, unknown>;
			return {
				authorization_endpoint: json.authorization_endpoint as
					| string
					| undefined,
				token_endpoint: json.token_endpoint as string | undefined,
				registration_endpoint: json.registration_endpoint as
					| string
					| undefined,
				scopes_supported:
					(json.scopes_supported as string[] | undefined) ?? [],
			};
		}

		// Otherwise, use RFC 9728/8414 discovery from origin
		const result = await discoverOAuthEndpointsRFC(url.origin);
		if (!result.success || !result.metadata) {
			return null;
		}
		return {
			authorization_endpoint: result.metadata.authorizationEndpoint,
			token_endpoint: result.metadata.tokenEndpoint,
			registration_endpoint: result.metadata.registrationEndpoint,
			scopes_supported: result.metadata.scopesSupported ?? [],
		};
	} catch (error) {
		console.error(
			`OAuth discovery failed for ${baseUrlOrDiscoveryUrl}:`,
			error,
		);
		return null;
	}
}

export const oauthProcedures = {
	start: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_CONNECT))
		.route({
			method: "POST",
			path: "/mcp/oauth/start",
			tags: ["MCP"],
			summary: "Start OAuth flow for MCP server",
		})
		.input(
			z.object({
				configId: z.string(),
				redirectUri: z.string().url(),
				autoDiscoverAndRegister: z.boolean().optional(),
			}),
		)
		.output(
			z.object({ authorizationUrl: z.string().url(), state: z.string() }),
		)
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			// Use internal version - authorization is done below based on config ownership
			let cfg = await getMcpConfigByIdInternal(input.configId);

			if (!cfg) {
				throw new ORPCError("NOT_FOUND", {
					message: "MCP config not found",
				});
			}

			if (cfg.userId) {
				if (cfg.userId !== userId) {
					throw new ORPCError("FORBIDDEN", {
						message: "You do not have access to this MCP config",
					});
				}
			} else if (cfg.organizationId) {
				const organizationId = cfg.organizationId;
				const organization = await getOrganizationById(organizationId);

				if (!organization) {
					throw new ORPCError("NOT_FOUND", {
						message: "Organization not found",
					});
				}

				const membership = await verifyOrganizationMembership(
					organizationId,
					userId,
				);

				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}

				if (
					membership.role !== "admin" &&
					membership.role !== "owner"
				) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Only organization admins can manage OAuth for this MCP config",
					});
				}
			} else {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message:
						"MCP config must belong to a user or an organization",
				});
			}

			const server = cfg.mcpServer as any;

			// Check if this MCP server uses an OAuth client allowlist
			// These servers accept DCR but only authorize pre-approved clients
			const allowlistInfo = getOAuthAllowlistInfo(cfg.baseUrl);
			if (allowlistInfo) {
				throw new ORPCError("BAD_REQUEST", {
					message: `${allowlistInfo.name} only allows pre-approved OAuth clients and does not support third-party applications. ${allowlistInfo.alternativeAuth}`,
				});
			}

			// Attempt automatic discovery and DCR if credentials are missing and auto mode is enabled
			if (
				input.autoDiscoverAndRegister &&
				cfg.baseUrl &&
				(!cfg.oauthClientId || !cfg.encryptedOauthClientSecret)
			) {
				try {
					// Derive discovery URL from base URL
					const discoveryUrl = deriveDiscoveryUrlFromBaseUrl(
						cfg.baseUrl,
					);

					// Fetch OpenID Connect configuration
					const discovery =
						await discoverOAuthEndpoints(discoveryUrl);

					if (discovery?.registration_endpoint) {
						// Perform DCR registration
						// IMPORTANT: client_name should be OUR app name, not the MCP server name
						// This identifies us as the OAuth client connecting to the server
						const metadata: Record<string, any> = {
							client_name: "Fabric Portal",
							redirect_uris: [input.redirectUri],
							grant_types: [
								"authorization_code",
								"refresh_token",
							],
							response_types: ["code"],
							token_endpoint_auth_method: "client_secret_basic",
						};

						if (cfg.scopes && cfg.scopes.length > 0) {
							metadata.scope = cfg.scopes.join(" ");
						}

						console.log(
							`[OAuth DCR] Attempting registration at ${discovery.registration_endpoint}`,
							{ metadata },
						);

						const res = await safeFetchOutbound(
							discovery.registration_endpoint,
							{
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify(metadata),
							},
						);

						const json = (await res
							.json()
							.catch(() => null as any)) as any;

						// Log the response for debugging
						console.log(
							`[OAuth DCR] Registration response: status=${res.status}`,
							{
								endpoint: discovery.registration_endpoint,
								response: json,
							},
						);

						if (!res.ok) {
							console.error(
								`[OAuth DCR] Registration failed with status ${res.status}`,
								{
									endpoint: discovery.registration_endpoint,
									response: json,
									error: json?.error,
									errorDescription: json?.error_description,
									clientName: metadata.client_name,
								},
							);
						}

						if (res.ok && json) {
							const clientId =
								(json.client_id as string | undefined) ?? null;
							const clientSecret =
								(json.client_secret as string | undefined) ??
								null;

							if (clientId) {
								// Update config with DCR credentials
								const { updateMcpConfigAfterDcr } =
									await import("@repo/database");

								const sanitizedMetadata: Record<string, any> = {
									...json,
								};
								delete sanitizedMetadata.client_secret;

								await updateMcpConfigAfterDcr({
									configId: cfg.id,
									oauthClientId: clientId,
									encryptedOauthClientSecret: clientSecret
										? encryptApiKey(clientSecret)
										: null,
									dcrRegistrationEndpoint:
										discovery.registration_endpoint,
									dcrClientMetadata: sanitizedMetadata,
									dcrRegisteredAt: new Date(),
								});

								// Refresh config to get updated credentials
								const updatedCfg =
									await getMcpConfigByIdInternal(
										input.configId,
									);
								if (!updatedCfg) {
									throw new ORPCError(
										"INTERNAL_SERVER_ERROR",
										{
											message:
												"Failed to refresh config after DCR",
										},
									);
								}
								cfg = updatedCfg;
							}
						}
					}
				} catch (error: any) {
					// Log error but don't fail - user can still provide manual credentials
					console.error("Automatic DCR failed:", error);
				}
			}

			// Fallback: If DCR didn't populate credentials, try pre-configured env var credentials
			// for known servers that don't support DCR (e.g., Slack)
			// Only fill fields that are actually missing to avoid clobbering user-provided values
			if (!cfg.oauthClientId || !cfg.encryptedOauthClientSecret) {
				const envCreds = getEnvOAuthCredentials(
					cfg.baseUrl,
					server.key,
				);
				if (envCreds) {
					const needsClientId = !cfg.oauthClientId;
					const needsClientSecret = !cfg.encryptedOauthClientSecret;
					console.log(
						`[OAuth] Using pre-configured env credentials for ${cfg.baseUrl} (clientId: ${needsClientId ? "from env" : "existing"}, secret: ${needsClientSecret ? "from env" : "existing"})`,
					);
					const { updateMcpConfigAfterDcr } = await import(
						"@repo/database"
					);
					await updateMcpConfigAfterDcr({
						configId: cfg.id,
						oauthClientId: needsClientId
							? envCreds.clientId
							: cfg.oauthClientId,
						encryptedOauthClientSecret: needsClientSecret
							? encryptApiKey(envCreds.clientSecret)
							: cfg.encryptedOauthClientSecret,
					});
					// Refresh config to pick up the new credentials
					const updatedCfg = await getMcpConfigByIdInternal(
						input.configId,
					);
					if (updatedCfg) {
						cfg = updatedCfg;
					}
				}
			}

			// Discover OAuth endpoints
			// Priority: server.oauthDiscoveryUrl > derive from cfg.baseUrl (automatic mode)
			let discoveryUrl = server.oauthDiscoveryUrl;
			if (!discoveryUrl && cfg.baseUrl) {
				// Automatic mode: derive discovery URL from base URL
				discoveryUrl = deriveDiscoveryUrlFromBaseUrl(cfg.baseUrl);
			}

			const discovery = await discoverOAuthEndpoints(
				discoveryUrl ?? null,
			);
			// Resolve authorization endpoint:
			// 1. Server record (enterprise seed)
			// 2. Discovery (RFC 9728/8414)
			// 3. Known endpoints fallback (for servers without discovery support)
			const knownEndpoints = getKnownOAuthEndpoints(
				cfg.baseUrl,
				server.key,
			);
			const authorizationEndpoint =
				server.oauthAuthorizationEndpoint ??
				discovery?.authorization_endpoint ??
				knownEndpoints?.authorizationEndpoint;

			if (!authorizationEndpoint) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Authorization endpoint not available - please configure OAuth discovery URL or authorization endpoint",
				});
			}

			// Auto-populate scopes for known servers.
			// Applies to servers with env credentials OR servers with known default scopes
			// (e.g., GitLab needs api+read_user even when using DCR without env vars).
			const isKnownEnvServer =
				getEnvOAuthCredentials(cfg.baseUrl, server.key) !== null;
			const hasKnownScopes =
				getKnownDefaultScopes(cfg.baseUrl, server.key) !== null;
			if (
				(isKnownEnvServer || hasKnownScopes) &&
				(!cfg.scopes || cfg.scopes.length === 0)
			) {
				// Prefer known default scopes over discovery's scopes_supported.
				// Discovery endpoints (e.g. Google's OpenID) often return generic scopes
				// (openid, email, profile) that don't include service-specific permissions
				// like Drive read access.
				const knownScopes = getKnownDefaultScopes(
					cfg.baseUrl,
					server.key,
				);
				const scopesToUse =
					knownScopes && knownScopes.length > 0
						? knownScopes
						: discovery?.scopes_supported &&
								discovery.scopes_supported.length > 0
							? discovery.scopes_supported
							: null;

				if (scopesToUse && scopesToUse.length > 0) {
					console.log(
						`[OAuth] Auto-populating ${scopesToUse.length} scopes for ${cfg.baseUrl}`,
					);
					await db.mCPConfig.update({
						where: { id: cfg.id },
						data: { scopes: scopesToUse },
					});
					cfg = {
						...cfg,
						scopes: scopesToUse,
					};
				}
			}

			// For public OAuth clients (token_endpoint_auth_method: 'none'), client_secret is not required
			const isPublicClient = isPublicOAuthClient(cfg);
			if (!cfg.oauthClientId) {
				const hostMessage = getOAuthCredentialErrorMessage(
					cfg.baseUrl,
					server.key,
				);
				throw new ORPCError("BAD_REQUEST", {
					message:
						hostMessage ??
						"OAuth client ID not configured - automatic registration failed or is not supported by this server",
				});
			}
			if (!isPublicClient && !cfg.encryptedOauthClientSecret) {
				const hostMessage = getOAuthCredentialErrorMessage(
					cfg.baseUrl,
					server.key,
				);
				throw new ORPCError("BAD_REQUEST", {
					message:
						hostMessage ??
						"OAuth client secret not configured - automatic registration failed or is not supported by this server",
				});
			}

			// Generate enhanced PKCE with 96-byte verifier (128 chars)
			const codeVerifier = generateCodeVerifier();
			const codeChallenge = generateCodeChallenge(codeVerifier);

			// Generate structured state with embedded context
			const _structuredState = generateStructuredState({
				serverId: server.id,
				configId: cfg.id,
				userId,
				organizationId: cfg.organizationId ?? undefined,
			});

			// For Google Drive MCP: reuse the Better Auth Google callback redirect URI
			// so we don't need to register an additional redirect URI in Google Cloud Console.
			let effectiveRedirectUri = input.redirectUri;
			if (server.key === "google-drive") {
				let origin: string;
				try {
					origin = new URL(input.redirectUri).origin;
				} catch {
					throw new ORPCError("BAD_REQUEST", {
						message: "Invalid redirect URI",
					});
				}
				effectiveRedirectUri = `${origin}/api/auth/callback/google`;
			}

			// Also store in DB for backward compatibility and additional validation
			const state = await createOauthState({
				mcpServerId: server.id,
				configId: cfg.id,
				userId,
				organizationId: cfg.organizationId ?? undefined,
				codeVerifier,
				redirectUri: effectiveRedirectUri,
			});

			// Use the DB state as the primary state (contains the structured payload internally)
			const params = new URLSearchParams({
				response_type: "code",
				client_id: cfg.oauthClientId,
				redirect_uri: effectiveRedirectUri,
				scope: (cfg.scopes || []).join(" "),
				state,
				code_challenge: codeChallenge,
				code_challenge_method: "S256",
			});

			// For Google Drive MCP: streamline the consent screen by hinting the
			// user's existing Google login and requesting incremental scopes.
			if (server.key === "google-drive") {
				const googleEmail = await getGoogleAccountEmail(userId);
				if (googleEmail) {
					params.set("login_hint", googleEmail);
				}
				params.set("include_granted_scopes", "true");
				params.set("access_type", "offline");
				params.set("prompt", "consent");
			}

			const authorizationUrl = `${authorizationEndpoint}?${params.toString()}`;
			return { authorizationUrl, state };
		}),

	callback: publicProcedure
		.use(requirePermission(Permissions.MCP_UPDATE))
		.route({
			method: "GET",
			path: "/mcp/oauth/callback",
			tags: ["MCP"],
			summary: "Handle OAuth callback",
		})
		.input(
			z.object({
				code: z.string().optional(),
				state: z.string().optional(),
				error: z.string().optional(),
			}),
		)
		.output(
			z.object({
				success: z.boolean(),
				message: z.string(),
				// Auto-chain hop. When the primary OAuth that just completed
				// is an Atlassian (Rovo MCP) connect AND the hybrid
				// Atlassian Cloud 3LO is configured AND this config doesn't
				// already have Cloud tokens, we compute the Cloud
				// authorization URL server-side here and return it. The
				// callback HTML route then redirects the popup to that
				// URL instead of closing — the user sees a single
				// continuous flow: one click → Rovo consent → Cloud
				// consent → done. Failure-proof: any error in computing
				// the chain hop leaves this field undefined and the popup
				// closes as today.
				chainTo: z
					.object({
						type: z.literal("atlassian_cloud"),
						authorizationUrl: z.string().url(),
					})
					.optional(),
			}),
		)
		.handler(async ({ input }) => {
			if (input.error) {
				return { success: false, message: input.error };
			}

			if (!input.state || !input.code) {
				return { success: false, message: "Missing state or code" };
			}

			const stateRecord = await getOauthState(input.state);
			if (!stateRecord) {
				return { success: false, message: "Invalid state" };
			}

			// Check if state is expired
			const currentTime = new Date();
			if (stateRecord.expiresAt && stateRecord.expiresAt < currentTime) {
				await deleteOauthState(input.state); // Clean up expired state
				return {
					success: false,
					message: "OAuth state expired - please try again",
				};
			}

			// Use internal version - state record already verified user started this flow
			const cfg = await getMcpConfigByIdInternal(stateRecord.configId);
			if (!cfg) {
				return { success: false, message: "Config not found" };
			}

			// Verify organization context matches to prevent cross-tenant token injection
			// stateRecord.organizationId is null for personal, string for org
			// cfg.organizationId is null for personal, string for org
			if (stateRecord.organizationId !== cfg.organizationId) {
				return {
					success: false,
					message:
						"Organization context mismatch - OAuth flow was initiated in a different context",
				};
			}

			const server = cfg.mcpServer as any;

			// Try to use cached OAuth metadata first, then fall back to discovery
			let tokenEndpoint: string | undefined;
			let _oauthMetadata: MCPOAuthMetadata | null = null;

			// Check for cached metadata
			const cachedMetadata = await getCachedOAuthMetadata({
				configId: cfg.id,
			});
			if (cachedMetadata?.tokenEndpoint) {
				tokenEndpoint = cachedMetadata.tokenEndpoint as string;
				_oauthMetadata = cachedMetadata as MCPOAuthMetadata;
			}

			// If no cached metadata, discover OAuth endpoints using RFC 9728/8414
			// Priority: server.oauthDiscoveryUrl > derive from cfg.baseUrl or server.defaultUrl
			if (!tokenEndpoint) {
				let discoveryUrl = server.oauthDiscoveryUrl;
				const effectiveBaseUrl = cfg.baseUrl || server.defaultUrl;
				if (!discoveryUrl && effectiveBaseUrl) {
					discoveryUrl =
						deriveDiscoveryUrlFromBaseUrl(effectiveBaseUrl);
				}
				if (discoveryUrl) {
					const discovery =
						await discoverOAuthEndpoints(discoveryUrl);
					if (discovery?.token_endpoint) {
						tokenEndpoint = discovery.token_endpoint;
						_oauthMetadata =
							discovery as unknown as MCPOAuthMetadata;

						// Cache the discovered metadata for future use
						await updateOAuthMetadataCache({
							configId: cfg.id,
							metadata: discovery as unknown as Record<
								string,
								unknown
							>,
						});
					}
				}
			}

			// Fall back to server-configured endpoints, then known endpoints.
			// Track whether we sourced the endpoint from KNOWN_OAUTH_ENDPOINTS so we
			// can decide later whether to cache it (see the cache-write block below).
			let tokenEndpointFromKnownEndpoints = false;
			if (!tokenEndpoint) {
				tokenEndpoint = server.oauthTokenEndpoint;
			}
			if (!tokenEndpoint) {
				const baseUrl = cfg.baseUrl || server.defaultUrl;
				tokenEndpoint = getKnownOAuthEndpoints(
					baseUrl,
					server.key,
				)?.tokenEndpoint;
				if (tokenEndpoint) {
					tokenEndpointFromKnownEndpoints = true;
				}
			}

			if (!tokenEndpoint) {
				return {
					success: false,
					message: "Token endpoint not available",
				};
			}
			assertSafeOutboundUrl(tokenEndpoint);

			// For public OAuth clients (token_endpoint_auth_method: 'none'), client_secret is not required
			const isPublicClient = isPublicOAuthClient(cfg);
			if (!cfg.oauthClientId) {
				return {
					success: false,
					message: "OAuth client ID not configured",
				};
			}
			if (!isPublicClient && !cfg.encryptedOauthClientSecret) {
				return {
					success: false,
					message: "OAuth client secret not configured",
				};
			}

			const body = new URLSearchParams({
				grant_type: "authorization_code",
				code: input.code,
				redirect_uri: stateRecord.redirectUri || "",
				client_id: cfg.oauthClientId,
			});
			// Only include client_secret for confidential clients
			if (!isPublicClient && cfg.encryptedOauthClientSecret) {
				const clientSecret = decryptApiKey(
					cfg.encryptedOauthClientSecret,
				);
				body.set("client_secret", clientSecret);
			}
			if (stateRecord.codeVerifier) {
				body.set("code_verifier", stateRecord.codeVerifier);
			}

			const res = await safeFetchOutbound(tokenEndpoint, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					accept: "application/json",
				},
				body,
			});
			const json = await res.json().catch(() => null as any);

			if (!res.ok || !json) {
				const errorMsg =
					json?.error_description ||
					json?.error ||
					`HTTP ${res.status}`;
				return {
					success: false,
					message: `Token exchange failed: ${errorMsg}`,
				};
			}

			const accessToken = json.access_token as string | undefined;
			const refreshToken =
				(json.refresh_token as string | undefined) ?? null;
			const expiresIn =
				(json.expires_in as number | undefined) ?? undefined;

			if (!accessToken) {
				return {
					success: false,
					message: "No access_token in response",
				};
			}

			// Use server-specific default expiry for known servers that omit expires_in
			// (e.g. Notion). For unknown servers, preserve null to avoid expiring long-lived tokens.
			const serverBaseUrl = cfg.baseUrl || server.defaultUrl;
			const serverDefaultExpiry =
				getServerDefaultTokenExpiry(serverBaseUrl);
			const effectiveExpiresIn =
				expiresIn ?? serverDefaultExpiry ?? undefined;

			const now = Date.now();
			const expiresAt = effectiveExpiresIn
				? new Date(now + effectiveExpiresIn * 1000)
				: null;

			if (server.key === "gitlab") {
				// Dual-write: GitLab connect via MCP Registry also populates
				// the WorkflowIntegration row, so PM-side callers (push/pull
				// to Issues, scraping, repo wiring) work without a second
				// OAuth dance. See gitlab-oauth-unification design.
				const { getGitLabUser } = await import(
					"../../integrations/lib/gitlab-oauth"
				);
				const { persistGitLabToken } = await import(
					"../../integrations/lib/gitlab-token"
				);
				const glUser = await getGitLabUser(accessToken);
				await persistGitLabToken(db as never, {
					userId: stateRecord.userId,
					organizationId: stateRecord.organizationId ?? null,
					token: {
						accessToken,
						refreshToken,
						expiresAt,
						scopes:
							typeof json.scope === "string"
								? json.scope.split(" ")
								: ["api", "read_user"],
					},
					gitlabUser: {
						id: glUser.id,
						username: glUser.username,
						name: glUser.name,
						avatarUrl: glUser.avatar_url ?? null,
					},
					// This IS the OAuth callback: the tokens above come from
					// the authorization-code exchange a few lines up, so the
					// user has just authorized a new grant and clearing the
					// `needsReauth` breaker is warranted.
					freshGrant: true,
				});
			} else {
				await updateMcpConfigTokens({
					configId: cfg.id,
					encryptedAccessToken: encryptApiKey(accessToken),
					accessTokenHash: hashApiKey(accessToken),
					encryptedRefreshToken: refreshToken
						? encryptApiKey(refreshToken)
						: null,
					tokenExpiresAt: expiresAt,
				});
			}

			// Cache the token endpoint only when it came from KNOWN_OAUTH_ENDPOINTS.
			// Rationale:
			//  • Cache hit path: already in the cache, nothing to do.
			//  • Discovery path: already cached above at the discovery success branch.
			//  • server.oauthTokenEndpoint: MUST NOT be cached here. The server row is
			//    the source of truth, and caching masks later admin/operator fixes for
			//    up to 24h (the oauthMetadataCache TTL) — refreshes would keep using
			//    the stale endpoint even after the server config is corrected.
			//  • KNOWN_OAUTH_ENDPOINTS: IS useful to cache, because oauth-provider.ts's
			//    own fallback chain uses hostname-based matching (not serverKey), so
			//    serverKey-matched entries (e.g. self-hosted GitLab) would otherwise
			//    be unreachable from the refresh path without this bridge.
			if (tokenEndpoint && tokenEndpointFromKnownEndpoints) {
				const cachedMeta = _oauthMetadata
					? (_oauthMetadata as unknown as Record<string, unknown>)
					: {};
				if (!cachedMeta.tokenEndpoint) {
					await updateOAuthMetadataCache({
						configId: cfg.id,
						metadata: {
							...cachedMeta,
							tokenEndpoint,
						},
					});
				}
			}

			// Clear any previous refresh failures since we have fresh tokens
			await clearRefreshFailures(cfg.id);

			// Trigger tool ingestion now that we have valid OAuth tokens
			// This is deferred for OAuth2 configs in the upsert handler
			if (cfg.enabled) {
				try {
					const serverName =
						cfg.displayName || server.name || cfg.mcpServerId;
					await triggerMcpToolIngestion({
						mcpConfigId: cfg.id,
						serverName,
						userId: stateRecord.userId,
						organizationId: stateRecord.organizationId || undefined,
					});
					console.log(
						`[OAuth Callback] Triggered tool ingestion for ${serverName} after successful OAuth`,
					);
				} catch (error) {
					// Log but don't fail the OAuth flow
					console.warn(
						"[OAuth Callback] Failed to trigger tool ingestion:",
						error,
					);
				}
			}

			await deleteOauthState(input.state);

			// AUTO-CHAIN: if this Rovo OAuth just succeeded for the
			// Atlassian MCP AND the hybrid Atlassian Cloud 3LO is
			// configured for the env AND this config doesn't already
			// have Cloud tokens, compute the Cloud authorization URL
			// server-side here. The callback HTML route uses this to
			// redirect the popup directly into the Cloud consent screen,
			// so the user sees ONE continuous flow.
			//
			// Hostname-strict detection — never chain on lookalike
			// domains. Falls through silently on any error (chainTo
			// stays undefined → popup closes as today, user can connect
			// Cloud separately later via the MCP card affordance).
			let chainTo:
				| { type: "atlassian_cloud"; authorizationUrl: string }
				| undefined;
			try {
				const atlassianCloudCfg = await buildAtlassianCloudChainHop({
					cfg,
					serverKey: server.key,
					callbackBaseUrl: stateRecord.redirectUri,
				});
				if (atlassianCloudCfg) {
					chainTo = atlassianCloudCfg;
				}
			} catch (err) {
				console.warn(
					"[OAuth Callback] Atlassian Cloud auto-chain skipped:",
					err instanceof Error ? err.message : String(err),
				);
			}

			return { success: true, message: "OAuth connected", chainTo };
		}),

	refresh: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_CONNECT))
		.route({
			method: "POST",
			path: "/mcp/oauth/refresh",
			tags: ["MCP"],
			summary: "Refresh OAuth tokens",
		})
		.input(z.object({ configId: z.string() }))
		.output(z.object({ success: z.boolean() }))
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			// Use internal version - authorization is done below based on config ownership
			const cfg = await getMcpConfigByIdInternal(input.configId);

			if (!cfg) {
				throw new ORPCError("NOT_FOUND", {
					message: "MCP config not found",
				});
			}

			if (cfg.userId) {
				if (cfg.userId !== userId) {
					throw new ORPCError("FORBIDDEN", {
						message: "You do not have access to this MCP config",
					});
				}
			} else if (cfg.organizationId) {
				const organizationId = cfg.organizationId;
				const organization = await getOrganizationById(organizationId);

				if (!organization) {
					throw new ORPCError("NOT_FOUND", {
						message: "Organization not found",
					});
				}

				const membership = await verifyOrganizationMembership(
					organizationId,
					userId,
				);

				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}

				if (
					membership.role !== "admin" &&
					membership.role !== "owner"
				) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"Only organization admins can refresh OAuth tokens for this MCP config",
					});
				}
			} else {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message:
						"MCP config must belong to a user or an organization",
				});
			}

			// `oauth.refresh` posts a stored refresh token to an OAuth token endpoint,
			// which is meaningless for a config that is not on an OAuth grant. Refuse as
			// a plain no-op rather than letting it fall through: a row edited from
			// OAUTH2 to API_KEY can still carry `encryptedRefreshToken` from its earlier
			// life, and posting that would contact a token endpoint for a grant nothing
			// uses any more. It also keeps the breaker refusal below scoped to OAUTH2,
			// where its "re-authenticate" instruction is actually followable — a
			// non-OAuth config has no reconnect affordance, so that message would send
			// the caller to a dead end.
			if (cfg.authType !== "OAUTH2") {
				return { success: false };
			}

			// Circuit breaker: `recordRefreshFailure` flips `needsReauth` once the
			// refresh token has failed MAX_REFRESH_FAILURES times, and only a
			// successful re-auth clears it. Posting the stored token again would
			// just re-hammer a known-dead credential, so refuse here — before any
			// discovery or refresh-token decryption. Thrown rather than returned
			// as `{ success: false }` because the output schema carries no message
			// field, and this refusal is only actionable if the user is told why.
			if (cfg.needsReauth) {
				throw new ORPCError("PRECONDITION_FAILED", {
					message: `Authentication expired for "${cfg.displayName || "MCP server"}". Please re-authenticate in MCP Settings.`,
				});
			}

			if (!cfg.encryptedRefreshToken) {
				return { success: false };
			}

			const server = cfg.mcpServer as any;

			// Discover OAuth endpoints
			// Priority: server.oauthDiscoveryUrl > derive from cfg.baseUrl or server.defaultUrl
			let discoveryUrl = server.oauthDiscoveryUrl;
			const effectiveBaseUrl = cfg.baseUrl || server?.defaultUrl;
			if (!discoveryUrl && effectiveBaseUrl) {
				discoveryUrl = deriveDiscoveryUrlFromBaseUrl(effectiveBaseUrl);
			}

			const discovery = await discoverOAuthEndpoints(
				discoveryUrl ?? null,
			);
			const tokenEndpoint =
				server.oauthTokenEndpoint ??
				discovery?.token_endpoint ??
				getKnownOAuthEndpoints(cfg.baseUrl, server.key)?.tokenEndpoint;

			if (!tokenEndpoint) {
				return { success: false };
			}
			assertSafeOutboundUrl(tokenEndpoint);

			// For public OAuth clients (token_endpoint_auth_method: 'none'), client_secret is not required
			const isPublicClient = isPublicOAuthClient(cfg);
			if (!cfg.oauthClientId) {
				return { success: false };
			}
			if (!isPublicClient && !cfg.encryptedOauthClientSecret) {
				return { success: false };
			}

			const refreshTokenPlain = decryptApiKey(cfg.encryptedRefreshToken);

			const body = new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshTokenPlain,
				client_id: cfg.oauthClientId,
			});
			// Only include client_secret for confidential clients
			if (!isPublicClient && cfg.encryptedOauthClientSecret) {
				const clientSecret = decryptApiKey(
					cfg.encryptedOauthClientSecret,
				);
				body.set("client_secret", clientSecret);
			}

			const res = await safeFetchOutbound(tokenEndpoint, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					accept: "application/json",
				},
				body,
			});
			const json = await res.json().catch(() => null as any);

			if (!res.ok || !json) {
				return { success: false };
			}

			const accessToken = json.access_token as string | undefined;
			const newRefreshToken =
				(json.refresh_token as string | undefined) ?? null;
			const expiresIn =
				(json.expires_in as number | undefined) ?? undefined;

			if (!accessToken) {
				return { success: false };
			}

			// Use server-specific default for known servers, preserve null for unknown
			const serverDefaultExpiry = getServerDefaultTokenExpiry(
				cfg.baseUrl || server?.defaultUrl,
			);
			const effectiveExpiresIn =
				expiresIn ?? serverDefaultExpiry ?? undefined;

			const now = Date.now();
			const expiresAt = effectiveExpiresIn
				? new Date(now + effectiveExpiresIn * 1000)
				: null;

			const encryptedAccessToken = encryptApiKey(accessToken);
			const encryptedRefreshToken = newRefreshToken
				? encryptApiKey(newRefreshToken)
				: cfg.encryptedRefreshToken;

			await updateMcpConfigTokens({
				configId: cfg.id,
				encryptedAccessToken,
				accessTokenHash: hashApiKey(accessToken),
				encryptedRefreshToken,
				tokenExpiresAt: expiresAt,
			});

			return { success: true };
		}),
};

/**
 * Compute the hybrid Atlassian Cloud 3LO authorization URL to chain
 * onto the just-completed Rovo OAuth callback (PR #1180 follow-up).
 *
 * Returns `null` when:
 *   - This isn't an Atlassian Rovo config (hostname-strict match on
 *     `mcp.atlassian.com` or `serverKey === "atlassian"`).
 *   - Env vars `ATLASSIAN_CLOUD_OAUTH_CLIENT_ID` /
 *     `ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET` are not configured for
 *     this env (Cloud feature off).
 *   - The config already has a usable Cloud token (re-runs of the
 *     Rovo flow shouldn't force the user through Cloud consent again).
 *   - We can't derive the chain callback URL.
 *
 * Otherwise creates a fresh PKCE-protected OAuth state row + builds
 * the authorize URL. The Next.js callback route reads this and
 * redirects the popup to it, so the user sees one continuous flow.
 *
 * Mirrors `atlassianCloudProcedures.start` but runs server-side from
 * the Rovo callback without needing a separate API hop.
 */
async function buildAtlassianCloudChainHop({
	cfg,
	serverKey,
	callbackBaseUrl,
}: {
	cfg: {
		id: string;
		userId: string | null;
		organizationId: string | null;
		mcpServerId: string;
		baseUrl?: string | null;
		encryptedAtlassianCloudAccessToken?: string | null;
	};
	serverKey: string | null | undefined;
	callbackBaseUrl: string | null;
}): Promise<{ type: "atlassian_cloud"; authorizationUrl: string } | null> {
	// Strict atlassian Rovo detection.
	let isAtlassian = serverKey === "atlassian";
	if (!isAtlassian && cfg.baseUrl) {
		try {
			const host = new URL(cfg.baseUrl).hostname;
			isAtlassian = host === "mcp.atlassian.com";
		} catch {
			// fall through; isAtlassian stays false.
		}
	}
	if (!isAtlassian) {
		return null;
	}

	// Env-var gate. If Cloud OAuth isn't configured for this env, skip
	// chaining entirely — the popup will close as today. "placeholder"
	// is the seeded Key Vault value before real secrets are synced;
	// treat it as not-configured so chaining stays off until a real
	// client id/secret is present.
	const clientId = process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_ID;
	const clientSecret = process.env.ATLASSIAN_CLOUD_OAUTH_CLIENT_SECRET;
	if (
		!clientId ||
		!clientSecret ||
		clientId === "placeholder" ||
		clientSecret === "placeholder"
	) {
		return null;
	}

	// Re-run guard. If the user already has a Cloud token on this config
	// (re-clicked "Connect" after the first hybrid flow), don't drag
	// them through Cloud consent again.
	if (cfg.encryptedAtlassianCloudAccessToken) {
		return null;
	}

	// Resolve the Cloud callback URL from the primary callback's
	// origin. The Rovo callback redirect_uri looks like
	// `https://your-fabric-host.example/api/mcp/oauth/callback`; swap the
	// path for the Cloud variant on the same origin.
	if (!callbackBaseUrl) {
		return null;
	}
	let cloudRedirectUri: string;
	try {
		const u = new URL(callbackBaseUrl);
		cloudRedirectUri = `${u.origin}/api/mcp/atlassian-cloud/callback`;
	} catch {
		return null;
	}

	// Mint a fresh PKCE-protected state row pointing at the same
	// MCPConfig. The Cloud callback handler will validate this state
	// the same way the primary flow does.
	const codeVerifier = generateCodeVerifier();
	const codeChallenge = generateCodeChallenge(codeVerifier);

	if (!cfg.userId) {
		// State table requires a userId. Personal-only orgs have it;
		// service-account configs (rare) won't. Skip chaining there.
		return null;
	}

	const state = await createOauthState({
		mcpServerId: cfg.mcpServerId,
		configId: cfg.id,
		userId: cfg.userId,
		organizationId: cfg.organizationId ?? undefined,
		codeVerifier,
		redirectUri: cloudRedirectUri,
	});

	// Build authorize URL — keep parity with
	// `atlassianCloudProcedures.start` scopes/params so the consent
	// screen looks identical whether the user hits the chained path
	// or the standalone start procedure.
	const scopes = [
		"read:me",
		"read:jira-user",
		"read:jira-work",
		"write:jira-work",
		"read:attachment:jira",
		"write:attachment:jira",
		"read:issue:jira",
		"write:issue:jira",
		"offline_access",
	];
	const params = new URLSearchParams({
		audience: "api.atlassian.com",
		client_id: clientId,
		scope: scopes.join(" "),
		redirect_uri: cloudRedirectUri,
		state,
		response_type: "code",
		prompt: "consent",
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
	});

	return {
		type: "atlassian_cloud",
		authorizationUrl: `https://auth.atlassian.com/authorize?${params.toString()}`,
	};
}
