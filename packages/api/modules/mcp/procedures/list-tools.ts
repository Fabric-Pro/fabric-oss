/**
 * List MCP Tools Procedure
 *
 * Returns tools from configured MCP servers. Uses database cache by default
 * to avoid live connections on every page load. Use forceRefresh to fetch
 * fresh tools from the MCP servers.
 *
 * Tool caching workflow:
 * 1. Tools are fetched and cached during MCP config creation/enable (Temporal workflow)
 * 2. This procedure reads from cache by default (fast, no MCP connection)
 * 3. forceRefresh=true bypasses cache and fetches live from MCP servers
 *
 * Best practices from Vercel AI SDK:
 * @see https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
 */

import { getMcpConfigById, getMcpConfigCachedTools } from "@repo/database";
import {
	closeMcpClient,
	createMcpClientForConfig,
	type McpClientType,
} from "@repo/mcp";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const listToolsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.MCP_READ))
	.route({
		method: "POST",
		path: "/mcp/tools/list",
		tags: ["MCP"],
		summary: "List available tools from MCP servers",
		description:
			"Returns tools from configured MCP servers. Uses database cache by default. Set forceRefresh=true to fetch live from servers.",
	})
	.input(
		z.object({
			serverIds: z
				.array(z.string())
				.min(1, "At least one server ID is required"),
			// IMPORTANT: For proper tenant isolation, pass organizationId explicitly:
			// - Pass org ID string when in organization context
			// - Pass null explicitly when in personal context
			// - Only omit (undefined) to fall back to session context
			organizationId: z
				.string()
				.nullable()
				.optional()
				.describe(
					"Organization ID for tenant isolation. Pass null for personal context.",
				),
			// Force refresh from live MCP servers (bypasses cache)
			forceRefresh: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"Set to true to fetch tools live from MCP servers instead of using cached data.",
				),
		}),
	)
	.output(
		z.object({
			tools: z.array(
				z.object({
					name: z.string(),
					description: z.string().optional().nullable(),
					inputSchema: z.unknown().optional(),
					// Parsed schema for easy form generation
					parameters: z
						.array(
							z.object({
								name: z.string(),
								type: z.string(),
								description: z.string().optional().nullable(),
								required: z.boolean(),
								enum: z.array(z.string()).optional().nullable(),
								default: z.unknown().optional().nullable(),
							}),
						)
						.optional()
						.nullable(),
					// Example JSON for the tool
					exampleJson: z.string().optional().nullable(),
					serverId: z.string(),
					serverName: z.string(),
					// Whether this tool was loaded from cache
					fromCache: z.boolean().optional(),
				}),
			),
			errors: z.array(
				z.object({
					serverId: z.string(),
					serverName: z.string().optional().nullable(),
					error: z.string(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const forceRefresh = input.forceRefresh ?? false;

		const tools: Array<{
			name: string;
			description: string | null;
			inputSchema: unknown;
			parameters: Array<{
				name: string;
				type: string;
				description: string | null;
				required: boolean;
				enum: string[] | null;
				default: unknown;
			}> | null;
			exampleJson: string | null;
			serverId: string;
			serverName: string;
			fromCache?: boolean;
		}> = [];
		const errors: Array<{
			serverId: string;
			serverName: string | null;
			error: string;
		}> = [];

		// Use resolveOrganizationId for proper tenant isolation
		// This handles: explicit string (org context), null (personal context), undefined (session fallback)
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		for (const serverId of input.serverIds) {
			let mcpClient: McpClientType | undefined;
			// Declare serverName outside try block so it's accessible in catch
			let serverName: string | null = null;

			try {
				const mcpConfig = await getMcpConfigById(serverId, {
					userId: context.user.id,
					organizationId,
				});

				if (!mcpConfig) {
					errors.push({
						serverId,
						serverName: null,
						error: "MCP server configuration not found",
					});
					continue;
				}

				// Get server configuration
				const mcpServer = mcpConfig.mcpServer as {
					key?: string;
					defaultUrl?: string;
					name?: string;
					transport?: string;
				} | null;

				// Set serverName early so it's available in catch block
				serverName =
					mcpConfig.displayName ||
					mcpServer?.name ||
					"Unknown Server";

				if (!mcpConfig.enabled) {
					errors.push({
						serverId,
						serverName,
						error: "MCP server is disabled",
					});
					continue;
				}

				// ========================================
				// TRY CACHED TOOLS FIRST (unless forceRefresh)
				// ========================================
				if (!forceRefresh) {
					const cached = await getMcpConfigCachedTools(serverId);

					if (cached.tools && cached.tools.length > 0) {
						console.log(
							`[MCP Tools] Using cached tools for ${serverName} (${cached.toolCount} tools, cached at ${cached.cachedAt?.toISOString()})`,
						);

						// Convert cached tools to full tool format
						for (const cachedTool of cached.tools) {
							let inputSchema = cachedTool.inputSchema || {};
							// Unwrap AI SDK jsonSchema wrapper if present
							if (
								typeof inputSchema === "object" &&
								"jsonSchema" in inputSchema
							) {
								inputSchema = (
									inputSchema as {
										jsonSchema: Record<string, unknown>;
									}
								).jsonSchema;
							}
							const parameters = parseInputSchema(
								inputSchema as Record<string, unknown>,
							);
							const exampleJson = generateExampleJson(parameters);

							tools.push({
								name: cachedTool.name,
								description: cachedTool.description,
								inputSchema,
								parameters:
									parameters.length > 0 ? parameters : null,
								exampleJson: exampleJson || null,
								serverId,
								serverName,
								fromCache: true,
							});
						}
						continue; // Move to next server
					}

					console.log(
						`[MCP Tools] No cached tools for ${serverName}, will fetch live`,
					);
				} else {
					console.log(
						`[MCP Tools] Force refresh requested for ${serverName}, fetching live`,
					);
				}

				// ========================================
				// FETCH LIVE FROM MCP SERVER
				// ========================================

				// Determine transport type from config
				const configTransport = mcpConfig.transport
					?.toString()
					.toUpperCase();
				const serverTransport = mcpServer?.transport?.toUpperCase();
				const transport = configTransport || serverTransport || "HTTP";

				// For OAuth2 servers, check if we have valid tokens before attempting to connect
				if (mcpConfig.authType === "OAUTH2") {
					if (!mcpConfig.encryptedAccessToken) {
						console.log(
							`[MCP Tools] Skipping OAuth2 server ${serverName} - not yet authenticated`,
						);
						errors.push({
							serverId,
							serverName,
							error: "OAuth authentication required. Please connect to this server first.",
						});
						continue;
					}

					// Check if token is expired
					if (
						mcpConfig.tokenExpiresAt &&
						new Date(mcpConfig.tokenExpiresAt) < new Date()
					) {
						console.log(
							`[MCP Tools] Skipping OAuth2 server ${serverName} - token expired`,
						);
						errors.push({
							serverId,
							serverName,
							error: "OAuth token expired. Please reconnect to refresh your access.",
						});
						continue;
					}
				}

				// Validate URL before attempting connection (skip for STDIO transport)
				if (transport !== "STDIO") {
					const effectiveUrl =
						mcpConfig.baseUrl || mcpServer?.defaultUrl;
					if (effectiveUrl) {
						try {
							const parsed = new URL(effectiveUrl);
							if (
								!["http:", "https:"].includes(parsed.protocol)
							) {
								errors.push({
									serverId,
									serverName,
									error: `Unsupported protocol: ${parsed.protocol}`,
								});
								continue;
							}
						} catch {
							errors.push({
								serverId,
								serverName,
								error: `Invalid server URL: ${effectiveUrl}`,
							});
							continue;
						}
					}
				}

				console.log(
					`[MCP Tools] Creating MCP client for ${serverName} (transport: ${transport})`,
				);

				try {
					// Use createMcpClientForConfig which handles all transport types
					// including STDIO (via wrapper service), HTTP, and SSE
					const clientResult = await createMcpClientForConfig({
						configId: serverId,
						userId,
						organizationId,
					});
					mcpClient = clientResult.client;
				} catch (clientError) {
					console.error(
						`[MCP Tools] Failed to create client for ${serverName}:`,
						clientError,
					);
					errors.push({
						serverId,
						serverName,
						error:
							clientError instanceof Error
								? clientError.message
								: "Failed to connect to MCP server",
					});
					continue;
				}

				// Use schema discovery to get all tools with their input schemas
				// @see https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools#schema-discovery
				const mcpTools = await mcpClient.tools();

				console.log(
					`[MCP Tools] Found ${Object.keys(mcpTools).length} tools from ${serverName}`,
				);

				// Process each tool
				for (const [toolName, tool] of Object.entries(mcpTools)) {
					// Extract input schema from the tool
					// The AI SDK provides this from the MCP server's tool definition
					const toolAny = tool as {
						description?: string;
						parameters?: {
							_def?: { shape?: () => Record<string, unknown> };
						};
						inputSchema?: Record<string, unknown>;
					};

					let inputSchema =
						toolAny.inputSchema ||
						toolAny.parameters?._def?.shape?.() ||
						{};

					// Unwrap AI SDK jsonSchema wrapper if present
					// dynamicTool() wraps schemas as { jsonSchema: { type, properties, ... } }
					if (
						inputSchema &&
						typeof inputSchema === "object" &&
						"jsonSchema" in inputSchema
					) {
						inputSchema = (
							inputSchema as {
								jsonSchema: Record<string, unknown>;
							}
						).jsonSchema;
					}

					// Parse the schema to extract parameters for form generation
					const parameters = parseInputSchema(inputSchema);

					// Generate example JSON
					const exampleJson = generateExampleJson(parameters);

					tools.push({
						name: toolName,
						description: toolAny.description || null,
						inputSchema,
						parameters: parameters.length > 0 ? parameters : null,
						exampleJson: exampleJson || null,
						serverId,
						serverName,
						fromCache: false,
					});
				}
			} catch (err: unknown) {
				console.error(
					`[MCP Tools] Error fetching tools from ${serverId}:`,
					err,
				);

				// Extract a meaningful error message
				let errorMessage = "Unknown error";

				if (err instanceof Error) {
					// Check for ZodError from AI SDK MCP client
					// This usually means the server returned an error response
					if (
						err.name === "ZodError" ||
						err.constructor.name === "ZodError"
					) {
						// Parse the ZodError to find the actual issue
						const zodErr = err as {
							errors?: Array<{
								message?: string;
								keys?: string[];
							}>;
						};
						const hasUnrecognizedError = zodErr.errors?.some(
							(e) =>
								e.message?.includes("Unrecognized key") &&
								e.keys?.includes("error"),
						);

						if (hasUnrecognizedError) {
							// The MCP server returned an error response (e.g., auth failure)
							errorMessage =
								"MCP server returned an error. This usually indicates authentication failure - please verify your API key or re-authenticate.";
						} else {
							errorMessage = `Protocol error: ${err.message}`;
						}
					} else {
						errorMessage = err.message;
					}
				}

				errors.push({
					serverId,
					serverName: serverName || null,
					error: errorMessage,
				});
			} finally {
				// Always close the MCP client to clean up resources
				await closeMcpClient(mcpClient);
			}
		}

		return { tools, errors };
	});

/**
 * Parse JSON Schema to extract parameters for form generation
 */
function parseInputSchema(schema: Record<string, unknown>): Array<{
	name: string;
	type: string;
	description: string | null;
	required: boolean;
	enum: string[] | null;
	default: unknown;
}> {
	const parameters: Array<{
		name: string;
		type: string;
		description: string | null;
		required: boolean;
		enum: string[] | null;
		default: unknown;
	}> = [];

	// Handle Zod schema (AI SDK converts to this format)
	// Support both Zod v3 (shape is a function) and Zod v4 (shape may be a property)
	const schemaDef = schema as {
		_def?: {
			shape?: (() => Record<string, unknown>) | Record<string, unknown>;
		};
	};
	if (schemaDef._def && schemaDef._def.shape !== undefined) {
		// Get shape - handle both function (Zod v3) and property (Zod v4)
		const shape =
			typeof schemaDef._def.shape === "function"
				? schemaDef._def.shape()
				: schemaDef._def.shape;

		if (shape && typeof shape === "object") {
			for (const [name, fieldSchema] of Object.entries(shape)) {
				const field = fieldSchema as {
					_def?: {
						typeName?: string;
						description?: string;
						values?: string[];
						defaultValue?: () => unknown;
						isOptional?: () => boolean;
					};
					description?: string;
				};
				parameters.push({
					name,
					type: field._def?.typeName || "string",
					description:
						field._def?.description || field.description || null,
					required: !field._def?.isOptional?.(),
					enum: field._def?.values || null,
					default: field._def?.defaultValue?.() ?? null,
				});
			}
			return parameters;
		}
	}

	// Handle standard JSON Schema
	const jsonSchema = schema as {
		properties?: Record<
			string,
			{
				type?: string;
				description?: string;
				enum?: string[];
				default?: unknown;
			}
		>;
		required?: string[];
	};

	const properties = jsonSchema.properties;
	const required = jsonSchema.required || [];

	if (properties && typeof properties === "object") {
		for (const [name, prop] of Object.entries(properties)) {
			if (typeof prop === "object" && prop !== null) {
				parameters.push({
					name,
					type: prop.type || "string",
					description: prop.description || null,
					required: required.includes(name),
					enum: prop.enum || null,
					default: prop.default ?? null,
				});
			}
		}
	}

	return parameters;
}

/**
 * Generate example JSON from parameters
 */
function generateExampleJson(
	parameters: Array<{
		name: string;
		type: string;
		description: string | null;
		required: boolean;
		enum: string[] | null;
		default: unknown;
	}>,
): string {
	if (parameters.length === 0) {
		return "{}";
	}

	const example: Record<string, unknown> = {};

	for (const param of parameters) {
		let value: unknown;

		if (param.default !== null && param.default !== undefined) {
			value = param.default;
		} else if (param.enum && param.enum.length > 0) {
			value = param.enum[0];
		} else {
			switch (param.type) {
				case "string":
				case "ZodString":
					value = param.description
						? `<${param.description.substring(0, 30)}>`
						: `<${param.name}>`;
					break;
				case "number":
				case "integer":
				case "ZodNumber":
					value = 0;
					break;
				case "boolean":
				case "ZodBoolean":
					value = true;
					break;
				case "array":
				case "ZodArray":
					value = [];
					break;
				case "object":
				case "ZodObject":
					value = {};
					break;
				default:
					value = `<${param.name}>`;
			}
		}

		example[param.name] = value;
	}

	return JSON.stringify(example, null, 2);
}
