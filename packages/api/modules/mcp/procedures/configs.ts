import { ORPCError } from "@orpc/server";
import {
	bearerOnlyOAuthMarker,
	clearMcpConfigFromReportInstances,
	createMcpClientSession,
	createMcpConfig,
	db,
	deleteMcpConfig,
	explicitClientMetadata,
	getMcpConfigById,
	getMcpConfigForTenantAndServer,
	getMcpServerById,
	getMcpServerForTenant,
	getOrganizationById,
	importMcpOAuthTokens,
	isGitLabPersonalMcpServerKey,
	isStoredMcpOAuthClientTrusted,
	listMcpConfigsForTenant,
	type McpOAuthImportedTokens,
	type McpOAuthImportSource,
	type McpOAuthStoredAccessToken,
	type McpOAuthStoredCredentials,
	recordAudit,
	replaceMcpOAuthRegistration,
	updateMcpConfigEnabled,
	upsertMcpConfig,
} from "@repo/database";
import { findUsableGitLabConnection } from "@repo/integrations/gitlab";
import {
	triggerMcpServerIngestion,
	triggerMcpToolDeletion,
	triggerMcpToolIngestion,
} from "@repo/temporal";
import { decryptApiKey, encryptApiKey, hashApiKey } from "@repo/utils";
import { z } from "zod";
import {
	authorizeInputOrganization,
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { removeGitLabPersonalMcpConfig } from "../lib/gitlab-config-removal";
import {
	enteredClientBindingFor,
	independentBindingFor,
} from "../lib/oauth-authorization-server";

// NOTE: AI provider config is now fetched directly inside Temporal activities
// using getAIProviderConfig(). This ensures proper tenant isolation and
// centralized credential management. No environment variable fallbacks.

/**
 * Get default semantic routing metadata for OAuth providers
 * Returns description, domain keywords, and example queries based on server name
 */
function getOAuthProviderMetadata(serverName: string): {
	description?: string;
	domainKeywords?: string[];
	exampleQueries?: string[];
} {
	const normalized = serverName.toLowerCase().replace(/[_\s-]/g, "");

	// Microsoft Teams / Microsoft Graph
	if (
		normalized.includes("teams") ||
		normalized.includes("microsoft") ||
		normalized.includes("graph")
	) {
		return {
			description:
				"Microsoft Teams integration for channels, messages, chats, and shared files",
			domainKeywords: [
				"teams",
				"microsoft",
				"chat",
				"channel",
				"message",
				"meeting",
				"collaboration",
			],
			exampleQueries: [
				"list teams channels",
				"search teams messages",
				"get recent teams chat",
				"find shared files in teams",
			],
		};
	}

	// GitHub
	if (normalized.includes("github") || normalized.includes("git")) {
		return {
			description:
				"GitHub integration for repositories, issues, pull requests, and code management",
			domainKeywords: [
				"github",
				"repository",
				"repo",
				"issue",
				"pr",
				"pull request",
				"code",
				"commit",
			],
			exampleQueries: [
				"list github issues",
				"create github pr",
				"get repository info",
				"list pull requests",
			],
		};
	}

	// Google Drive
	if (normalized.includes("drive") || normalized.includes("google")) {
		return {
			description:
				"Google Drive integration for files, folders, and document management",
			domainKeywords: [
				"drive",
				"google",
				"file",
				"folder",
				"document",
				"doc",
				"sheet",
			],
			exampleQueries: [
				"list drive files",
				"search google drive",
				"get document content",
				"list folders",
			],
		};
	}

	// Slack
	if (normalized.includes("slack")) {
		return {
			description:
				"Slack integration for channels, messages, and workspace communication",
			domainKeywords: [
				"slack",
				"channel",
				"message",
				"workspace",
				"dm",
				"thread",
			],
			exampleQueries: [
				"list slack channels",
				"search slack messages",
				"get channel history",
				"send slack message",
			],
		};
	}

	// Notion
	if (normalized.includes("notion")) {
		return {
			description:
				"Notion integration for pages, databases, and knowledge management",
			domainKeywords: [
				"notion",
				"page",
				"database",
				"wiki",
				"knowledge",
				"notes",
			],
			exampleQueries: [
				"list notion pages",
				"search notion database",
				"get page content",
				"query notion",
			],
		};
	}

	// No default metadata for unknown providers
	return {};
}

export const configProcedures = {
	list: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_READ))
		.route({
			method: "GET",
			path: "/mcp/configs",
			tags: ["MCP"],
			summary: "List my MCP configs",
		})
		.input(
			z
				.object({ organizationId: z.string().nullable().optional() })
				.optional(),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const user = context.user;
			const organizationId = input?.organizationId;

			if (organizationId) {
				const membership = await verifyOrganizationMembership(
					organizationId,
					user.id,
				);

				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}
			}

			// STRICT XOR: Pass organizationId as-is (string for org, null/undefined for personal)
			// listMcpConfigsForTenant handles the XOR isolation
			const configs = await listMcpConfigsForTenant({
				userId: user.id,
				organizationId: organizationId || undefined, // Treat null, "", undefined all as "personal context"
			});

			return configs;
		}),

	upsert: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_CREATE))
		.route({
			method: "PUT",
			path: "/mcp/configs",
			tags: ["MCP"],
			summary: "Create or update MCP config",
		})
		.input(
			z.object({
				configId: z.string().optional(),
				forceCreate: z.boolean().optional(),
				mcpServerId: z.string(),
				organizationId: z.string().nullable().optional(),
				displayName: z.string().optional(),
				// Base URL is required for HTTP/SSE servers, optional for STDIO servers
				baseUrl: z
					.string()
					.url({ message: "Must be a valid URL" })
					.optional(),
				// Command arguments for STDIO servers (e.g., organization name)
				commandArgs: z.array(z.string()).optional(),
				authType: z.enum(["NONE", "API_KEY", "OAUTH2"]).optional(),
				// API Key authentication method: BEARER (Authorization header) or HEADER (X-API-Key)
				apiKeyMethod: z.enum(["BEARER", "HEADER", "PLAIN"]).optional(),
				// OAuth client credentials (plaintext)
				oauthClientId: z.string().optional(),
				oauthClientSecret: z.string().optional(),
				// Plaintext tokens/keys (will be encrypted server-side if provided)
				apiKey: z.string().optional(),
				accessToken: z.string().optional(),
				refreshToken: z.string().optional(),
				// Or already-encrypted fields (internal/testing)
				encryptedApiKey: z.string().optional().nullable(),
				encryptedAccessToken: z.string().optional().nullable(),
				encryptedRefreshToken: z.string().optional().nullable(),
				tokenExpiresAt: z.coerce.date().optional(),
				scopes: z.array(z.string()).default([]),
				enabled: z.boolean().default(true),
				// Phase 1: Semantic server routing metadata
				description: z.string().optional(),
				domainKeywords: z.array(z.string()).optional(),
				exampleQueries: z.array(z.string()).optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const {
				configId,
				forceCreate,
				mcpServerId: inputMcpServerId,
				organizationId,
				apiKeyMethod,
				apiKey,
				accessToken,
				refreshToken,
				oauthClientId,
				oauthClientSecret,
				encryptedApiKey,
				encryptedAccessToken,
				encryptedRefreshToken,
				tokenExpiresAt,
				...rest
			} = input as any;
			let mcpServerId: string = inputMcpServerId;
			const user = context.user;

			// Always use the user's ID - even in org context, configs are per-user
			// This allows each org member to have their own MCP credentials
			const tenantUserId = user.id;

			if (organizationId) {
				const organization = await getOrganizationById(organizationId);
				if (!organization) {
					throw new ORPCError("NOT_FOUND", {
						message: "Organization not found",
					});
				}

				const membership = await verifyOrganizationMembership(
					organizationId,
					user.id,
				);

				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}
			}

			// If configId is provided, load that specific config for editing
			// If forceCreate is true, skip the upsert lookup entirely (always create new)
			// Otherwise, use the original upsert behavior (find by server+tenant)
			let existingConfig: any = null;
			if (configId) {
				existingConfig = await getMcpConfigById(configId, {
					userId: tenantUserId,
					organizationId: organizationId ?? undefined,
				});
				if (!existingConfig) {
					throw new ORPCError("NOT_FOUND", {
						message: "MCP config not found",
					});
				}
				// Use the config's actual server ID to prevent mismatches
				mcpServerId = existingConfig.mcpServerId;
			} else if (!forceCreate) {
				existingConfig = await getMcpConfigForTenantAndServer({
					mcpServerId,
					userId: tenantUserId,
					organizationId,
				});
			}

			// System-managed default configs are immutable. The UI hides
			// the Edit button on these rows; this is the API-layer fence
			// for direct callers and ensures the seeded sentinel row's
			// auth fields can't be repurposed to override the default.
			if (existingConfig?.isManagedDefault) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"This configuration is managed by Fabric and cannot be modified.",
				});
			}

			const requestedAuthType =
				input.authType ?? existingConfig?.authType ?? "NONE";

			// The server, as this tenant may use it: a system server, or a
			// custom server this tenant owns (exclusive tenant filter). A config
			// is never created for, or moved onto, a server another person or
			// organization controls — its endpoints would receive this config's
			// client secret and tokens. Refused before anything is written.
			const serverKey = await getMcpServerForTenant(mcpServerId, {
				userId: tenantUserId,
				organizationId: organizationId ?? null,
			});
			if (!serverKey) {
				throw new ORPCError("NOT_FOUND", {
					message: "MCP server not found",
				});
			}

			// GitLab personal servers never take a credential here: their
			// credential is the person's GitLab connection, written only by
			// the GitLab connection service, and every reader of these rows
			// resolves through that connection whatever `authType` the row
			// names. A token or API key stored on the config would be a
			// second, unmanaged copy of a GitLab grant.
			const isGitLabPersonalServer = isGitLabPersonalMcpServerKey(
				serverKey?.key,
			);
			const credentialColumnsWritable = !isGitLabPersonalServer;
			// A GitLab personal server's config is always stored as OAUTH2,
			// the only auth type those servers offer: every screen and reader
			// then sees one shape. Forced rather than refused, so a client
			// still holding an older API_KEY or NONE row (or a form built from
			// one) can save its other settings; any credential it sends is
			// still refused below.
			const effectiveAuthType = isGitLabPersonalServer
				? "OAUTH2"
				: requestedAuthType;
			if (isGitLabPersonalServer) {
				const suppliedSecret = (value: unknown) =>
					typeof value === "string" && value.length > 0;
				if (
					[
						apiKey,
						encryptedApiKey,
						accessToken,
						encryptedAccessToken,
						refreshToken,
						encryptedRefreshToken,
					].some(suppliedSecret)
				) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"GitLab MCP servers use your GitLab connection and take no API key or token. Connect GitLab from Integrations instead.",
					});
				}
			}

			if (effectiveAuthType === "API_KEY") {
				const hasExistingApiKey = !!existingConfig?.encryptedApiKey;
				const hasNewApiKey =
					typeof apiKey === "string" && apiKey.trim().length > 0;
				const hasEncrypted = !!encryptedApiKey;

				if (!hasExistingApiKey && !hasNewApiKey && !hasEncrypted) {
					throw new ORPCError("BAD_REQUEST", {
						message: "API key is required when authType is API_KEY",
					});
				}
			}

			// OAuth2 validation removed - credentials can be set later via connect.initiate (automatic DCR)
			// or provided manually by the user

			// Validate that non-STDIO servers have a URL configured
			const mcpServerForValidation = await getMcpServerById(mcpServerId);
			if (mcpServerForValidation) {
				const serverTransport = mcpServerForValidation.transport;
				const hasCommand = !!mcpServerForValidation.command;

				// For HTTP/SSE servers (or STDIO without command), require baseUrl or defaultUrl
				if (
					serverTransport !== "STDIO" ||
					(serverTransport === "STDIO" && !hasCommand)
				) {
					const hasBaseUrl =
						typeof input.baseUrl === "string" &&
						input.baseUrl.length > 0;
					const hasDefaultUrl = !!mcpServerForValidation.defaultUrl;
					const hasExistingBaseUrl = !!existingConfig?.baseUrl;

					if (!hasBaseUrl && !hasDefaultUrl && !hasExistingBaseUrl) {
						throw new ORPCError("BAD_REQUEST", {
							message:
								serverTransport === "STDIO"
									? "STDIO servers without a command definition cannot be configured via web"
									: "Base URL is required for HTTP/SSE servers without a default URL",
						});
					}
				}
			}

			// Phase 1: Auto-populate semantic routing metadata for OAuth providers
			// If this is an OAuth2 config and no metadata was provided, inject defaults
			let semanticMetadata = {};
			if (effectiveAuthType === "OAUTH2") {
				// Only populate if user hasn't provided metadata
				const hasUserMetadata =
					input.description ||
					(input.domainKeywords && input.domainKeywords.length > 0) ||
					(input.exampleQueries && input.exampleQueries.length > 0);

				if (!hasUserMetadata) {
					// Get server to determine provider
					const mcpServer = await getMcpServerById(mcpServerId);
					if (mcpServer) {
						const defaults = getOAuthProviderMetadata(
							mcpServer.name,
						);
						if (defaults.description) {
							console.log(
								`[MCP Config] Auto-populating metadata for OAuth provider: ${mcpServer.name}`,
							);
							semanticMetadata = defaults;
						}
					}
				}
			}

			const data: any = {
				...rest,
				...semanticMetadata, // Inject OAuth defaults (only if user didn't provide)
				authType: effectiveAuthType,
				// Only set apiKeyMethod when authType is API_KEY
				apiKeyMethod:
					effectiveAuthType === "API_KEY"
						? (apiKeyMethod ?? "BEARER")
						: undefined,
			};

			// OAuth client and token columns are written through the
			// credential module below, never as part of `data`: a change to
			// where the credentials belong must wipe or rebind them.
			const newClientId =
				typeof oauthClientId === "string" && oauthClientId.length > 0
					? oauthClientId
					: undefined;
			const newClientSecretCiphertext =
				typeof oauthClientSecret === "string" &&
				oauthClientSecret.length > 0
					? encryptApiKey(oauthClientSecret)
					: undefined;
			const clientChanged =
				(newClientId !== undefined &&
					newClientId !== (existingConfig?.oauthClientId ?? null)) ||
				newClientSecretCiphertext !== undefined;
			// A new URL may answer with a different authorization server, so
			// whatever was granted through the old one is not carried over.
			const baseUrlChanged =
				!!existingConfig &&
				rest.baseUrl !== undefined &&
				(rest.baseUrl || null) !== (existingConfig.baseUrl || null);

			// Prefer plaintext -> encrypt; else use provided encrypted values.
			// Only where credential columns are writable (see above).
			if (!credentialColumnsWritable) {
				// Fall through with no credential fields set.
			} else if (typeof apiKey === "string" && apiKey.length > 0) {
				data.encryptedApiKey = encryptApiKey(apiKey);
			} else if (encryptedApiKey !== undefined) {
				data.encryptedApiKey = encryptedApiKey;
			}

			// A hand-imported token set is a whole new grant: the tokens it
			// names replace every token column, and anything it omits is
			// cleared — never kept from the old grant under the import's
			// binding.
			let importedTokens: McpOAuthImportedTokens | null = null;
			let tokensImported = false;
			// How the access token arrived. Only plaintext — encrypted and
			// hashed by the server now — can be a new grant that lifts the
			// refresh circuit breaker; a ciphertext (the shape `configs.list`
			// returns) never can.
			let accessTokenSource: McpOAuthImportSource = "ciphertext";
			if (credentialColumnsWritable) {
				const tokens: McpOAuthImportedTokens = {
					encryptedAccessToken: null,
					accessTokenHash: null,
					encryptedRefreshToken: null,
					tokenExpiresAt: null,
				};
				if (typeof accessToken === "string" && accessToken.length > 0) {
					tokens.encryptedAccessToken = encryptApiKey(accessToken);
					tokens.accessTokenHash = hashApiKey(accessToken);
					accessTokenSource = "plaintext";
					tokensImported = true;
				} else if (encryptedAccessToken !== undefined) {
					tokens.encryptedAccessToken = encryptedAccessToken;
					// Caller passed an already-encrypted token; decrypt it once so
					// we can compute the matching lookup hash. Failing decrypt
					// leaves the hash null — the row will work for everything
					// except bearer-based MCP shim resolution until a refresh.
					if (encryptedAccessToken !== null) {
						try {
							tokens.accessTokenHash = hashApiKey(
								decryptApiKey(encryptedAccessToken),
							);
						} catch {
							tokens.accessTokenHash = null;
						}
					}
					tokensImported = true;
				}
				if (
					typeof refreshToken === "string" &&
					refreshToken.length > 0
				) {
					tokens.encryptedRefreshToken = encryptApiKey(refreshToken);
					tokensImported = true;
				} else if (encryptedRefreshToken !== undefined) {
					tokens.encryptedRefreshToken = encryptedRefreshToken;
					tokensImported = true;
				}
				if (tokensImported) {
					tokens.tokenExpiresAt = tokenExpiresAt ?? null;
				}
				importedTokens = tokensImported ? tokens : null;
			}

			// Moving off OAuth retires the OAuth circuit breaker with it.
			// `needsReauth` describes an OAuth GRANT, and its only exits are a
			// new grant — a successful OAuth reconnect, or importing a usable
			// token set below, whose credential write resets the breaker in the
			// same statement — and an API_KEY / NONE config can perform
			// neither. Left set, the flag would refuse the config
			// at MCP client creation and hide it from tool discovery while the
			// new credential works perfectly, with nothing the user can do
			// about it. Reset the diagnostics alongside it so triage doesn't
			// read a dead grant's strikes as the new credential's.
			//
			// Gated on the STORED type being OAUTH2 so this only fires on an
			// actual departure from OAuth: an OAuth config edited while
			// STAYING OAuth must not be able to launder a condemned grant by
			// touching an unrelated field. (A token import is not an unrelated
			// field: it replaces the grant, and the credential module resets
			// the breaker only when it installs a usable access token.)
			//
			// Only a server that actually OFFERS the target auth type can be
			// moved onto it. Where a server declares OAuth alone — the GitLab
			// catalog entries do — an edit to API_KEY does not move the config
			// off OAuth at all: every consumer of those rows dispatches on
			// `mcpServer.key` and ignores `authType`, so the OAuth token
			// columns stay live and stay in use. Retiring the breaker there
			// would resurrect a condemned grant rather than retire it, and
			// the next request would post the dead refresh token again.
			// Leaving the flag set is the fail-safe direction: the row stays
			// excluded and the integration degrades to REST. An empty
			// `authMethods` declares nothing, so it constrains nothing.
			const serverAuthMethods =
				existingConfig?.mcpServer?.authMethods ?? [];
			const targetAuthTypeSupported =
				serverAuthMethods.length === 0 ||
				serverAuthMethods.includes(effectiveAuthType);

			if (
				existingConfig?.authType === "OAUTH2" &&
				effectiveAuthType !== "OAUTH2" &&
				targetAuthTypeSupported
			) {
				data.needsReauth = false;
				data.refreshFailureCount = 0;
				data.lastRefreshFailedAt = null;
				data.lastRefreshError = null;
				// Only the breaker's own verdict is lifted, so the status only
				// moves when the breaker is what set it. `UNAVAILABLE` on a
				// config that was never condemned came from somewhere else —
				// failed health checks own that column and will re-evaluate it
				// themselves — and reporting it HEALTHY off an unrelated
				// auth-type edit would hide a live problem.
				if (
					existingConfig.needsReauth &&
					existingConfig.status === "UNAVAILABLE"
				) {
					data.status = "HEALTHY";
				}
			}

			// The OAuth credential write, through the credential module.
			// - A client change (or, for an existing config, a URL change)
			//   replaces the registration: the tokens it held are wiped, the
			//   generation moves, and the config is unbound until the connect
			//   flow binds a new grant. A URL change also drops the client,
			//   unless its authorization server does not depend on the URL
			//   (the catalog names it for this server).
			// - Imported tokens are a new grant bound to the catalog's
			//   authorization server when the catalog names one, otherwise
			//   left unbound (and an unbound config is never refreshed).
			// Every credential write is conditional on the generation read
			// above, and for an existing config it lands in the SAME
			// transaction as the settings write: a new URL is never visible
			// with the old URL's credentials.
			const tenantGuard = {
				userId: tenantUserId,
				organizationId: organizationId ?? null,
			};
			const effectiveUrl: string | null =
				(rest.baseUrl !== undefined
					? rest.baseUrl
					: existingConfig?.baseUrl) ||
				serverKey?.defaultUrl ||
				null;
			// Imported tokens are bound only to an AS configured independently
			// of the person (a system catalog row or Fabric's known table);
			// tokens imported with a newly entered client go with that client.
			const importBinding = tokensImported
				? independentBindingFor(serverKey ?? {}, effectiveUrl)
				: null;
			const needsRegistrationReplacement =
				clientChanged || baseUrlChanged;
			const credentialChange =
				needsRegistrationReplacement || tokensImported;

			const replacementClient = () => {
				if (clientChanged) {
					const clientId: string | null =
						newClientId ?? existingConfig?.oauthClientId ?? null;
					if (!clientId) {
						return null;
					}
					// A secret never carries over to a different client id.
					const sameClient =
						clientId === existingConfig?.oauthClientId;
					return {
						oauthClientId: clientId,
						encryptedOauthClientSecret:
							newClientSecretCiphertext ??
							(sameClient
								? (existingConfig?.encryptedOauthClientSecret ??
									null)
								: null),
						// A hand-entered client: the method Fabric has always
						// used for those, recorded explicitly.
						dcrClientMetadata: explicitClientMetadata(),
						dcrRegistrationEndpoint: null,
						dcrRegisteredAt: null,
					};
				}
				// URL change only: keep the client only when its authorization
				// server does not come from the URL, and only a client still
				// matching its binding's fingerprint (one replaced by a writer
				// outside the credential module is dropped, not re-bound).
				if (
					existingConfig?.oauthClientId &&
					independentBindingFor(serverKey ?? {}, null) &&
					isStoredMcpOAuthClientTrusted(
						storedCredentialsOf(existingConfig),
					)
				) {
					return {
						oauthClientId: existingConfig.oauthClientId,
						encryptedOauthClientSecret:
							existingConfig.encryptedOauthClientSecret ?? null,
						dcrClientMetadata:
							(existingConfig.dcrClientMetadata as Record<
								string,
								unknown
							> | null) ?? null,
						dcrRegistrationEndpoint:
							existingConfig.dcrRegistrationEndpoint ?? null,
						dcrRegisteredAt: existingConfig.dcrRegisteredAt ?? null,
					};
				}
				return null;
			};

			// The access token a row held when it was read at the generation
			// the write is fenced on: an import compares against it (the same
			// token re-submitted is not a new grant), and the write is also
			// fenced on it.
			const storedAccessTokenOf = (row: {
				encryptedAccessToken?: string | null;
				accessTokenHash?: string | null;
				tokenExpiresAt?: Date | null;
			}): McpOAuthStoredAccessToken => ({
				encryptedAccessToken: row.encryptedAccessToken ?? null,
				accessTokenHash: row.accessTokenHash ?? null,
				tokenExpiresAt: row.tokenExpiresAt ?? null,
			});
			// The credentials a row held when it was read: an import that keeps
			// its client is fenced on it, and fingerprints the new binding with
			// it only when it still matched the row's binding.
			const storedCredentialsOf = (row: {
				oauthClientId?: string | null;
				encryptedOauthClientSecret?: string | null;
				encryptedRefreshToken?: string | null;
				oauthBinding?: unknown;
			}): McpOAuthStoredCredentials => ({
				oauthClientId: row.oauthClientId ?? null,
				encryptedOauthClientSecret:
					row.encryptedOauthClientSecret ?? null,
				encryptedRefreshToken: row.encryptedRefreshToken ?? null,
				oauthBinding: row.oauthBinding ?? null,
			});

			const writeCredentials = async (
				configRowId: string,
				expectedGeneration: number,
				storedAccessToken: McpOAuthStoredAccessToken,
				stored: McpOAuthStoredCredentials,
				tx?: Parameters<typeof replaceMcpOAuthRegistration>[0]["tx"],
			) => {
				const client = needsRegistrationReplacement
					? replacementClient()
					: null;
				// A URL change that carries the stored client over keeps it,
				// rather than entering a new one: the credential module then
				// fingerprints it under the new binding only when that names the
				// AS and token endpoint the client is verified for.
				const keptClient =
					needsRegistrationReplacement && !clientChanged && client
						? stored
						: undefined;
				// Whenever tokens are imported, the import rule decides the
				// binding: the independent pinned AS, else bearer-only. A custom
				// row's editable endpoints never receive an imported refresh
				// token — not even when the same save also enters a client. If
				// the save enters a client too, bearer-only wins for this save,
				// and the client is bound at its next OAuth start/callback.
				//
				// A client entered by hand WITHOUT tokens is bound when it is
				// entered: to the independent AS, or on a custom server to the
				// endpoints it names now. Changing those endpoints later removes
				// the client.
				//
				// A client carried over a URL change keeps the independent AS's
				// binding it was verified for (the module re-checks that).
				const replacementBinding = tokensImported
					? (importBinding ?? bearerOnlyOAuthMarker())
					: clientChanged && client
						? enteredClientBindingFor(serverKey ?? {}, effectiveUrl)
						: keptClient
							? // The AS that let it be carried (not the URL's).
								independentBindingFor(serverKey ?? {}, null)
							: null;
				const written = needsRegistrationReplacement
					? await replaceMcpOAuthRegistration({
							configId: configRowId,
							tenant: tenantGuard,
							expectedGeneration,
							client,
							keptClient,
							binding: replacementBinding,
							tokens: importedTokens,
							storedAccessToken,
							accessTokenSource,
							tx,
						})
					: await importMcpOAuthTokens({
							configId: configRowId,
							tenant: tenantGuard,
							expectedGeneration,
							tokens: importedTokens,
							binding: replacementBinding,
							storedAccessToken,
							stored,
							accessTokenSource,
							tx,
						});
				if (!written.written) {
					throw new ORPCError("CONFLICT", {
						message:
							"This MCP connection changed while it was being saved. Reload and try again.",
					});
				}
			};

			const { apiKeyMethod: dataApiKeyMethod, ...restData } = data;
			const updateData =
				dataApiKeyMethod === null
					? restData
					: {
							...restData,
							...(dataApiKeyMethod !== undefined
								? { apiKeyMethod: dataApiKeyMethod }
								: {}),
						};

			let record: any;
			if (existingConfig && (configId || credentialChange)) {
				// Update by id. With a credential change the settings write and
				// the credential write are one transaction.
				const targetId: string = existingConfig.id;
				const writeSettings = async (client: typeof db) => {
					// Defense-in-depth: verify tenant ownership at write time
					const updated = await client.mCPConfig.updateMany({
						where: {
							id: targetId,
							userId: tenantUserId,
							organizationId: organizationId ?? null,
						},
						data: updateData,
					});
					if (updated.count === 0) {
						throw new ORPCError("FORBIDDEN", {
							message: "MCP config not found or not owned by you",
						});
					}
				};
				if (credentialChange) {
					await db.$transaction(async (tx) => {
						await writeSettings(tx as unknown as typeof db);
						await writeCredentials(
							targetId,
							existingConfig.oauthGrantGeneration,
							storedAccessTokenOf(existingConfig),
							storedCredentialsOf(existingConfig),
							tx,
						);
					});
				} else {
					await writeSettings(db);
				}
				record = await db.mCPConfig.findUniqueOrThrow({
					where: { id: targetId },
					include: { mcpServer: true },
				});
			} else {
				record = forceCreate
					? // Always create a new config
						await createMcpConfig({
							mcpServerId,
							userId: tenantUserId,
							organizationId,
							data,
						})
					: // Default upsert behavior (backward compat for OAuth callbacks, etc.)
						await upsertMcpConfig({
							mcpServerId,
							userId: tenantUserId,
							organizationId,
							data,
						});
				if (credentialChange) {
					// A new row: it holds no earlier credential to retire.
					await writeCredentials(
						record.id,
						record.oauthGrantGeneration ?? 0,
						storedAccessTokenOf(record),
						storedCredentialsOf(record),
					);
					record = await db.mCPConfig.findUniqueOrThrow({
						where: { id: record.id },
						include: { mcpServer: true },
					});
				}
			}

			// Trigger tool ingestion workflow if config is enabled
			// AI credentials are fetched inside the workflow activities for proper tenant isolation
			// NOTE: For OAuth2 configs, only trigger if we have valid tokens (access token exists)
			// OAuth callback will trigger ingestion after successful authentication
			// GitLab personal servers hold no token of their own: ingestion
			// runs with the person's GitLab connection, so that connection
			// being usable is what decides, whatever the config's auth type.
			const isOAuth2 = record.authType === "OAUTH2";
			const credentialReady = !record.enabled
				? false
				: isGitLabPersonalServer
					? (await findUsableGitLabConnection({
							userId: tenantUserId,
							organizationId: organizationId ?? null,
						})) !== null
					: !isOAuth2 || !!record.encryptedAccessToken;
			const shouldIngest = record.enabled && credentialReady;

			if (shouldIngest) {
				try {
					// Get server name for the workflow
					const mcpServer = await getMcpServerById(mcpServerId);
					const serverName =
						record.displayName || mcpServer?.name || mcpServerId;

					await triggerMcpToolIngestion({
						mcpConfigId: record.id,
						serverName,
						userId: tenantUserId,
						organizationId,
					});
					console.log(
						`[MCP Config] Triggered tool ingestion for ${serverName}`,
					);

					// Phase 1: Also index server metadata for semantic server selection
					await triggerMcpServerIngestion({
						mcpConfigId: record.id,
						serverName,
						userId: tenantUserId,
						organizationId,
					});
					console.log(
						`[MCP Config] Triggered server ingestion for ${serverName}`,
					);
				} catch (error) {
					// Log but don't fail the config creation
					console.warn(
						"[MCP Config] Failed to trigger ingestion:",
						error,
					);
				}
			} else if (record.enabled && isGitLabPersonalServer) {
				console.log(
					"[MCP Config] Skipping tool ingestion for GitLab config - GitLab is not connected",
				);
			} else if (record.enabled && isOAuth2) {
				console.log(
					"[MCP Config] Skipping tool ingestion for OAuth2 config - tokens not yet available",
				);
			}

			return record;
		}),

	delete: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_DELETE))
		.route({
			method: "DELETE",
			path: "/mcp/configs/:id",
			tags: ["MCP"],
			summary: "Delete MCP config",
		})
		.input(
			z.object({
				id: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.object({ success: z.boolean() }))
		.handler(async ({ input, context }) => {
			const user = context.user;
			const { id, organizationId } = input;

			// Verify org membership if org context
			if (organizationId) {
				const membership = await verifyOrganizationMembership(
					organizationId,
					user.id,
				);

				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}
			}

			// Use tenant-filtered query - access control is now handled at query level
			const config = await getMcpConfigById(id, {
				userId: user.id,
				organizationId: organizationId ?? undefined,
			});

			if (!config) {
				return { success: true };
			}

			// System-managed default configs (seeded for every tenant) must not
			// be deleted — the orchestrator's eager-routing relies on the row
			// existing. The UI hides the Delete button for these rows; this is
			// the platform-level enforcement for direct API callers.
			if (config.isManagedDefault) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"This configuration is managed by Fabric and cannot be deleted.",
				});
			}

			// Get server name before deletion for cleanup
			const serverName =
				config.displayName || config.mcpServer?.name || config.id;
			const configUserId = config.userId;
			const configOrgId = config.organizationId;

			// GitLab personal servers: Delete is the one personal GitLab
			// disconnect plus `enabled: false`. The row and its client
			// registration are kept so a reconnect reuses them; project
			// repository links are untouched.
			if (isGitLabPersonalMcpServerKey(config.mcpServer?.key)) {
				// The disconnect writes in the config's organization: check the
				// caller's membership and role there, and refuse a config with
				// no organization rather than disconnect into one.
				await authorizeInputOrganization(
					Permissions.MCP_DELETE,
					config.organizationId,
					context,
					{ requireOrganization: true },
				);
				await removeGitLabPersonalMcpConfig({
					config,
					surface: "mcp.configs.delete",
					audit: context,
				});
				// No tool-deletion workflow here, deliberately. It deletes the
				// indexed tools by server name, user and organization only, and
				// it starts after the disconnect has committed and revocation
				// has been awaited — so a reconnect landing in between would
				// have its freshly ingested tools deleted. The row is kept and
				// turned off instead, and turned-off configs are neither offered
				// nor run:
				//  - every read of the tool index drops tools whose config row
				//    is off now (`findDisabledMcpConfigIds` in temporal
				//    `tool-index.ts`: Qdrant search, Qdrant load, in-memory
				//    search); live index builds query enabled configs only;
				//  - a new MCP client refuses a turned-off config
				//    (`createMcpClientForConfig`, CONFIG_DISABLED), and a cached
				//    GitLab client is re-checked before each use and dropped
				//    when its config is off or the connection is not the one it
				//    was built with (`isCachedGitLabClientUsable`).
				// Turning the server back on re-ingests its tools (the toggle
				// below).
				return { success: true };
			}

			await deleteMcpConfig(id);

			// Audit the credential-config deletion (SOC 2 CC7.2). Fire-and-forget
			// so an audit hiccup never blocks the delete.
			try {
				await recordAudit({
					action: "mcp.config.deleted",
					category: "mcp",
					severity: "warning",
					actor: {
						type: "user",
						userId: user.id,
						emailSnapshot: user.email ?? null,
						nameSnapshot: user.name ?? null,
					},
					organizationId: configOrgId ?? null,
					resource: {
						type: "mcp_config",
						id,
						name: serverName,
					},
				});
			} catch (auditErr) {
				console.error(
					"[MCP Config] audit write failed (mcp.config.deleted)",
					auditErr,
				);
			}

			// Delete-time integrity guardrail: clear the now-dead config id from any
			// report instance bindings that reference it. The query never throws;
			// run-time resolution also self-heals, so this just keeps stored data +
			// the UI honest (no more dangling bindings after a delete).
			const clearedFrom = await clearMcpConfigFromReportInstances(id);
			if (clearedFrom > 0) {
				console.log(
					`[MCP Config] Cleared deleted config ${id} from ${clearedFrom} report instance(s)`,
				);
			}

			// Trigger tool deletion workflow to clean up Qdrant
			try {
				// Need userId for tenant isolation - use config's userId or the user who deleted it
				const tenantUserId = configUserId || user.id;
				await triggerMcpToolDeletion({
					serverName,
					userId: tenantUserId,
					organizationId: configOrgId || undefined,
				});
				console.log(
					`[MCP Config] Triggered tool deletion for ${serverName}`,
				);
			} catch (error) {
				// Log but don't fail the deletion
				console.warn(
					"[MCP Config] Failed to trigger tool deletion:",
					error,
				);
			}

			return { success: true };
		}),

	createSession: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_CONNECT))
		.route({
			method: "POST",
			path: "/mcp/configs/:id/session",
			tags: ["MCP"],
			summary: "Create short-lived MCP client session token",
		})
		.input(
			z.object({
				id: z.string(),
				organizationId: z.string().nullable().optional(),
				ttlMinutes: z.number().min(5).max(60).default(15),
			}),
		)
		.output(z.object({ token: z.string(), expiresAt: z.date() }))
		.handler(async ({ input, context }) => {
			const user = context.user;
			const { id, organizationId, ttlMinutes } = input;

			// Use tenant-filtered query - access control is now handled at query level
			const config = await getMcpConfigById(id, {
				userId: user.id,
				organizationId: organizationId ?? undefined,
			});

			if (!config) {
				throw new ORPCError("NOT_FOUND", {
					message: "MCP config not found",
				});
			}

			const { token, expiresAt } = await createMcpClientSession({
				configId: id,
				userId: user.id,
				organizationId: organizationId ?? undefined,
				ttlMinutes,
			});
			return { token, expiresAt };
		}),

	toggle: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_UPDATE))
		.route({
			method: "PATCH",
			path: "/mcp/configs/:id/enabled",
			tags: ["MCP"],
			summary: "Enable or disable an MCP config",
		})
		.input(
			z.object({
				id: z.string(),
				enabled: z.boolean(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(z.object({ success: z.boolean(), enabled: z.boolean() }))
		.handler(async ({ input, context }) => {
			const { id, enabled, organizationId } = input;
			const user = context.user;

			// Verify org membership and admin role if org context
			if (organizationId) {
				const membership = await verifyOrganizationMembership(
					organizationId,
					user.id,
				);

				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}
			}

			// Use tenant-filtered query - access control is now handled at query level
			const config = await getMcpConfigById(id, {
				userId: user.id,
				organizationId: organizationId ?? undefined,
			});
			if (!config) {
				throw new ORPCError("NOT_FOUND", {
					message: "MCP config not found",
				});
			}

			// System-managed default configs are always-on; the toggle is
			// hidden in the UI and rejected at the API layer to preserve
			// Q10's "no opt-out" guarantee for any direct caller.
			if (config.isManagedDefault) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"This configuration is managed by Fabric and cannot be toggled.",
				});
			}

			const updated = await updateMcpConfigEnabled({ id, enabled });

			// Trigger tool ingestion when enabling, or deletion when disabling
			// AI credentials are fetched inside the workflow activities for proper tenant isolation
			if (enabled) {
				try {
					const mcpServer = await getMcpServerById(
						config.mcpServerId,
						{
							userId: user.id,
							organizationId: organizationId ?? undefined,
						},
					);
					const serverName =
						config.displayName ||
						mcpServer?.name ||
						config.mcpServerId;

					await triggerMcpToolIngestion({
						mcpConfigId: id,
						serverName,
						userId: config.userId || user.id,
						organizationId: config.organizationId || undefined,
					});
					console.log(
						`[MCP Config] Triggered tool ingestion for ${serverName} (toggle enabled)`,
					);
				} catch (error) {
					console.warn(
						"[MCP Config] Failed to trigger tool ingestion on toggle:",
						error,
					);
				}
			} else {
				// When disabling, delete the tools from Qdrant
				try {
					const mcpServer = await getMcpServerById(
						config.mcpServerId,
						{
							userId: user.id,
							organizationId: organizationId ?? undefined,
						},
					);
					const serverName =
						config.displayName ||
						mcpServer?.name ||
						config.mcpServerId;

					await triggerMcpToolDeletion({
						serverName,
						userId: config.userId || user.id,
						organizationId: config.organizationId || undefined,
					});
					console.log(
						`[MCP Config] Triggered tool deletion for ${serverName} (toggle disabled)`,
					);
				} catch (error) {
					console.warn(
						"[MCP Config] Failed to trigger tool deletion on toggle:",
						error,
					);
				}
			}

			return { success: true, enabled: updated.enabled };
		}),
};
