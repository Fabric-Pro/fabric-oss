/**
 * Refresh MCP Tools Procedure
 *
 * Triggers re-ingestion of tools from specified MCP servers.
 * This updates the cached tools in the database by fetching fresh
 * data from the MCP servers via Temporal workflow.
 */

import { getMcpConfigById, isGitLabPersonalMcpServerKey } from "@repo/database";
import { triggerMcpToolIngestion } from "@repo/temporal";
import { z } from "zod";
import {
	authorizeInputOrganization,
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { gitlabMcpConnectionBlocker } from "../lib/gitlab-connection-gate";

export const refreshToolsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.MCP_CONNECT))
	.route({
		method: "POST",
		path: "/mcp/tools/refresh",
		tags: ["MCP"],
		summary: "Refresh tools from MCP servers",
		description:
			"Triggers re-ingestion of tools from specified MCP servers. Updates the cached tool data.",
	})
	.input(
		z.object({
			serverIds: z
				.array(z.string())
				.min(1, "At least one server ID is required"),
			// IMPORTANT: For proper tenant isolation, pass organizationId explicitly
			organizationId: z
				.string()
				.nullable()
				.optional()
				.describe(
					"Organization ID for tenant isolation. Pass null for personal context.",
				),
		}),
	)
	.output(
		z.object({
			results: z.array(
				z.object({
					serverId: z.string(),
					serverName: z.string().nullable(),
					success: z.boolean(),
					workflowId: z.string().optional().nullable(),
					error: z.string().optional().nullable(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		// The organization this request resolves to (the input's, else a
		// guest write organization, else the session's), with the caller's
		// membership and role there checked before any GitLab connection read
		// below (which can classify, and so write, a connection row there).
		// Every lookup below uses this returned value, so authorization and
		// the reads cannot target different organizations. No organization
		// passes through; the GitLab gate then only inspects.
		const organizationId = await authorizeInputOrganization(
			Permissions.MCP_CONNECT,
			input.organizationId,
			context,
		);

		const results: Array<{
			serverId: string;
			serverName: string | null;
			success: boolean;
			workflowId?: string | null;
			error?: string | null;
		}> = [];

		for (const serverId of input.serverIds) {
			try {
				// Get config to verify ownership and get server name
				const mcpConfig = await getMcpConfigById(serverId, {
					userId,
					organizationId,
				});

				if (!mcpConfig) {
					results.push({
						serverId,
						serverName: null,
						success: false,
						error: "MCP server configuration not found",
					});
					continue;
				}

				const mcpServer = mcpConfig.mcpServer as {
					key?: string;
					name?: string;
				} | null;

				const serverName =
					mcpConfig.displayName ||
					mcpServer?.name ||
					"Unknown Server";

				if (!mcpConfig.enabled) {
					results.push({
						serverId,
						serverName,
						success: false,
						error: "MCP server is disabled",
					});
					continue;
				}

				// GitLab personal servers: the person's GitLab connection
				// decides, not this config's (legacy) token columns.
				// Keyed on the server, not `authType`: an API-key GitLab
				// config is gated the same way.
				const isGitLabPersonal = isGitLabPersonalMcpServerKey(
					mcpServer?.key,
				);
				if (isGitLabPersonal) {
					const blocker = await gitlabMcpConnectionBlocker({
						userId,
						organizationId,
					});
					if (blocker) {
						results.push({
							serverId,
							serverName,
							success: false,
							error: blocker,
						});
						continue;
					}
				}

				// For OAuth2 servers, check if authenticated
				if (
					!isGitLabPersonal &&
					mcpConfig.authType === "OAUTH2" &&
					!mcpConfig.encryptedAccessToken
				) {
					results.push({
						serverId,
						serverName,
						success: false,
						error: "OAuth authentication required. Please connect to this server first.",
					});
					continue;
				}

				// Trigger tool ingestion workflow
				console.log(
					`[MCP Refresh] Triggering tool refresh for ${serverName}`,
				);

				const result = await triggerMcpToolIngestion({
					mcpConfigId: serverId,
					serverName,
					userId,
					organizationId: organizationId || undefined,
				});

				const workflowId = result?.workflowId || null;

				results.push({
					serverId,
					serverName,
					success: !!workflowId,
					workflowId,
					error: workflowId ? null : "Temporal not available",
				});

				if (workflowId) {
					console.log(
						`[MCP Refresh] Started workflow ${workflowId} for ${serverName}`,
					);
				}
			} catch (error) {
				console.error(
					`[MCP Refresh] Failed to trigger refresh for ${serverId}:`,
					error,
				);
				results.push({
					serverId,
					serverName: null,
					success: false,
					error:
						error instanceof Error
							? error.message
							: "Failed to trigger refresh",
				});
			}
		}

		return { results };
	});
