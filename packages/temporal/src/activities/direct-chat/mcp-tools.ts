/**
 * MCP Tools Activity
 *
 * Handles MCP tool collection and management for direct chat.
 *
 * LAZY LOADING PATTERN:
 * - collectMcpToolsActivity: Returns config metadata WITHOUT connecting to servers
 * - executeDirectChatActivity: Connects only to servers whose tools are actually needed
 *
 * This dramatically improves startup time by avoiding upfront connections to all MCP servers.
 */

import {
	closeMcpClientSafe,
	getDetailedMcpToolInfo,
	getMcpClient,
} from "@repo/agent-core/backend";
import { db } from "@repo/database";
import type { McpClientType } from "@repo/mcp";

const logger = {
	info: (message: string, data?: Record<string, unknown>) =>
		console.log(`[DirectChat MCP] ${message}`, data || ""),
	error: (message: string, error?: unknown) =>
		console.error(`[DirectChat MCP] ${message}`, error),
	warn: (message: string, data?: Record<string, unknown>) =>
		console.warn(`[DirectChat MCP] ${message}`, data || ""),
};

/**
 * MCP tool info type for serializable config data
 */
export interface McpToolInfo {
	configId: string;
	serverName: string;
	configName: string;
	tools: Array<{ name: string; description?: string }>;
}

/**
 * Collect MCP server configurations (LAZY - no connections)
 *
 * This activity returns serializable config metadata WITHOUT connecting to MCP servers.
 * The actual tool loading happens on-demand in executeDirectChatActivity when tools are needed.
 *
 * Benefits:
 * - Fast startup (no network connections)
 * - Only connect to servers that are actually needed
 * - Reduced latency for simple queries that don't need tools
 */
export async function collectMcpToolsActivity(
	userId: string,
	organizationId?: string,
	enabledMcpConfigIds?: string[],
): Promise<{
	tools: Record<string, unknown>;
	toolToServerMap: Record<string, { configId: string; serverName: string }>;
	mcpToolInfo: McpToolInfo[];
}> {
	logger.info("Collecting MCP config metadata (lazy - no connections)", {
		userId,
		organizationId,
	});

	// Respect explicit tool scoping from the caller (agent instance or UI selection).
	// Only fall back to persisted preferences when no explicit filter is provided.
	let effectiveEnabledMcpConfigIds = enabledMcpConfigIds;

	const dbPrefs = await db.userOrchestratorPreferences.findUnique({
		where: {
			userId_organizationId: {
				userId,
				organizationId: organizationId || "",
			},
		},
	});

	if (dbPrefs && effectiveEnabledMcpConfigIds == null) {
		const dbEnabledMcpIds = dbPrefs.enabledMcpConfigIds as string[];
		logger.info("Using database preferences for MCP filter", {
			dbIds: dbEnabledMcpIds.length,
			frontendIds: enabledMcpConfigIds?.length ?? "null",
		});
		effectiveEnabledMcpConfigIds = dbEnabledMcpIds;
	}

	// LAZY LOADING: Get config metadata only, don't connect to servers
	const mcpToolInfo = await getDetailedMcpToolInfo({
		userId,
		organizationId,
		enabledMcpConfigIds: effectiveEnabledMcpConfigIds,
		skipConnection: true, // Key change: don't connect to servers
	});

	logger.info("MCP config metadata collected (no connections made)", {
		serverCount: mcpToolInfo.length,
		servers: mcpToolInfo.map((c) => c.serverName),
	});

	// Return empty tools - they'll be loaded on-demand in executeDirectChatActivity
	return {
		tools: {},
		toolToServerMap: {},
		mcpToolInfo,
	};
}

/**
 * Get MCP clients for execution
 * Used inside execution activities where fresh tool objects are needed
 */
export async function getMcpClientsForExecution(
	mcpToolInfo: McpToolInfo[],
	userId: string,
	organizationId?: string,
): Promise<{
	tools: Record<string, unknown>;
	toolToServerMap: Record<
		string,
		{ configId: string; serverName: string; resourceUri?: string }
	>;
	clients: McpClientType[];
}> {
	const allTools: Record<string, unknown> = {};
	const toolToServerMap: Record<
		string,
		{ configId: string; serverName: string; resourceUri?: string }
	> = {};
	const clients: McpClientType[] = [];

	for (const config of mcpToolInfo) {
		try {
			const result = await getMcpClient(
				config.configId,
				userId,
				organizationId,
			);
			if (result) {
				clients.push(result.client);
				const tools = await result.client.tools();

				for (const [toolName, toolDef] of Object.entries(tools)) {
					const prefixedName = `${config.serverName.toLowerCase().replace(/\s+/g, "_")}_${toolName}`;
					allTools[prefixedName] = toolDef;
					// Capture MCP App resourceUri from tool _meta if present
					const resourceUri = (
						toolDef as { _meta?: { ui?: { resourceUri?: string } } }
					)._meta?.ui?.resourceUri;
					toolToServerMap[prefixedName] = {
						configId: config.configId,
						serverName: config.serverName,
						resourceUri,
					};
				}

				logger.info(`Loaded tools from ${config.serverName}`, {
					count: Object.keys(tools).length,
				});
			}
		} catch (error) {
			logger.error(`Failed to connect to ${config.serverName}`, error);
		}
	}

	return { tools: allTools, toolToServerMap, clients };
}

/**
 * Close all MCP clients safely
 */
export async function closeMcpClients(clients: McpClientType[]): Promise<void> {
	for (const client of clients) {
		await closeMcpClientSafe(client);
	}
}
