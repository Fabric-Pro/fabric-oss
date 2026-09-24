/**
 * MCP Activities for Temporal Workflows
 *
 * Health checks for configured MCP servers. Uses the shared MCP client factory
 * for consistent protocol handling.
 *
 * @see https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
 */

import {
	getMcpConfigByIdInternal,
	getValidAccessToken,
	setMcpConfigHealth,
} from "@repo/database";
import { logger } from "@repo/logs";
import { closeMcpClient, createMcpClient, type McpClientType } from "@repo/mcp";

/**
 * Health-check an MCP config using proper MCP protocol.
 * Instead of raw HTTP ping, we attempt to list tools which validates
 * the full MCP protocol stack including authentication.
 */
async function checkMcpServerHealth(configId: string): Promise<boolean> {
	let client: McpClientType | undefined;

	try {
		// Use internal version - health checks run system-wide without user context
		const config = await getMcpConfigByIdInternal(configId);
		if (!config) {
			return false;
		}

		const baseUrl =
			config.failoverUrl ||
			config.baseUrl ||
			config.mcpServer?.defaultUrl;
		if (!baseUrl) {
			return false;
		}

		// Get auth headers - use getValidAccessToken for OAuth2 to trigger refresh if expired
		const headers: Record<string, string> = {};
		if (config.authType === "OAUTH2" && config.userId) {
			// Use getValidAccessToken which handles token refresh automatically
			const token = await getValidAccessToken({
				configId,
				userId: config.userId,
				organizationId: config.organizationId,
			});
			if (token) {
				headers.Authorization = `Bearer ${token}`;
			}
		} else if (
			config.authType === "API_KEY" ||
			config.authType === "OAUTH2"
		) {
			// Fallback: decrypt directly (for configs without userId or API key auth)
			const { decryptApiKey } = await import("@repo/utils");
			if (config.encryptedAccessToken) {
				const token = decryptApiKey(config.encryptedAccessToken);
				headers.Authorization = `Bearer ${token}`;
			} else if (config.encryptedApiKey) {
				const apiKey = decryptApiKey(config.encryptedApiKey);
				headers.Authorization = `Bearer ${apiKey}`;
			}
		}

		// Determine transport from config
		const transport = (
			config.transport ||
			config.mcpServer?.transport ||
			"HTTP"
		)
			.toString()
			.toUpperCase();

		// Create MCP client using shared factory (uses official MCP SDK transports)
		client = await createMcpClient({
			serverUrl: baseUrl,
			transport,
			headers,
		});

		// Attempt to list tools - this validates the full MCP protocol
		const tools = await client.tools();
		return Object.keys(tools).length >= 0; // Success if we can list tools (even empty)
	} catch (error) {
		logger.warn("[MCP Health] Protocol check failed", { configId, error });
		return false;
	} finally {
		await closeMcpClient(client);
	}
}

/**
 * Health-check an MCP config and update status + failure counters.
 * Uses proper MCP protocol to validate connection instead of raw HTTP ping.
 *
 * Simple policy:
 * - success => HEALTHY, consecutiveFailures = 0
 * - failure => increment consecutiveFailures, DEGRADED for 1-2 failures, UNAVAILABLE for >=3
 */
export async function checkAndUpdateMcpHealth(configId: string) {
	// Use internal version - health checks run system-wide without user context
	const cfg = await getMcpConfigByIdInternal(configId);
	if (!cfg) {
		return;
	}
	const baseUrl = cfg.failoverUrl || cfg.baseUrl || cfg.mcpServer?.defaultUrl;
	if (!baseUrl) {
		await setMcpConfigHealth({
			id: configId,
			status: "UNAVAILABLE",
			consecutiveFailures: (cfg.consecutiveFailures ?? 0) + 1,
		});
		return;
	}

	// Use MCP protocol check instead of raw HTTP ping
	const ok = await checkMcpServerHealth(configId);
	if (ok) {
		await setMcpConfigHealth({
			id: configId,
			status: "HEALTHY",
			consecutiveFailures: 0,
		});
		logger.info(`[MCP Health] ${configId} HEALTHY: ${baseUrl}`);
	} else {
		const failures = (cfg.consecutiveFailures ?? 0) + 1;
		const status = failures >= 3 ? "UNAVAILABLE" : "DEGRADED";
		await setMcpConfigHealth({
			id: configId,
			status,
			consecutiveFailures: failures,
		});
		logger.warn(
			`[MCP Health] ${configId} ${status}: ${baseUrl} (failures=${failures})`,
		);
	}
}
