import { ORPCError } from "@orpc/server";
import {
	allowlistDcrClientMetadata,
	clearRefreshFailures,
	createOauthState,
	credentialFingerprintMatches,
	db,
	deleteOauthState,
	explicitClientMetadata,
	getGoogleAccountEmail,
	getMcpConfigByIdInternal,
	getMcpServerDefaultTokenExpiry,
	getMcpServerForTenant,
	getOauthState,
	getOrganizationById,
	isPublicMcpOAuthClient,
	parseMcpOAuthBinding,
	refreshMcpOAuthAccessToken,
	replaceMcpOAuthRegistration,
	resolveMcpClientAuthMethod,
	sameAuthorizationServer,
	saveMcpOAuthGrant,
} from "@repo/database";
import {
	getGitLabConnectionGeneration,
	gitlabApiBaseForOrigin,
	gitlabOutboundFetch,
	isGitLabPersonalMcpServerKey,
	parseGitLabOrigin,
	readGitLabConnectionIssuer,
	refreshGitLabConnection,
} from "@repo/integrations/gitlab";
import { triggerMcpToolIngestion } from "@repo/temporal";
import { decryptApiKey, encryptApiKey, hashApiKey } from "@repo/utils";
import {
	classifyOAuthErrorCode,
	sanitizeOAuthErrorText,
} from "@repo/utils/oauth-refresh";
import {
	assertSafeOutboundUrl,
	safeFetchOutbound,
} from "@repo/utils/url-security";
import { z } from "zod";
import {
	authorizeInputOrganization,
	Permissions,
	publicProcedure,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import {
	getEnvOAuthCredentials,
	gitlabConnectionAuthorizationServer,
	oauthClientFingerprint,
	parseOAuthFlowSnapshot,
	registerOAuthClient,
	resolveAuthorizationServer,
	resolveIndependentAuthorizationServer,
	serializeOAuthFlowSnapshot,
	snapshotFromBinding,
} from "../lib/oauth-authorization-server";
import {
	generateCodeChallenge,
	generateCodeVerifier,
	generateStructuredState,
} from "../lib/oauth-discovery";

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

			// The config's server must be one its tenant may use (a system
			// server, or a custom server that tenant owns). A config pointing at
			// another person's or organization's private server would send its
			// client and code to endpoints they control.
			const accessibleServer = await getMcpServerForTenant(
				cfg.mcpServerId,
				{
					userId: cfg.userId,
					organizationId: cfg.organizationId,
				},
			);
			if (!accessibleServer) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"This MCP config refers to a server you cannot use. Remove it and add the server again.",
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

			// ONE authorization server for the whole flow. It decides where a
			// client is registered, where the user authorizes, and — carried in
			// the OAuth state row — where the callback exchanges the code. The
			// callback never re-discovers.
			const effectiveBaseUrl: string | null =
				cfg.baseUrl || server.defaultUrl || null;
			// Fabric's own client (system-provided servers only), together with
			// the one AS it may go to — both from the same pinned provider entry,
			// never a catalog row's editable fields.
			const fabricClient = getEnvOAuthCredentials(
				effectiveBaseUrl,
				server,
			);
			if (fabricClient?.kind === "conflict") {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"This MCP server's URL belongs to a different service than its catalog entry. Use the server's own URL, or connect it as a custom server.",
				});
			}
			const envCreds = fabricClient;
			const known = fabricClient?.snapshot ?? null;
			const isGitLabPersonal = isGitLabPersonalMcpServerKey(server?.key);
			const existingBinding = parseMcpOAuthBinding(cfg.oauthBinding);
			const holdsEnvClient =
				!!envCreds &&
				!!cfg.oauthClientId &&
				cfg.oauthClientId === envCreds.clientId;
			// An AS configured independently of both the MCP server and the
			// config's owner: a system catalog row's endpoints, or the known
			// table, on the effective URL. A custom row's endpoints do not
			// count — their owner can change them.
			const independentAs = resolveIndependentAuthorizationServer(
				server,
				effectiveBaseUrl,
			);
			const conflict = () =>
				new ORPCError("CONFLICT", {
					message:
						"This MCP connection changed while connecting. Please try again.",
				});
			const hasUsableClient = (c: NonNullable<typeof cfg>) =>
				!!c.oauthClientId &&
				(isPublicMcpOAuthClient(c) || !!c.encryptedOauthClientSecret);

			// Fabric's own pre-registered client takes its AS from Fabric's
			// pinned configuration only: neither an MCP server nor a catalog
			// row anyone can edit may name where Fabric's secret goes.
			let snapshot = holdsEnvClient
				? known
				: await resolveAuthorizationServer({
						server,
						baseUrl: effectiveBaseUrl,
					});

			// A stored client is trusted only while it is the set its binding
			// was written with (`credentialFingerprint`): a writer outside the
			// credential module (the previous app version during a rolling
			// deploy) may have replaced the id or secret under the binding.
			const bindingIntact =
				!!existingBinding &&
				credentialFingerprintMatches(existingBinding, cfg);
			let mustRegister =
				!hasUsableClient(cfg) ||
				// Fabric's own client is reinstalled from its pinned
				// configuration unless the stored copy is intact.
				(holdsEnvClient && !bindingIntact);
			// Set when a stored client is dropped because nothing independent
			// says which AS it belongs to.
			let droppedUnboundClient = false;
			if (cfg.oauthClientId && !holdsEnvClient) {
				const isDcrClient = !!cfg.dcrRegisteredAt;
				// A stored client start cannot trust is never reused, bound or
				// sent: Fabric's own client is reinstalled from its pinned
				// configuration, a registered client is replaced by a new
				// registration, and anything else (a hand-entered client, a
				// GitLab one that may have issued the person's GitLab grant)
				// must be entered again — which binds it with verified
				// provenance.
				const untrustedStoredClient = () => {
					if (envCreds || (isDcrClient && !isGitLabPersonal)) {
						mustRegister = true;
						return;
					}
					throw new ORPCError("BAD_REQUEST", {
						message:
							"This MCP server's stored OAuth client credentials changed outside Fabric's connect flow. Enter the OAuth client credentials again, then connect.",
					});
				};
				if (existingBinding) {
					// A bound client is reused only at the AS it is bound to —
					// and then with the binding's own pinned endpoints, never
					// endpoints from the document just fetched — and only
					// while it is the client the binding was written with.
					const pinned =
						bindingIntact &&
						snapshot &&
						sameAuthorizationServer(
							existingBinding.authorizationServerUrl,
							snapshot.binding.authorizationServerUrl,
						)
							? snapshotFromBinding(existingBinding, snapshot)
							: null;
					if (pinned) {
						snapshot = pinned;
					} else if (!bindingIntact) {
						untrustedStoredClient();
					} else if (isGitLabPersonal || !isDcrClient) {
						throw new ORPCError("BAD_REQUEST", {
							message:
								"This MCP server now uses a different authorization server than the one its OAuth client belongs to. Remove the stored OAuth client credentials and connect again.",
						});
					} else {
						mustRegister = true;
					}
				} else if (cfg.encryptedOauthClientSecret) {
					// Unbound and holding a secret: nothing records which AS
					// that secret was issued by — the previous app version may
					// have written one from another AS under the same client
					// id — so it is neither reused nor bound here.
					untrustedStoredClient();
				} else {
					// An unbound public client goes only to an AS configured
					// independently of the MCP server: for GitLab, the issuer
					// recorded on the person's connection, else the independent
					// AS; otherwise the independent AS (system catalog or known
					// table). Never one discovered from the MCP server, nor a
					// custom row's.
					let independent: typeof snapshot = null;
					if (isGitLabPersonal && cfg.userId) {
						const issuer = await readGitLabConnectionIssuer({
							userId: cfg.userId,
							organizationId: cfg.organizationId ?? null,
						});
						const origin =
							issuer &&
							issuer.kind !== "pat" &&
							issuer.clientId === cfg.oauthClientId &&
							(issuer.kind === "app" ||
								issuer.mcpConfigId === cfg.id)
								? parseGitLabOrigin(issuer.origin)
								: null;
						independent =
							origin?.ok === true
								? gitlabConnectionAuthorizationServer(
										origin.origin,
									)
								: null;
					}
					independent ??= independentAs;
					if (independent) {
						snapshot = independent;
						if (isGitLabPersonal && hasUsableClient(cfg)) {
							// Only a public client reaches here (an unbound or
							// bearer-only row holding a secret was refused above).
							// A GitLab grant goes to the person's connection, not
							// through `saveMcpOAuthGrant`, so nothing else would
							// ever bind this client — and the connection uses a
							// stored MCP client only when it is bound to the
							// connection's instance. Bind it now, to the AS it
							// is about to be sent to, in one fenced write that
							// keeps the client as it is. The write also clears
							// any tokens on the row, so a bearer-only import is
							// replaced by this binding rather than left behind it.
							const written = await replaceMcpOAuthRegistration({
								configId: cfg.id,
								expectedGeneration: cfg.oauthGrantGeneration,
								client: {
									oauthClientId: cfg.oauthClientId,
									encryptedOauthClientSecret:
										cfg.encryptedOauthClientSecret,
									dcrClientMetadata:
										(cfg.dcrClientMetadata as Record<
											string,
											unknown
										> | null) ?? null,
									dcrRegistrationEndpoint:
										cfg.dcrRegistrationEndpoint ?? null,
									dcrRegisteredAt:
										cfg.dcrRegisteredAt ?? null,
								},
								binding: independent.binding,
								// The stored client, kept: bound only if it may
								// follow this binding (a public client may).
								keptClient: {
									oauthClientId: cfg.oauthClientId,
									encryptedOauthClientSecret:
										cfg.encryptedOauthClientSecret,
									encryptedRefreshToken:
										cfg.encryptedRefreshToken ?? null,
									oauthBinding: cfg.oauthBinding,
								},
							});
							if (!written.written || !written.config) {
								throw conflict();
							}
							cfg = written.config;
						}
					} else if (isGitLabPersonal) {
						throw new ORPCError("BAD_REQUEST", {
							message:
								"Fabric cannot confirm which GitLab instance this MCP server's OAuth client belongs to. Reconnect GitLab in Settings > Integrations, then connect this server again.",
						});
					} else {
						mustRegister = true;
						droppedUnboundClient = true;
					}
				}
			}

			// Dynamic client registration at the snapshot's AS. Never for a
			// GitLab personal server that already holds a client: that
			// registration may be the issuer of the person's GitLab credential,
			// and replacing it would leave the credential unable to refresh.
			if (
				input.autoDiscoverAndRegister &&
				mustRegister &&
				snapshot?.registrationEndpoint &&
				!(isGitLabPersonal && cfg.oauthClientId)
			) {
				const registrationSnapshot = snapshot;
				const registrationEndpoint = snapshot.registrationEndpoint;
				// IMPORTANT: client_name should be OUR app name, not the MCP server name
				// This identifies us as the OAuth client connecting to the server
				const requestedAuthMethod = "client_secret_basic" as const;
				const metadata: Record<string, unknown> = {
					client_name: "Fabric Portal",
					redirect_uris: [input.redirectUri],
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
					token_endpoint_auth_method: requestedAuthMethod,
				};
				if (cfg.scopes && cfg.scopes.length > 0) {
					metadata.scope = cfg.scopes.join(" ");
				}

				let registered: Awaited<ReturnType<typeof registerOAuthClient>>;
				try {
					registered = await registerOAuthClient({
						registrationEndpoint,
						metadata,
					});
				} catch (error) {
					// Log but don't fail - the env fallback may still apply.
					console.error(
						"Automatic DCR failed:",
						error instanceof Error ? error.message : String(error),
					);
					registered = { ok: false, status: null, message: "" };
				}
				if (registered.ok) {
					const written = await replaceMcpOAuthRegistration({
						configId: cfg.id,
						expectedGeneration: cfg.oauthGrantGeneration,
						client: {
							oauthClientId: registered.clientId,
							encryptedOauthClientSecret: registered.clientSecret
								? encryptApiKey(registered.clientSecret)
								: null,
							dcrClientMetadata: allowlistDcrClientMetadata(
								registered.response,
								registrationSnapshot.binding
									.authorizationServerUrl,
								requestedAuthMethod,
							),
							dcrRegistrationEndpoint: registrationEndpoint,
							dcrRegisteredAt: new Date(),
						},
						binding: registrationSnapshot.binding,
					});
					// The row exactly as this write left it — never a re-read,
					// which could adopt a registration someone else wrote since.
					if (!written.written || !written.config) {
						throw conflict();
					}
					cfg = written.config;
					mustRegister = false;
					droppedUnboundClient = false;
				}
			}

			// Fallback: Fabric's pre-registered client for known servers that
			// don't support DCR (e.g., Slack). It replaces whatever unusable
			// client the config holds, and binds to Fabric's pinned AS only.
			if (mustRegister && envCreds) {
				if (!known) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Authorization endpoint not available - please configure OAuth discovery URL or authorization endpoint",
					});
				}
				console.log(
					`[OAuth] Using pre-configured client credentials for ${server.key ?? "server"}`,
				);
				const written = await replaceMcpOAuthRegistration({
					configId: cfg.id,
					expectedGeneration: cfg.oauthGrantGeneration,
					client: {
						oauthClientId: envCreds.clientId,
						encryptedOauthClientSecret: encryptApiKey(
							envCreds.clientSecret,
						),
						// Fabric's own clients authenticate in the request body,
						// recorded per client.
						dcrClientMetadata: explicitClientMetadata(),
						dcrRegistrationEndpoint: null,
						dcrRegisteredAt: null,
					},
					binding: known.binding,
				});
				if (!written.written || !written.config) {
					throw conflict();
				}
				cfg = written.config;
				snapshot = known;
				mustRegister = false;
				droppedUnboundClient = false;
			}

			if (droppedUnboundClient) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Fabric cannot confirm which authorization server this MCP server's stored OAuth client belongs to, and the server does not support registering a new client. Configure the server's OAuth token and authorization endpoints, or remove the stored client credentials and enter ones issued for its authorization server.",
				});
			}

			if (!snapshot) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Authorization endpoint not available - please configure OAuth discovery URL or authorization endpoint",
				});
			}
			const authorizationEndpoint = snapshot.authorizationEndpoint;

			// Auto-populate scopes for known servers.
			// Applies to servers with env credentials OR servers with known default scopes
			// (e.g., GitLab needs api+read_user even when using DCR without env vars).
			const isKnownEnvServer = envCreds !== null;
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
						: snapshot.scopesSupported.length > 0
							? snapshot.scopesSupported
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
			const isPublicClient = isPublicMcpOAuthClient(cfg);
			if (!cfg.oauthClientId || mustRegister) {
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

			// The state row carries this flow's AS, endpoints and client, and the
			// config's grant generation, to the callback.
			const state = await createOauthState({
				mcpServerId: server.id,
				configId: cfg.id,
				userId,
				organizationId: cfg.organizationId ?? undefined,
				codeVerifier,
				redirectUri: effectiveRedirectUri,
				authorizationServerSnapshot: serializeOAuthFlowSnapshot({
					binding: snapshot.binding,
					clientId: cfg.oauthClientId,
					clientFingerprint: oauthClientFingerprint(cfg),
				}),
				expectedGrantGeneration: cfg.oauthGrantGeneration,
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

			// As in `start`: never complete a flow for a config whose server its
			// tenant may not use.
			const accessibleServer = await getMcpServerForTenant(
				cfg.mcpServerId,
				{
					userId: cfg.userId,
					organizationId: cfg.organizationId,
				},
			);
			if (!accessibleServer) {
				await deleteOauthState(input.state);
				return {
					success: false,
					message:
						"This MCP config refers to a server you cannot use.",
				};
			}

			const server = cfg.mcpServer as any;

			// Exchange the code with exactly the AS, endpoint and client that
			// `start` resolved — never re-discovered: whatever the MCP server
			// advertises now changes nothing. A flow whose config changed since
			// (reconnect, revoke, re-registration) is refused.
			const flow = parseOAuthFlowSnapshot(
				stateRecord.authorizationServerSnapshot,
			);
			const expectedGeneration = stateRecord.expectedGrantGeneration;
			if (!flow || expectedGeneration === null) {
				await deleteOauthState(input.state);
				return {
					success: false,
					message:
						"This sign-in can no longer be completed. Please connect again.",
				};
			}
			if (
				cfg.oauthGrantGeneration !== expectedGeneration ||
				cfg.oauthClientId !== flow.clientId ||
				// The client secret sent below must be the one `start`
				// resolved: a writer that does not move the generation (the
				// previous app version) may have replaced it under the same id.
				oauthClientFingerprint(cfg) !== flow.clientFingerprint
			) {
				await deleteOauthState(input.state);
				return {
					success: false,
					message:
						"This MCP connection changed while signing in. Please connect again.",
				};
			}
			const tokenEndpoint = flow.binding.tokenEndpoint;
			assertSafeOutboundUrl(tokenEndpoint);

			const authMethod = resolveMcpClientAuthMethod(cfg);
			if (authMethod !== "none" && !cfg.encryptedOauthClientSecret) {
				return {
					success: false,
					message: "OAuth client secret not configured",
				};
			}

			const body = new URLSearchParams({
				grant_type: "authorization_code",
				code: input.code,
				redirect_uri: stateRecord.redirectUri || "",
			});
			const exchangeHeaders: Record<string, string> = {
				"content-type": "application/x-www-form-urlencoded",
				accept: "application/json",
			};
			// Client authentication with the method the client was registered
			// with.
			const clientSecret =
				authMethod !== "none" && cfg.encryptedOauthClientSecret
					? decryptApiKey(cfg.encryptedOauthClientSecret)
					: undefined;
			if (authMethod === "client_secret_basic" && clientSecret) {
				exchangeHeaders.authorization = `Basic ${Buffer.from(
					`${flow.clientId}:${clientSecret}`,
				).toString("base64")}`;
			} else {
				body.set("client_id", flow.clientId);
				if (clientSecret) {
					body.set("client_secret", clientSecret);
				}
			}
			if (stateRecord.codeVerifier) {
				body.set("code_verifier", stateRecord.codeVerifier);
			}

			// GitLab personal servers write the person's ONE GitLab connection,
			// not this config's token columns. That connection is personal:
			// refuse a config the person does not own (an organization-level
			// config cannot issue a personal credential), and read the
			// connection generation BEFORE the exchange so a disconnect or
			// another connect landing meanwhile is not overwritten.
			const isGitLabPersonal = isGitLabPersonalMcpServerKey(server.key);
			let gitlabGenerationBefore: number | undefined;
			// The token endpoint's GitLab instance, checked like every recorded
			// GitLab address (https, no embedded credentials, not a loopback /
			// private / metadata host) BEFORE the exchange: the code, the PKCE
			// verifier and any client secret are never sent to a refused
			// endpoint. The same origin is what gets recorded below.
			let gitlabOrigin: string | null = null;
			if (isGitLabPersonal) {
				if (cfg.userId !== stateRecord.userId) {
					return {
						success: false,
						message:
							"GitLab connections are personal — connect GitLab from your own MCP server entry.",
					};
				}
				const checkedOrigin = parseGitLabOrigin(tokenEndpoint);
				if (!checkedOrigin.ok) {
					return {
						success: false,
						message: `GitLab token endpoint refused: ${checkedOrigin.reason}`,
					};
				}
				gitlabOrigin = checkedOrigin.origin;
				gitlabGenerationBefore = await getGitLabConnectionGeneration({
					userId: stateRecord.userId,
					organizationId: stateRecord.organizationId ?? null,
				});
			}

			const exchangeInit: RequestInit = {
				method: "POST",
				headers: exchangeHeaders,
				body,
				redirect: "error",
			};
			// A GitLab exchange goes through the GitLab outbound path (a
			// self-hosted instance through the outbound guard); a redirect
			// is refused either way, as `safeFetchOutbound` does for every
			// other server.
			const res =
				gitlabOrigin !== null
					? await gitlabOutboundFetch(tokenEndpoint, {
							...exchangeInit,
							redirect: "error",
						})
					: await safeFetchOutbound(tokenEndpoint, exchangeInit);
			const json = await res.json().catch(() => null as any);

			if (!res.ok || !json) {
				// The description is redacted; the `error` code is classified
				// and never repeated verbatim.
				const errorMsg =
					typeof json?.error_description === "string" &&
					json.error_description
						? sanitizeOAuthErrorText(json.error_description, [
								input.code,
								clientSecret,
								stateRecord.codeVerifier,
							])
						: json?.error !== undefined && json?.error !== null
							? classifyOAuthErrorCode(json.error)
							: `HTTP ${res.status}`;
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
				getMcpServerDefaultTokenExpiry(serverBaseUrl);
			const effectiveExpiresIn =
				expiresIn ?? serverDefaultExpiry ?? undefined;

			const now = Date.now();
			const expiresAt = effectiveExpiresIn
				? new Date(now + effectiveExpiresIn * 1000)
				: null;

			if (gitlabOrigin !== null) {
				// The issuer is this config's own client registration on the
				// token endpoint's GitLab instance: a later refresh uses
				// exactly that client, and the token is never sent elsewhere.
				const { getGitLabUser } = await import(
					"../../integrations/lib/gitlab-oauth"
				);
				const { persistGitLabToken } = await import(
					"../../integrations/lib/gitlab-token"
				);
				// The profile comes from the instance that issued the token —
				// never a hardcoded gitlab.com, which would hand a self-hosted
				// token to a different GitLab.
				const glUser = await getGitLabUser({
					token: accessToken,
					apiBase: gitlabApiBaseForOrigin(gitlabOrigin),
				});
				const persisted = await persistGitLabToken({
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
					issuer: {
						kind: "mcp-dcr",
						mcpConfigId: cfg.id,
						serverKey: server.key,
						clientId: cfg.oauthClientId,
						origin: gitlabOrigin,
					},
					// This IS the OAuth callback: the tokens above come from
					// the authorization-code exchange a few lines up, so the
					// user has just authorized a new grant.
					freshGrant: true,
					expectedGeneration: gitlabGenerationBefore,
				});
				if (!persisted.written) {
					await deleteOauthState(input.state);
					return {
						success: false,
						message:
							"Your GitLab connection changed while this sign-in was completing. Please connect GitLab again.",
					};
				}
				// The connection service owns the credential; only the breaker
				// of this grant generation is cleared here.
				await clearRefreshFailures(cfg.id, { expectedGeneration });
			} else {
				// Tokens and the binding of the AS that issued them, in one
				// write, only while the config still holds the generation
				// `start` saw.
				const saved = await saveMcpOAuthGrant({
					configId: cfg.id,
					expectedGeneration,
					binding: {
						...flow.binding,
						boundAt: new Date().toISOString(),
					},
					tokens: {
						encryptedAccessToken: encryptApiKey(accessToken),
						accessTokenHash: hashApiKey(accessToken),
						encryptedRefreshToken: refreshToken
							? encryptApiKey(refreshToken)
							: null,
						tokenExpiresAt: expiresAt,
					},
					// Written only while the stored client is still the one the
					// code was exchanged with.
					client: {
						oauthClientId: cfg.oauthClientId,
						encryptedOauthClientSecret:
							cfg.encryptedOauthClientSecret,
					},
				});
				if (!saved.written) {
					await deleteOauthState(input.state);
					return {
						success: false,
						message:
							"This MCP connection changed while signing in. Please connect again.",
					};
				}
			}

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

			// GitLab personal servers carry no credential of their own: the
			// person's GitLab connection does, and only the connection service
			// refreshes it (with the client that issued it). The ownership
			// check above already bound `cfg.userId` to the caller; an
			// organization-level config has no personal connection behind it.
			const serverKey = (cfg.mcpServer as { key?: string } | null)?.key;
			if (serverKey && isGitLabPersonalMcpServerKey(serverKey)) {
				if (!cfg.userId) {
					return { success: false };
				}
				// The refresh writes the connection in the config's
				// organization: the owner check above does not show the
				// caller still belongs there, so check membership and
				// MCP_CONNECT in that organization now, and refuse a config
				// with no organization rather than refresh one there.
				const organizationId = await authorizeInputOrganization(
					Permissions.MCP_CONNECT,
					cfg.organizationId,
					context,
					{ requireOrganization: true },
				);
				const refreshed = await refreshGitLabConnection(
					{
						userId: cfg.userId,
						organizationId: organizationId ?? null,
					},
					{ force: true },
				);
				if (!refreshed.ok && refreshed.reason === "needs-reauth") {
					throw new ORPCError("PRECONDITION_FAILED", {
						message:
							"Your GitLab connection needs to be reconnected. Reconnect GitLab in Settings > Integrations.",
					});
				}
				return { success: refreshed.ok };
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

			// The one bound refresh path: posts only to the token endpoint the
			// config's credentials are bound to, never re-discovered. An unbound
			// config is not refreshed at all; it is flagged for reconnect.
			const outcome = await refreshMcpOAuthAccessToken(cfg.id, {
				recordFailures: false,
				markReconnectRequired: true,
				expectedGeneration: cfg.oauthGrantGeneration,
			});
			if (outcome.status === "reconnect-required") {
				throw new ORPCError("PRECONDITION_FAILED", {
					message: `Reconnect "${cfg.displayName || "MCP server"}" in MCP Settings: its OAuth credentials are not bound to a known authorization server.`,
				});
			}
			return { success: outcome.status === "refreshed" };
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
