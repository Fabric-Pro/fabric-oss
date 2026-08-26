/**
 * MCP Tool Step
 * Executes tools on MCP servers using shared MCP client factory
 *
 * @see https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
 */

import {
	closeMcpClient,
	createMcpClientForConfig,
	type McpClientType,
	OAuthAuthorizationRequiredError,
} from "@repo/mcp";
import { getBaseUrl } from "@repo/utils";
import type { NodeExecutionResult, StepParams } from "../../types";
import {
	formatOutputForDisplay,
	formatOutputForSlack,
	interpolateTemplate,
} from "./utils";

export async function executeMcpToolStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { mcpServers, toolName, toolArgs } = params.nodeConfig as {
		mcpServers?: string[];
		toolName?: string;
		toolArgs?: string;
	};

	if (!toolName) {
		return { success: false, error: "Tool name is required" };
	}

	if (!mcpServers || mcpServers.length === 0) {
		return {
			success: false,
			error: "At least one MCP server must be selected",
		};
	}

	// Parse tool arguments with smart detection
	let parsedArgs: Record<string, unknown> = {};
	if (toolArgs) {
		const trimmedToolArgs = toolArgs.trim();
		// Detect if the template looks like JSON (starts with { or [)
		// If so, use JSON-safe escaping to prevent control characters from breaking parsing
		const looksLikeJson =
			trimmedToolArgs.startsWith("{") || trimmedToolArgs.startsWith("[");

		const interpolatedArgs = interpolateTemplate(toolArgs, params.inputs, {
			escapeForJson: looksLikeJson,
		});
		const trimmedArgs = interpolatedArgs.trim();

		if (trimmedArgs.startsWith("{") || trimmedArgs.startsWith("[")) {
			try {
				parsedArgs = JSON.parse(trimmedArgs);
			} catch (parseError) {
				const errorMessage =
					parseError instanceof Error
						? parseError.message
						: "Unknown parse error";
				return {
					success: false,
					error: `Invalid JSON in tool arguments: ${errorMessage}`,
				};
			}
		} else if (trimmedArgs) {
			// Auto-wrap plain text in a query object
			parsedArgs = { query: trimmedArgs };
		}
	}

	const errors: string[] = [];

	// Build redirect URI for OAuth2 support
	const baseUrl = getBaseUrl();
	const redirectUri = `${baseUrl}/api/mcp/oauth/callback`;

	for (const serverId of mcpServers) {
		let mcpClient: McpClientType | undefined;
		let serverName = serverId;

		try {
			// Create MCP client using shared factory with OAuth support
			const { client, serverName: name } = await createMcpClientForConfig(
				{
					configId: serverId,
					userId: params.userId,
					organizationId: params.organizationId,
					redirectUri, // Enable OAuth2 token refresh
				},
			);
			mcpClient = client;
			serverName = name;

			const tools = await mcpClient.tools();
			const tool = tools[toolName];

			if (!tool) {
				const availableTools = Object.keys(tools).join(", ");
				errors.push(
					`Server ${serverName}: Tool "${toolName}" not found. Available: ${availableTools}`,
				);
				continue;
			}

			const result = await tool.execute(parsedArgs, {
				toolCallId: `${toolName}-${Date.now()}`,
				messages: [],
			});

			// Format result for easy access
			const formattedResult = formatOutputForDisplay(result);
			return {
				success: true,
				output: {
					toolName,
					serverName,
					result,
					output: formattedResult,
					text: formattedResult,
					slack: formatOutputForSlack(result),
					json:
						typeof result === "string"
							? result
							: JSON.stringify(result),
					data: result,
				},
			};
		} catch (serverError) {
			// Handle OAuth authorization required errors specially
			if (serverError instanceof OAuthAuthorizationRequiredError) {
				errors.push(
					`Server ${serverName}: OAuth authorization required. Please connect in Settings.`,
				);
			} else {
				const errMsg =
					serverError instanceof Error
						? serverError.message
						: String(serverError);
				errors.push(`Server ${serverName}: ${errMsg}`);
			}
		} finally {
			await closeMcpClient(mcpClient);
		}
	}

	const errorDetail =
		errors.length > 0 ? ` Errors: ${errors.join("; ")}` : "";
	return {
		success: false,
		error: `Failed to execute tool "${toolName}" on any configured MCP server.${errorDetail}`,
	};
}
