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
import { redactLogText } from "@repo/utils/log-redaction";
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

	if (typeof toolName !== "string" || !toolName.trim()) {
		return { success: false, error: "Tool name is required" };
	}

	if (
		!Array.isArray(mcpServers) ||
		mcpServers.length === 0 ||
		mcpServers.some((id) => typeof id !== "string" || !id.trim())
	) {
		return {
			success: false,
			error: "At least one MCP server must be selected",
		};
	}

	// Parse tool arguments with smart detection
	let parsedArgs: Record<string, unknown> = {};
	if (toolArgs !== undefined && typeof toolArgs !== "string") {
		return {
			success: false,
			error: "Tool arguments must be text or a JSON object encoded as text",
		};
	}
	if (toolArgs) {
		const trimmedToolArgs = toolArgs.trim();
		// Detect if the template looks like JSON (starts with { or [)
		// If so, use JSON-safe escaping to prevent control characters from breaking parsing
		const looksLikeJson =
			(trimmedToolArgs.startsWith("{") &&
				!trimmedToolArgs.startsWith("{{")) ||
			trimmedToolArgs.startsWith("[");

		const interpolatedArgs = interpolateTemplate(toolArgs, params.inputs, {
			escapeForJson: looksLikeJson,
		});
		const trimmedArgs = interpolatedArgs.trim();

		if (trimmedArgs.startsWith("{") || trimmedArgs.startsWith("[")) {
			try {
				const value: unknown = JSON.parse(trimmedArgs);
				if (
					value === null ||
					typeof value !== "object" ||
					Array.isArray(value)
				) {
					if (looksLikeJson) {
						return {
							success: false,
							error: "Tool arguments must resolve to a JSON object",
						};
					}
					parsedArgs = { query: trimmedArgs };
				} else {
					parsedArgs = value as Record<string, unknown>;
				}
			} catch (parseError) {
				const errorMessage =
					parseError instanceof Error
						? parseError.message
						: "Unknown parse error";
				if (looksLikeJson) {
					return {
						success: false,
						error: `Invalid JSON in tool arguments: ${errorMessage}`,
					};
				}
				parsedArgs = { query: trimmedArgs };
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
		let dispatched = false;

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

			// AI SDK 7 made ToolExecutionOptions.context required. MCP tools declare
			// no contextSchema, so the SDK's own invocation passes undefined here.
			dispatched = true;
			const result = await tool.execute(parsedArgs, {
				toolCallId: `${toolName}-${Date.now()}`,
				messages: [],
				context: undefined,
			});
			if (
				result &&
				typeof result === "object" &&
				"isError" in result &&
				result.isError === true
			) {
				return {
					success: false,
					error: `Server ${serverName}: ${redactLogText(formatOutputForDisplay(result)).text.slice(0, 2000) || "Tool reported an error"}`,
				};
			}

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
			if (dispatched) {
				// A connection failure cannot prove a remote write did not happen.
				// Do not replay it on another selected server.
				return {
					success: false,
					error: `Server ${serverName}: Tool "${toolName}" may have started but did not confirm its result. Inspect the remote server before retrying.`,
				};
			}
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
