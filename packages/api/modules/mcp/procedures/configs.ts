import { ORPCError } from "@orpc/server";
import {
	clearMcpConfigFromReportInstances,
	createMcpClientSession,
	createMcpConfig,
	db,
	deleteMcpConfig,
	getMcpConfigById,
	getMcpConfigForTenantAndServer,
	getMcpServerById,
	getOrganizationById,
	listMcpConfigsForTenant,
	recordAudit,
	updateMcpConfigEnabled,
	upsertMcpConfig,
} from "@repo/database";
import {
	triggerMcpServerIngestion,
	triggerMcpToolDeletion,
	triggerMcpToolIngestion,
} from "@repo/temporal";
import { decryptApiKey, encryptApiKey, hashApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

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

			const effectiveAuthType =
				input.authType ?? existingConfig?.authType ?? "NONE";

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

			if (oauthClientId) {
				data.oauthClientId = oauthClientId;
			} else if (
				existingConfig?.oauthClientId &&
				effectiveAuthType === "OAUTH2"
			) {
				data.oauthClientId = existingConfig.oauthClientId;
			}

			if (
				typeof oauthClientSecret === "string" &&
				oauthClientSecret.length > 0
			) {
				data.encryptedOauthClientSecret =
					encryptApiKey(oauthClientSecret);
			}

			// Prefer plaintext -> encrypt; else use provided encrypted values
			if (typeof apiKey === "string" && apiKey.length > 0) {
				data.encryptedApiKey = encryptApiKey(apiKey);
			} else if (encryptedApiKey !== undefined) {
				data.encryptedApiKey = encryptedApiKey;
			}
			if (typeof accessToken === "string" && accessToken.length > 0) {
				data.encryptedAccessToken = encryptApiKey(accessToken);
				data.accessTokenHash = hashApiKey(accessToken);
			} else if (encryptedAccessToken !== undefined) {
				data.encryptedAccessToken = encryptedAccessToken;
				// Caller passed an already-encrypted token; decrypt it once so
				// we can compute the matching lookup hash. Failing decrypt
				// leaves the hash null — the row will work for everything
				// except bearer-based MCP shim resolution until a refresh.
				if (encryptedAccessToken === null) {
					data.accessTokenHash = null;
				} else {
					try {
						data.accessTokenHash = hashApiKey(
							decryptApiKey(encryptedAccessToken),
						);
					} catch {
						data.accessTokenHash = null;
					}
				}
			}
			if (typeof refreshToken === "string" && refreshToken.length > 0) {
				data.encryptedRefreshToken = encryptApiKey(refreshToken);
			} else if (encryptedRefreshToken !== undefined) {
				data.encryptedRefreshToken = encryptedRefreshToken;
			}

			// Moving off OAuth retires the OAuth circuit breaker with it.
			// `needsReauth` describes an OAuth GRANT, and its only exit is a
			// successful OAuth reconnect — something an API_KEY / NONE config
			// has no way to perform. Left set, the flag would refuse the config
			// at MCP client creation and hide it from tool discovery while the
			// new credential works perfectly, with nothing the user can do
			// about it. Reset the diagnostics alongside it so triage doesn't
			// read a dead grant's strikes as the new credential's.
			//
			// Gated on the STORED type being OAUTH2 so this only fires on an
			// actual departure from OAuth: an OAuth config edited while
			// STAYING OAuth must not be able to launder a condemned grant by
			// touching an unrelated field.
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

			let record: any;
			if (configId && existingConfig) {
				// Explicit update by config ID
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
				// Defense-in-depth: verify tenant ownership at write time
				const updated = await db.mCPConfig.updateMany({
					where: {
						id: configId,
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
				record = await db.mCPConfig.findUniqueOrThrow({
					where: { id: configId },
					include: { mcpServer: true },
				});
			} else if (forceCreate) {
				// Always create a new config
				record = await createMcpConfig({
					mcpServerId,
					userId: tenantUserId,
					organizationId,
					data,
				});
			} else {
				// Default upsert behavior (backward compat for OAuth callbacks, etc.)
				record = await upsertMcpConfig({
					mcpServerId,
					userId: tenantUserId,
					organizationId,
					data,
				});
			}

			// Trigger tool ingestion workflow if config is enabled
			// AI credentials are fetched inside the workflow activities for proper tenant isolation
			// NOTE: For OAuth2 configs, only trigger if we have valid tokens (access token exists)
			// OAuth callback will trigger ingestion after successful authentication
			const isOAuth2 = record.authType === "OAUTH2";
			const hasOAuthTokens = !!record.encryptedAccessToken;
			const shouldIngest =
				record.enabled && (!isOAuth2 || hasOAuthTokens);

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
			} else if (isOAuth2 && !hasOAuthTokens) {
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
