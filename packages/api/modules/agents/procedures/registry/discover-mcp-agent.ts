/**
 * Discover MCP Agent Endpoint
 *
 * Discovers an MCP-protocol agent (tool provider) by connecting to its MCP server
 * and retrieving its available tools. MCP agents provide tools but don't execute tasks.
 *
 * MCP agents are different from A2A agents:
 * - A2A agents: Execute tasks autonomously (task executors)
 * - MCP agents: Provide tools for other agents to use (tool providers)
 */

import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requirePermission,
} from "../../../../orpc/procedures";

/**
 * MCP Tool Schema
 */
const MCPToolSchema = z.object({
	name: z.string(),
	description: z.string().optional(),
	inputSchema: z.any().optional(),
});

/**
 * Validate MCP server connection
 */
async function validateMcpConnection(
	url: string,
	timeout: number,
): Promise<{
	valid: boolean;
	tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
	serverName?: string;
	serverVersion?: string;
	errors: string[];
	responseTime: number;
}> {
	const startTime = Date.now();
	const errors: string[] = [];
	let tools: Array<{
		name: string;
		description?: string;
		inputSchema?: unknown;
	}> = [];
	let serverName: string | undefined;
	let serverVersion: string | undefined;

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		// Try to connect to MCP server via SSE transport
		// Most MCP servers expose tools via HTTP endpoint
		const toolsUrl = new URL("/tools/list", url);

		try {
			const response = await fetch(toolsUrl.toString(), {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
				}),
				signal: controller.signal,
			});

			if (response.ok) {
				const data = await response.json();
				if (data.result?.tools && Array.isArray(data.result.tools)) {
					tools = data.result.tools.map(
						(t: {
							name: string;
							description?: string;
							inputSchema?: unknown;
						}) => ({
							name: t.name,
							description: t.description,
							inputSchema: t.inputSchema,
						}),
					);
				}
			} else {
				errors.push(`HTTP ${response.status}: ${response.statusText}`);
			}
		} catch (fetchError) {
			// Try alternative endpoint format
			try {
				const altResponse = await fetch(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/list",
					}),
					signal: controller.signal,
				});

				if (altResponse.ok) {
					const data = await altResponse.json();
					if (
						data.result?.tools &&
						Array.isArray(data.result.tools)
					) {
						tools = data.result.tools.map(
							(t: {
								name: string;
								description?: string;
								inputSchema?: unknown;
							}) => ({
								name: t.name,
								description: t.description,
								inputSchema: t.inputSchema,
							}),
						);
					}
				} else {
					errors.push(
						`HTTP ${altResponse.status}: ${altResponse.statusText}`,
					);
				}
			} catch {
				errors.push(
					fetchError instanceof Error
						? fetchError.message
						: "Connection failed",
				);
			}
		}

		// Try to get server info
		try {
			const infoResponse = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "initialize",
					params: {
						protocolVersion: "0.1.0",
						clientInfo: {
							name: "fabric-discovery",
							version: "1.0.0",
						},
						capabilities: {},
					},
				}),
				signal: controller.signal,
			});

			if (infoResponse.ok) {
				const infoData = await infoResponse.json();
				if (infoData.result?.serverInfo) {
					serverName = infoData.result.serverInfo.name;
					serverVersion = infoData.result.serverInfo.version;
				}
			}
		} catch {
			// Server info is optional
		}

		clearTimeout(timeoutId);

		const responseTime = Date.now() - startTime;

		return {
			valid: tools.length > 0 || errors.length === 0,
			tools,
			serverName,
			serverVersion,
			errors,
			responseTime,
		};
	} catch (error) {
		const responseTime = Date.now() - startTime;

		if (error instanceof Error && error.name === "AbortError") {
			return {
				valid: false,
				tools: [],
				errors: ["Connection timeout"],
				responseTime,
			};
		}

		return {
			valid: false,
			tools: [],
			errors: [error instanceof Error ? error.message : "Unknown error"],
			responseTime,
		};
	}
}

/**
 * Discover an MCP-protocol agent (tool provider)
 *
 * This endpoint:
 * 1. Connects to the MCP server
 * 2. Retrieves available tools
 * 3. Validates MCP protocol support
 * 4. Returns server configuration for registration
 *
 * @example
 * ```typescript
 * const result = await client.agents.registry.discoverMcp({
 *   deploymentUrl: "http://localhost:3333",
 * });
 * ```
 */
export const discoverMcpAgent = protectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.route({
		method: "POST",
		path: "/agents/registry/discover-mcp",
		tags: ["Agent Registry"],
		summary: "Discover MCP-protocol agent",
		description:
			"Discover an MCP server by connecting to it and retrieving available tools",
	})
	.input(
		z.object({
			/** Deployment URL where the MCP server is running */
			deploymentUrl: z.string().url(),

			/** Name for the MCP agent (used for registration) */
			name: z.string().min(1).max(100),

			/** Display name for the MCP agent */
			displayName: z.string().min(1).max(200).optional(),

			/** Description of the MCP agent */
			description: z.string().optional(),

			/** Timeout in milliseconds (default: 10000ms) */
			timeout: z.number().positive().optional().default(10000),
		}),
	)
	.output(
		z.object({
			/** Whether the MCP server is valid and can be registered */
			valid: z.boolean(),

			/** Server name from server info */
			serverName: z.string().nullable(),

			/** Server version from server info */
			serverVersion: z.string().nullable(),

			/** Deployment URL */
			deploymentUrl: z.string().url(),

			/** Whether the server is healthy */
			healthy: z.boolean(),

			/** Response time in milliseconds */
			responseTime: z.number(),

			/** Discovery timestamp */
			discoveredAt: z.date(),

			/** Available tools from the MCP server */
			tools: z.array(MCPToolSchema),

			/** Tool count for quick reference */
			toolCount: z.number(),

			/** Extracted metadata for registration */
			registrationData: z
				.object({
					name: z.string(),
					displayName: z.string(),
					description: z.string(),
					framework: z.literal("MCP"),
					tools: z.array(z.string()),
				})
				.nullable(),

			/** Validation errors if any */
			errors: z.array(z.string()),
		}),
	)
	.handler(async ({ input, context }) => {
		const { deploymentUrl, name, displayName, description, timeout } =
			input;

		console.log("[discoverMcpAgent] Discovering MCP agent:", {
			deploymentUrl,
			name,
			userId: context.user.id,
		});

		// Validate MCP connection
		const validationResult = await validateMcpConnection(
			deploymentUrl,
			timeout,
		);

		// Extract registration data if valid
		let registrationData = null;
		if (validationResult.valid) {
			registrationData = {
				name,
				displayName: displayName || validationResult.serverName || name,
				description:
					description ||
					`MCP tool provider with ${validationResult.tools.length} tools: ${validationResult.tools
						.slice(0, 5)
						.map((t) => t.name)
						.join(
							", ",
						)}${validationResult.tools.length > 5 ? "..." : ""}`,
				framework: "MCP" as const,
				tools: validationResult.tools.map((t) => t.name),
			};
		}

		console.log("[discoverMcpAgent] MCP server discovered:", {
			valid: validationResult.valid,
			serverName: validationResult.serverName,
			toolCount: validationResult.tools.length,
			responseTime: validationResult.responseTime,
			errors: validationResult.errors,
		});

		return {
			valid: validationResult.valid,
			serverName: validationResult.serverName || null,
			serverVersion: validationResult.serverVersion || null,
			deploymentUrl,
			healthy: validationResult.valid,
			responseTime: validationResult.responseTime,
			discoveredAt: new Date(),
			tools: validationResult.tools,
			toolCount: validationResult.tools.length,
			registrationData,
			errors: validationResult.errors,
		};
	});
