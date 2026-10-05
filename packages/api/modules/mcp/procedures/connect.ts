/**
 * MCP Connect Procedures
 *
 * Provides endpoints for initiating MCP server connections.
 * This supports the Composio-like pattern of dynamically prompting
 * users to connect integrations when needed.
 */

import { ORPCError } from "@orpc/server";
import { db, isGitLabPersonalMcpServerKey } from "@repo/database";
import { preferredMcpServerAuthType } from "@repo/database/prisma/queries/lib/gitlab-personal-keys";
import { getGitLabConnectionStatus } from "@repo/integrations/gitlab";
import { getBaseUrl } from "@repo/utils";
import { z } from "zod";
import {
	authorizeInputOrganization,
	Permissions,
	requirePermission,
	resolveOrganizationIdForCaller,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertOAuthStartOrganization } from "../../integrations/lib/oauth-start-organization";

/**
 * The organization both procedures act in, resolved and authorized once,
 * before any query: the input's, else a guest write organization, else the
 * session's (`authorizeInputOrganization`), with the caller's membership and
 * MCP_READ checked there. An omitted input therefore means the session's
 * organization, as on every other surface. One is required: MCP configs and
 * the GitLab connection live in an organization (ADR-018), so an explicit
 * `null`, or nothing to resolve, is refused before anything is read, rather
 * than reading a no-organization row.
 */
async function authorizedConnectOrganization(
	inputOrganizationId: string | null | undefined,
	context: Parameters<typeof authorizeInputOrganization>[2],
): Promise<string> {
	// With `requireOrganization`, a request that resolves none is refused
	// there (MISSING_ORGANIZATION_CONTEXT), so what returns is always set.
	return (await authorizeInputOrganization(
		Permissions.MCP_READ,
		inputOrganizationId,
		context,
		{ requireOrganization: true },
	)) as string;
}

/**
 * Connection state of a GitLab personal MCP server: the person's GitLab
 * connection in the (authorized) organization, since those configs hold no
 * credential of their own. It does not depend on whether the person has a
 * config row for the server; whether one exists, and whether it is turned
 * on, are reported separately (`configProvisioned`, `configEnabled`).
 */
async function gitlabConnectionState(
	userId: string,
	organizationId: string,
): Promise<{ isConnected: boolean; needsReauth: boolean }> {
	const status = await getGitLabConnectionStatus({ userId, organizationId });
	return {
		isConnected: status.connected && !status.needsReauth,
		needsReauth: status.connected && status.needsReauth,
	};
}

/**
 * A GitLab personal server: its state is the person's connection, never its
 * config's token columns (which hold no token), whatever auth type the config
 * or the server names.
 */
function isGitLabPersonalServer(server: { key: string | null }): boolean {
	return isGitLabPersonalMcpServerKey(server.key);
}

/** Connection state of any other server, from its own config row. */
function configConnectionState(
	config:
		| {
				authType: string;
				encryptedApiKey: string | null;
				encryptedAccessToken: string | null;
				tokenExpiresAt: Date | null;
				needsReauth: boolean;
		  }
		| null
		| undefined,
): { isConnected: boolean; needsReauth: boolean } {
	if (!config) {
		return { isConnected: false, needsReauth: false };
	}
	const needsReauth = config.needsReauth;
	if (config.authType === "NONE") {
		return { isConnected: true, needsReauth };
	}
	if (config.authType === "API_KEY") {
		return { isConnected: !!config.encryptedApiKey, needsReauth };
	}
	if (config.authType === "OAUTH2") {
		if (!config.encryptedAccessToken) {
			return { isConnected: false, needsReauth };
		}
		if (config.tokenExpiresAt) {
			// Expired, with a 5 minute buffer.
			const expirationBuffer = 5 * 60 * 1000;
			const isExpired =
				new Date(config.tokenExpiresAt).getTime() - expirationBuffer <
				Date.now();
			return { isConnected: !isExpired && !needsReauth, needsReauth };
		}
		return { isConnected: !needsReauth, needsReauth };
	}
	return { isConnected: false, needsReauth };
}

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
				/** Whether the person has a config row for this server here. */
				configProvisioned: z.boolean(),
				/**
				 * Whether that row is turned on. A server is usable only
				 * when connected, provisioned AND enabled: a turned-off
				 * row's tools are neither offered nor run.
				 */
				configEnabled: z.boolean(),
				/**
				 * The organization this was resolved and authorized in. A
				 * caller that goes on to write (add the server, start its
				 * sign-in) writes there, not in whatever it passed (which
				 * may have been nothing, resolving the session's).
				 */
				organizationId: z.string(),
				iconUrl: z.string().optional(),
				description: z.string().optional(),
				defaultUrl: z.string().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { serverId } = input;
			const organizationId = await authorizedConnectOrganization(
				input.organizationId,
				context,
			);

			// Get the MCP server
			const server = await db.mCPServer.findUnique({
				where: { id: serverId },
				select: {
					id: true,
					key: true,
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
					organizationId,
				},
				select: {
					id: true,
					enabled: true,
					authType: true,
					encryptedApiKey: true,
					encryptedAccessToken: true,
					tokenExpiresAt: true,
					needsReauth: true,
				},
				orderBy: { updatedAt: "desc" },
			});

			// Determine auth type from server
			// A GitLab server is OAuth through the person's connection,
			// whatever its registry entry advertises.
			const preferredAuthType = preferredMcpServerAuthType(server);

			// GitLab personal servers hold no credential of their own: their
			// state is the person's GitLab connection, whether or not a config
			// row exists for the server (`configProvisioned` says that). Every
			// other server is judged from its config.
			const { isConnected, needsReauth } = isGitLabPersonalServer(server)
				? await gitlabConnectionState(userId, organizationId)
				: configConnectionState(config);

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
				configProvisioned: Boolean(config),
				configEnabled: config?.enabled ?? false,
				organizationId,
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
					/** Whether the person has a config row for this server here. */
					configProvisioned: z.boolean(),
					/** Whether that row is turned on. */
					configEnabled: z.boolean(),
				}),
			),
		)
		.handler(async ({ input, context }) => {
			const userId = context.user.id;
			const { serverIds } = input;
			const organizationId = await authorizedConnectOrganization(
				input.organizationId,
				context,
			);

			// Get all servers
			const servers = await db.mCPServer.findMany({
				where: { id: { in: serverIds } },
				select: {
					id: true,
					key: true,
					name: true,
					authMethods: true,
				},
			});

			// Get user's configs for these servers (most recently updated first)
			const configs = await db.mCPConfig.findMany({
				where: {
					mcpServerId: { in: serverIds },
					userId,
					organizationId,
				},
				select: {
					mcpServerId: true,
					enabled: true,
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

			const gitlabState = servers.some(isGitLabPersonalServer)
				? await gitlabConnectionState(userId, organizationId)
				: null;

			// Build response
			return servers.map((server) => {
				const config = configMap.get(server.id);

				// A GitLab server is OAuth through the person's connection,
				// whatever its registry entry advertises.
				const preferredAuthType = preferredMcpServerAuthType(server);

				// GitLab personal servers: the person's GitLab connection,
				// with or without a config row.
				const { isConnected, needsReauth } =
					gitlabState && isGitLabPersonalServer(server)
						? gitlabState
						: configConnectionState(config);

				return {
					serverId: server.id,
					serverName: server.name,
					authType: preferredAuthType as
						| "NONE"
						| "API_KEY"
						| "OAUTH2",
					isConnected,
					needsReauth,
					configProvisioned: Boolean(config),
					configEnabled: config?.enabled ?? false,
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
			const { provider, returnUrl } = input;

			// The organization signed into the state is where the callback
			// will store the token. Resolve it from the input or the session
			// with the shared caller ratchet (a non-member is refused), then
			// refuse to mint a state without one: integration OAuth has no
			// organization-less arm (ADR-018), and the callback's decoder
			// rejects such a state anyway.
			const organizationId = await resolveOrganizationIdForCaller(
				input.organizationId,
				context.session,
				userId,
			);
			assertOAuthStartOrganization(organizationId);

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
				organizationId,
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
