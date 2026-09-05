/**
 * MCP Connect Procedures
 *
 * Provides endpoints for initiating MCP server connections.
 * This supports the Composio-like pattern of dynamically prompting
 * users to connect integrations when needed.
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { getBaseUrl } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

/**
 * Get connection info for an MCP server.
 * Returns the auth type and connect URL for OAuth servers.
 */
export const connectProcedures = {
	/**
	 * Get info needed to connect to an MCP server
	 */
	getConnectInfo: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_READ))
		.route({
			method: "GET",
			path: "/mcp/connect/:serverId/info",
			tags: ["MCP"],
			summary: "Get MCP server connection info",
		})
		.input(
			z.object({
				serverId: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.object({
				serverId: z.string(),
				serverName: z.string(),
				authType: z.enum(["NONE", "API_KEY", "OAUTH2"]),
				isConnected: z.boolean(),
				needsReauth: z.boolean(),
				oauthStartUrl: z.string().url().optional(),
				configId: z.string().optional(),
				iconUrl: z.string().optional(),
				description: z.string().optional(),
				defaultUrl: z.string().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { serverId, organizationId } = input;

			// Verify org membership if in org context
			if (organizationId) {
				const membership = await verifyOrganizationMembership(
					organizationId,
					userId,
				);
				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}
			}

			// Get the MCP server
			const server = await db.mCPServer.findUnique({
				where: { id: serverId },
				select: {
					id: true,
					name: true,
					description: true,
					defaultUrl: true,
					authMethods: true,
					iconUrl: true,
					isSystemProvided: true,
				},
			});

			if (!server) {
				throw new ORPCError("NOT_FOUND", {
					message: "MCP server not found",
				});
			}

			// Get user's most recent config for this server
			const config = await db.mCPConfig.findFirst({
				where: {
					mcpServerId: serverId,
					userId,
					organizationId: organizationId ?? null,
				},
				select: {
					id: true,
					authType: true,
					encryptedApiKey: true,
					encryptedAccessToken: true,
					tokenExpiresAt: true,
					needsReauth: true,
				},
				orderBy: { updatedAt: "desc" },
			});

			// Determine auth type from server
			const preferredAuthType = server.authMethods.includes("OAUTH2")
				? "OAUTH2"
				: server.authMethods.includes("API_KEY")
					? "API_KEY"
					: "NONE";

			// Check if connected
			let isConnected = false;
			let needsReauth = false;

			if (config) {
				needsReauth = config.needsReauth;

				if (config.authType === "NONE") {
					isConnected = true;
				} else if (config.authType === "API_KEY") {
					isConnected = !!config.encryptedApiKey;
				} else if (config.authType === "OAUTH2") {
					if (!config.encryptedAccessToken) {
						isConnected = false;
					} else if (config.tokenExpiresAt) {
						// Check if token is expired (with 5 min buffer)
						const expirationBuffer = 5 * 60 * 1000;
						const isExpired =
							new Date(config.tokenExpiresAt).getTime() -
								expirationBuffer <
							Date.now();
						isConnected = !isExpired && !needsReauth;
					} else {
						isConnected = !needsReauth;
					}
				}
			}

			// Build OAuth start URL if needed
			let oauthStartUrl: string | undefined;
			if (preferredAuthType === "OAUTH2" && !isConnected) {
				// Get the site URL from environment
				const siteUrl =
					process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3001";
				// Slug-less on purpose. This segment resolves by SLUG, and the
				// organization ID interpolated here produced a 404 — but the
				// slug is not available in a procedure that only knows the id.
				// `/app/settings/mcp` is the redirect that resolves the
				// caller's organization server-side, which is the case it was
				// kept for: a link built where no slug can be known.
				const basePath = "/app/settings/mcp";
				// The OAuth start URL should point to the MCP settings page where user can initiate OAuth
				oauthStartUrl = `${siteUrl}${basePath}?connect=${serverId}`;
			}

			return {
				serverId: server.id,
				serverName: server.name,
				authType: preferredAuthType as "NONE" | "API_KEY" | "OAUTH2",
				isConnected,
				needsReauth,
				oauthStartUrl,
				configId: config?.id,
				iconUrl: server.iconUrl ?? undefined,
				description: server.description ?? undefined,
				defaultUrl: server.defaultUrl ?? undefined,
			};
		}),

	/**
	 * Get connection status for multiple MCP servers at once
	 */
	getConnectionStatus: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_READ))
		.route({
			method: "POST",
			path: "/mcp/connect/status",
			tags: ["MCP"],
			summary: "Get connection status for multiple MCP servers",
		})
		.input(
			z.object({
				serverIds: z.array(z.string()),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.output(
			z.array(
				z.object({
					serverId: z.string(),
					serverName: z.string(),
					authType: z.enum(["NONE", "API_KEY", "OAUTH2"]),
					isConnected: z.boolean(),
					needsReauth: z.boolean(),
				}),
			),
		)
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { serverIds, organizationId } = input;

			// Verify org membership if in org context
			if (organizationId) {
				const membership = await verifyOrganizationMembership(
					organizationId,
					userId,
				);
				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}
			}

			// Get all servers
			const servers = await db.mCPServer.findMany({
				where: { id: { in: serverIds } },
				select: {
					id: true,
					name: true,
					authMethods: true,
				},
			});

			// Get user's configs for these servers (most recently updated first)
			const configs = await db.mCPConfig.findMany({
				where: {
					mcpServerId: { in: serverIds },
					userId,
					organizationId: organizationId ?? null,
				},
				select: {
					mcpServerId: true,
					authType: true,
					encryptedApiKey: true,
					encryptedAccessToken: true,
					tokenExpiresAt: true,
					needsReauth: true,
				},
				orderBy: { updatedAt: "desc" },
			});

			// Create a map for quick lookup (first entry per server wins = most recently updated)
			const configMap = new Map<string, (typeof configs)[number]>();
			for (const c of configs) {
				if (!configMap.has(c.mcpServerId)) {
					configMap.set(c.mcpServerId, c);
				}
			}

			// Build response
			return servers.map((server) => {
				const config = configMap.get(server.id);

				const preferredAuthType = server.authMethods.includes("OAUTH2")
					? "OAUTH2"
					: server.authMethods.includes("API_KEY")
						? "API_KEY"
						: "NONE";

				let isConnected = false;
				let needsReauth = false;

				if (config) {
					needsReauth = config.needsReauth;

					if (config.authType === "NONE") {
						isConnected = true;
					} else if (config.authType === "API_KEY") {
						isConnected = !!config.encryptedApiKey;
					} else if (config.authType === "OAUTH2") {
						if (!config.encryptedAccessToken) {
							isConnected = false;
						} else if (config.tokenExpiresAt) {
							const expirationBuffer = 5 * 60 * 1000;
							const isExpired =
								new Date(config.tokenExpiresAt).getTime() -
									expirationBuffer <
								Date.now();
							isConnected = !isExpired && !needsReauth;
						} else {
							isConnected = !needsReauth;
						}
					}
				}

				return {
					serverId: server.id,
					serverName: server.name,
					authType: preferredAuthType as
						| "NONE"
						| "API_KEY"
						| "OAUTH2",
					isConnected,
					needsReauth,
				};
			});
		}),

	/**
	 * Start OAuth flow for a workflow integration
	 * This is used by the orchestrator to connect integrations on-the-fly
	 */
	startIntegrationOAuth: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_CONNECT))
		.route({
			method: "POST",
			path: "/mcp/connect/integration/oauth/start",
			tags: ["MCP", "Integrations"],
			summary: "Start OAuth flow for a workflow integration",
		})
		.input(
			z.object({
				provider: z.enum([
					"GITHUB",
					"SLACK",
					"GOOGLE_DRIVE",
					"MICROSOFT_GRAPH",
					"NOTION",
				]),
				organizationId: z.string().nullable().optional(),
				returnUrl: z.string().optional(),
			}),
		)
		.output(
			z.object({
				authorizationUrl: z.string().url(),
				provider: z.string(),
			}),
		)
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { provider, organizationId, returnUrl } = input;

			// Verify org membership if in org context
			if (organizationId) {
				const membership = await verifyOrganizationMembership(
					organizationId,
					userId,
				);
				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "You are not a member of this organization",
					});
				}
			}

			// Import OAuth utilities
			const { encodeOAuthState } = await import(
				"../../integrations/lib/oauth-state"
			);
			const {
				getOAuthProvider,
				getOAuthCredentials,
				generateAuthorizationUrl,
			} = await import("../../integrations/lib/oauth-providers");

			// Get provider config
			const providerConfig = getOAuthProvider(
				provider as
					| "GITHUB"
					| "SLACK"
					| "GOOGLE_DRIVE"
					| "MICROSOFT_GRAPH"
					| "NOTION",
			);
			if (!providerConfig) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Unknown OAuth provider: ${provider}`,
				});
			}

			// Get credentials from environment
			const { clientId, clientSecret } =
				getOAuthCredentials(providerConfig);
			if (!clientId || !clientSecret) {
				throw new ORPCError("BAD_REQUEST", {
					message: `${providerConfig.name} OAuth not configured. Missing ${providerConfig.clientIdEnvVar} or ${providerConfig.clientSecretEnvVar}`,
				});
			}

			// Build redirect URI - use a generic callback that handles all OAuth providers.
			// NEXT_PUBLIC_APP_URL stays as an explicit override; otherwise use the
			// canonical site URL so local dev (where neither NEXT_PUBLIC_APP_URL nor
			// APP_URL is set) and the Aspire dev tunnel produce a usable callback.
			const baseUrl = process.env.NEXT_PUBLIC_APP_URL || getBaseUrl();
			const redirectUri = `${baseUrl}/api/integrations/${provider.toLowerCase()}/oauth/callback`;

			// Encode state for security
			const state = encodeOAuthState({
				userId,
				organizationId: organizationId ?? undefined,
				provider: provider.toLowerCase(),
				returnUrl,
				redirectUri,
			});

			// Generate authorization URL using the generic helper
			const authorizationUrl = generateAuthorizationUrl(
				providerConfig,
				clientId,
				redirectUri,
				state,
			);

			return { authorizationUrl, provider };
		}),
};
