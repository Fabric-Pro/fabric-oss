/**
 * MCP Tool Ingestion Activities
 *
 * Handles ingesting MCP server tools into Qdrant for semantic search.
 * Triggered when users add/update/delete MCP configurations.
 *
 * Features:
 * - Tenant isolation (personal vs organization accounts)
 * - Tool definition and schema storage in Qdrant
 * - Automatic cleanup when MCP configs are removed
 *
 * IMPORTANT: This activity follows the established pattern for AI provider configuration:
 * - Fetches provider config with getSystemRAGProviderConfig() — the SYSTEM half
 *   of the resolver pair. Tool ingestion is indexing work, which R13 leaves on
 *   the deployment's own gateway key when a tenant has none of its own; the
 *   tenant-facing half would refuse and leave the tenant's tools unsearchable.
 * - Decrypts the API key before use
 * - Passes provider info to embedding generator for proper routing
 */

import {
	AIProviderNotConfiguredError,
	getSystemRAGProviderConfig,
} from "@repo/ai";
import {
	type CachedTool,
	getMcpConfigByIdInternal,
	listMcpConfigsForTenant,
	updateMcpConfigToolCache,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	closeMcpClient,
	createMcpClientForConfig,
	type McpClientType,
} from "@repo/mcp";
import { generateEmbeddings } from "@repo/rag/lib/embedding/generator";
import {
	type CapabilityPoint,
	deleteCapabilitiesByServer,
	upsertCapabilities,
} from "@repo/rag/lib/vector-store/capability-store";
import { Context } from "@temporalio/activity";
// Note: decryptApiKey removed - authentication is now handled by createMcpClientForConfig

// =============================================================================
// Types
// =============================================================================

export interface IngestMcpToolsInput {
	/** MCP config ID to ingest tools from */
	mcpConfigId: string;
	/** User ID (for personal accounts) */
	userId?: string;
	/** Organization ID (for org accounts) */
	organizationId?: string;
	/**
	 * @deprecated API key is now fetched from database inside the activity.
	 * This field is kept for backward compatibility but will be ignored.
	 */
	apiKey?: string;
	/**
	 * @deprecated AI provider is now determined from database config.
	 * This field is kept for backward compatibility but will be ignored.
	 */
	aiProvider?: string;
	/**
	 * @deprecated Base URL is now determined from database config.
	 * This field is kept for backward compatibility but will be ignored.
	 */
	aiProviderBaseUrl?: string | null;
}

export interface IngestMcpToolsOutput {
	success: boolean;
	toolCount: number;
	serverName: string;
	error?: string;
}

export interface DeleteMcpToolsInput {
	/** Server name to delete tools for */
	serverName: string;
	/** User ID (for personal accounts) */
	userId: string;
	/** Organization ID (for org accounts) */
	organizationId?: string;
}

export interface DeleteMcpToolsOutput {
	success: boolean;
	deletedCount: number;
	error?: string;
}

export interface IngestAllMcpToolsInput {
	/** User ID (for personal accounts) */
	userId?: string;
	/** Organization ID (for org accounts) */
	organizationId?: string;
	/**
	 * @deprecated API key is now fetched from database inside the activity.
	 * This field is kept for backward compatibility but will be ignored.
	 */
	apiKey?: string;
	/**
	 * @deprecated AI provider is now determined from database config.
	 * This field is kept for backward compatibility but will be ignored.
	 */
	aiProvider?: string;
	/**
	 * @deprecated Base URL is now determined from database config.
	 * This field is kept for backward compatibility but will be ignored.
	 */
	aiProviderBaseUrl?: string | null;
}

export interface IngestAllMcpToolsOutput {
	success: boolean;
	totalTools: number;
	serverCount: number;
	errors: string[];
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Determine risk level from tool name
 */
function determineRiskLevel(
	toolName: string,
): "low" | "medium" | "high" | "critical" {
	const nameLower = toolName.toLowerCase();

	// Critical: destructive operations
	if (
		nameLower.includes("delete") ||
		nameLower.includes("remove") ||
		nameLower.includes("drop") ||
		nameLower.includes("destroy")
	) {
		return "critical";
	}

	// High: write operations
	if (
		nameLower.includes("create") ||
		nameLower.includes("update") ||
		nameLower.includes("modify") ||
		nameLower.includes("write") ||
		nameLower.includes("send") ||
		nameLower.includes("post") ||
		nameLower.includes("put")
	) {
		return "high";
	}

	// Medium: data access
	if (
		nameLower.includes("fetch") ||
		nameLower.includes("download") ||
		nameLower.includes("export")
	) {
		return "medium";
	}

	// Low: read-only operations
	return "low";
}

/**
 * Determine if tool is read-only based on name
 */
function isReadOnlyTool(toolName: string): boolean {
	const nameLower = toolName.toLowerCase();
	const readOnlyPatterns = [
		"get",
		"list",
		"search",
		"find",
		"query",
		"read",
		"view",
		"show",
		"describe",
		"info",
		"status",
		"check",
	];
	return readOnlyPatterns.some((p) => nameLower.includes(p));
}

/**
 * Infer tool category from name and description
 */
function inferCategory(
	toolName: string,
	description?: string,
	serverName?: string,
): string {
	const combined =
		`${toolName} ${description || ""} ${serverName || ""}`.toLowerCase();

	if (
		combined.includes("search") ||
		combined.includes("web") ||
		combined.includes("scrape") ||
		combined.includes("crawl")
	) {
		return "search";
	}
	if (
		combined.includes("file") ||
		combined.includes("document") ||
		combined.includes("storage")
	) {
		return "file";
	}
	if (
		combined.includes("github") ||
		combined.includes("git") ||
		combined.includes("code") ||
		combined.includes("repository")
	) {
		return "development";
	}
	if (
		combined.includes("slack") ||
		combined.includes("email") ||
		combined.includes("message") ||
		combined.includes("notification")
	) {
		return "communication";
	}
	if (
		combined.includes("database") ||
		combined.includes("sql") ||
		combined.includes("query") ||
		combined.includes("data")
	) {
		return "data";
	}
	if (
		combined.includes("project") ||
		combined.includes("task") ||
		combined.includes("board") ||
		combined.includes("issue") ||
		combined.includes("ticket")
	) {
		return "project_management";
	}

	return "unknown";
}

// =============================================================================
// Activities
// =============================================================================

/**
 * Ingest tools from a single MCP server into Qdrant
 *
 * This activity:
 * 1. Connects to the MCP server
 * 2. Fetches all tool definitions
 * 3. Generates embeddings for tool descriptions
 * 4. Stores tools in Qdrant with proper tenant isolation
 */
export async function ingestMcpToolsActivity(
	input: IngestMcpToolsInput,
): Promise<IngestMcpToolsOutput> {
	const { mcpConfigId, userId, organizationId } = input;
	// Note: apiKey, aiProvider, aiProviderBaseUrl from input are deprecated and ignored
	// We fetch the provider config from the database instead (established pattern)

	logger.info("[MCP Ingestion] Starting tool ingestion", {
		mcpConfigId,
		userId: userId ? `${userId.slice(0, 8)}...` : undefined,
		organizationId,
	});

	let client: McpClientType | undefined;

	try {
		// Get MCP config - use internal version, tenant verification done below
		const config = await getMcpConfigByIdInternal(mcpConfigId);
		if (!config) {
			return {
				success: false,
				toolCount: 0,
				serverName: "unknown",
				error: `MCP config not found: ${mcpConfigId}`,
			};
		}

		// Verify tenant ownership
		if (organizationId) {
			if (config.organizationId !== organizationId) {
				return {
					success: false,
					toolCount: 0,
					serverName:
						config.displayName ||
						config.mcpServer?.name ||
						"unknown",
					error: "MCP config does not belong to this organization",
				};
			}
		} else if (userId) {
			if (config.userId !== userId) {
				return {
					success: false,
					toolCount: 0,
					serverName:
						config.displayName ||
						config.mcpServer?.name ||
						"unknown",
					error: "MCP config does not belong to this user",
				};
			}
		}

		const serverName =
			config.displayName || config.mcpServer?.name || config.id;

		// Determine transport
		const transport = (
			config.transport ||
			config.mcpServer?.transport ||
			"HTTP"
		)
			.toString()
			.toUpperCase();

		// Connect to MCP server using createMcpClientForConfig
		// This handles all transport types including STDIO (via wrapper service)
		logger.info("[MCP Ingestion] Connecting to MCP server", {
			serverName,
			transport,
		});

		// Ensure we have a valid userId for the client
		const effectiveUserId = userId || config.userId;
		if (!effectiveUserId) {
			return {
				success: false,
				toolCount: 0,
				serverName,
				error: "No user ID available for MCP client connection",
			};
		}

		try {
			const clientResult = await createMcpClientForConfig({
				configId: mcpConfigId,
				userId: effectiveUserId,
				organizationId:
					organizationId || config.organizationId || undefined,
			});
			client = clientResult.client;
		} catch (clientError) {
			logger.error("[MCP Ingestion] Failed to connect to MCP server", {
				serverName,
				error:
					clientError instanceof Error
						? clientError.message
						: String(clientError),
			});
			return {
				success: false,
				toolCount: 0,
				serverName,
				error:
					clientError instanceof Error
						? clientError.message
						: "Failed to connect to MCP server",
			};
		}

		// Fetch tools
		const tools = await client.tools();
		const toolEntries = Object.entries(tools);

		// Send heartbeat after fetching tools
		Context.current().heartbeat();

		if (toolEntries.length === 0) {
			logger.info("[MCP Ingestion] No tools found on server", {
				serverName,
			});
			return {
				success: true,
				toolCount: 0,
				serverName,
			};
		}

		logger.info("[MCP Ingestion] Fetched tools from server", {
			serverName,
			toolCount: toolEntries.length,
		});

		// Cache tools in database for fast listing (avoid live MCP connections)
		const cachedTools: CachedTool[] = toolEntries.map(([name, def]) => {
			const toolDef = def as {
				description?: string;
				inputSchema?: Record<string, unknown>;
			};
			// Unwrap AI SDK jsonSchema wrapper if present
			// dynamicTool() wraps schemas as { jsonSchema: { type, properties, ... } }
			let schema = toolDef.inputSchema || null;
			if (
				schema &&
				typeof schema === "object" &&
				"jsonSchema" in schema
			) {
				schema = (schema as { jsonSchema: Record<string, unknown> })
					.jsonSchema;
			}
			return {
				name,
				description: toolDef.description || null,
				inputSchema: schema,
			};
		});

		try {
			await updateMcpConfigToolCache({
				configId: mcpConfigId,
				tools: cachedTools,
			});
			logger.info("[MCP Ingestion] Cached tools in database", {
				serverName,
				toolCount: cachedTools.length,
			});
		} catch (cacheError) {
			// Log but don't fail - caching is optional, Qdrant ingestion is the primary goal
			logger.warn("[MCP Ingestion] Failed to cache tools in database", {
				serverName,
				error:
					cacheError instanceof Error
						? cacheError.message
						: String(cacheError),
			});
		}

		// Send heartbeat after caching
		Context.current().heartbeat();

		// Prepare tool descriptions for embedding
		const toolDescriptions = toolEntries.map(([name, def]) => {
			const toolDef = def as { description?: string };
			return `${name}: ${toolDef.description || "No description"}`;
		});

		// Get AI provider config using centralized function
		// Note: effectiveUserId already validated above when creating MCP client
		const effectiveOrgId =
			organizationId || config.organizationId || undefined;

		let providerConfig:
			| Awaited<ReturnType<typeof getSystemRAGProviderConfig>>
			| undefined;
		try {
			providerConfig = await getSystemRAGProviderConfig({
				userId: effectiveUserId,
				organizationId: effectiveOrgId,
			});
		} catch (error) {
			if (error instanceof AIProviderNotConfiguredError) {
				return {
					success: false,
					toolCount: 0,
					serverName,
					error: "No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
				};
			}
			throw error;
		}

		logger.info(
			"[MCP Ingestion] Using centralized AI provider config for embeddings",
		);

		// Send heartbeat before generating embeddings (long-running operation)
		Context.current().heartbeat();

		// Generate embeddings for all tools
		const embeddingResult = await generateEmbeddings(
			toolDescriptions,
			{ userId: effectiveUserId, organizationId: effectiveOrgId },
			providerConfig,
		);

		// Send heartbeat after generating embeddings
		Context.current().heartbeat();

		if (
			!embeddingResult.embeddings ||
			embeddingResult.embeddings.length !== toolEntries.length
		) {
			return {
				success: false,
				toolCount: 0,
				serverName,
				error: "Failed to generate embeddings for tools",
			};
		}

		// Create capability points for Qdrant
		const capabilityPoints: CapabilityPoint[] = toolEntries.map(
			([name, def], index) => {
				const toolDef = def as {
					description?: string;
					inputSchema?: Record<string, unknown>;
				};

				// Tool ID includes userId to make it unique per user's config
				// This allows multiple users in an org to have their own tool instances
				const toolId = userId
					? `${userId}:${serverName}:${name}`
					: `${serverName}:${name}`;

				// Unwrap inputSchema if it has MCP wrapper format with jsonSchema property
				// MCP protocol returns schemas with extra metadata (_type, validate), but we only need the jsonSchema
				let inputSchema = toolDef.inputSchema;
				if (
					inputSchema &&
					typeof inputSchema === "object" &&
					"jsonSchema" in inputSchema
				) {
					inputSchema = (
						inputSchema as { jsonSchema: Record<string, unknown> }
					).jsonSchema;
					logger.info(
						`[MCP Ingestion] Unwrapped inputSchema for tool: ${name}`,
					);
				}

				return {
					id: toolId,
					type: "mcp_tool" as const,
					name,
					description: toolDef.description || "",
					embedding: embeddingResult.embeddings[index],
					userId: userId || null,
					organizationId: organizationId || null,
					metadata: {
						serverName,
						configId: mcpConfigId,
						category: inferCategory(
							name,
							toolDef.description,
							serverName,
						),
						riskLevel: determineRiskLevel(name),
						isReadOnly: isReadOnlyTool(name),
						inputSchema,
						updatedAt: new Date().toISOString(),
					},
				};
			},
		);

		// Delete existing tools for this server before upserting new ones
		// This ensures clean updates when tools change
		await deleteCapabilitiesByServer(
			serverName,
			userId || "",
			organizationId,
		);

		// Send heartbeat before Qdrant upsert
		Context.current().heartbeat();

		// Upsert to Qdrant
		const result = await upsertCapabilities(capabilityPoints);

		// Send heartbeat after Qdrant upsert
		Context.current().heartbeat();

		logger.info("[MCP Ingestion] Tool ingestion complete", {
			serverName,
			toolCount: result.success,
			failed: result.failed,
		});

		return {
			success: true,
			toolCount: result.success,
			serverName,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[MCP Ingestion] Tool ingestion failed", {
			mcpConfigId,
			error: errorMessage,
		});
		return {
			success: false,
			toolCount: 0,
			serverName: "unknown",
			error: errorMessage,
		};
	} finally {
		await closeMcpClient(client);
	}
}

/**
 * Delete all tools for a specific MCP server from Qdrant
 *
 * Called when an MCP config is deleted or disabled
 */
export async function deleteMcpToolsActivity(
	input: DeleteMcpToolsInput,
): Promise<DeleteMcpToolsOutput> {
	const { serverName, userId, organizationId } = input;

	logger.info("[MCP Ingestion] Deleting tools for server", {
		serverName,
		userId: userId ? `${userId.slice(0, 8)}...` : undefined,
		organizationId,
	});

	try {
		const deletedCount = await deleteCapabilitiesByServer(
			serverName,
			userId,
			organizationId,
		);

		logger.info("[MCP Ingestion] Tools deleted", {
			serverName,
			deletedCount,
		});

		return {
			success: true,
			deletedCount,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[MCP Ingestion] Failed to delete tools", {
			serverName,
			error: errorMessage,
		});
		return {
			success: false,
			deletedCount: 0,
			error: errorMessage,
		};
	}
}

/**
 * Ingest tools from ALL enabled MCP configs for a tenant
 *
 * Used for initial setup or full refresh of tool index
 */
export async function ingestAllMcpToolsActivity(
	input: IngestAllMcpToolsInput,
): Promise<IngestAllMcpToolsOutput> {
	const { userId, organizationId } = input;
	// Note: apiKey, aiProvider, aiProviderBaseUrl from input are deprecated and ignored
	// Each ingestMcpToolsActivity call fetches its own provider config

	logger.info("[MCP Ingestion] Starting full tool ingestion for tenant", {
		userId: userId ? `${userId.slice(0, 8)}...` : undefined,
		organizationId,
	});

	try {
		// Get all enabled MCP configs for the tenant (per-user-within-org pattern)
		const configs = await listMcpConfigsForTenant({
			userId,
			organizationId,
		});

		const enabledConfigs = configs.filter((c) => c.enabled);

		if (enabledConfigs.length === 0) {
			logger.info("[MCP Ingestion] No enabled MCP configs found");
			return {
				success: true,
				totalTools: 0,
				serverCount: 0,
				errors: [],
			};
		}

		logger.info("[MCP Ingestion] Found enabled MCP configs", {
			count: enabledConfigs.length,
		});

		let totalTools = 0;
		const errors: string[] = [];

		// Ingest tools from each config
		// Note: ingestMcpToolsActivity now fetches its own provider config from database
		for (const config of enabledConfigs) {
			// Send heartbeat before processing each config
			Context.current().heartbeat();

			const result = await ingestMcpToolsActivity({
				mcpConfigId: config.id,
				userId,
				organizationId,
			});

			if (result.success) {
				totalTools += result.toolCount;
			} else if (result.error) {
				errors.push(`${result.serverName}: ${result.error}`);
			}

			// Send heartbeat after processing each config
			Context.current().heartbeat();
		}

		logger.info("[MCP Ingestion] Full ingestion complete", {
			totalTools,
			serverCount: enabledConfigs.length,
			errorCount: errors.length,
		});

		return {
			success: errors.length === 0,
			totalTools,
			serverCount: enabledConfigs.length,
			errors,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[MCP Ingestion] Full ingestion failed", {
			error: errorMessage,
		});
		return {
			success: false,
			totalTools: 0,
			serverCount: 0,
			errors: [errorMessage],
		};
	}
}

// =============================================================================
// MCP Server Ingestion (Phase 1: Semantic Server Selection)
// =============================================================================

export interface IngestMcpServerInput {
	/** MCP config ID to ingest */
	mcpConfigId: string;
	/** User ID (for personal accounts) */
	userId?: string;
	/** Organization ID (for org accounts) */
	organizationId?: string;
}

export interface IngestMcpServerOutput {
	success: boolean;
	serverName: string;
	error?: string;
}

export interface IngestAllMcpServersInput {
	/** User ID (for personal accounts) */
	userId?: string;
	/** Organization ID (for org accounts) */
	organizationId?: string;
}

export interface IngestAllMcpServersOutput {
	success: boolean;
	serverCount: number;
	errors: string[];
}

/**
 * Ingest MCP server metadata into Qdrant for semantic server selection
 *
 * Phase 1 of semantic routing: Index servers in Qdrant with embeddings based on:
 * - displayName
 * - description
 * - domainKeywords
 * - exampleQueries
 *
 * This enables semantic similarity search to route queries to the right server
 * without hardcoded regex patterns.
 *
 * AUTHORIZATION: Verifies tenant ownership before indexing
 */
export async function ingestMcpServerActivity(
	input: IngestMcpServerInput,
): Promise<IngestMcpServerOutput> {
	const { mcpConfigId, userId, organizationId } = input;

	logger.info("[MCP Server Ingestion] Starting server ingestion", {
		mcpConfigId,
		userId: userId ? `${userId.slice(0, 8)}...` : undefined,
		organizationId,
	});

	try {
		// Get MCP config - use internal version, tenant verification done below
		const config = await getMcpConfigByIdInternal(mcpConfigId);
		if (!config) {
			return {
				success: false,
				serverName: "unknown",
				error: `MCP config not found: ${mcpConfigId}`,
			};
		}

		// Verify tenant ownership
		if (organizationId) {
			if (config.organizationId !== organizationId) {
				return {
					success: false,
					serverName:
						config.displayName ||
						config.mcpServer?.name ||
						"unknown",
					error: "MCP config does not belong to this organization",
				};
			}
		} else if (userId) {
			if (config.userId !== userId) {
				return {
					success: false,
					serverName:
						config.displayName ||
						config.mcpServer?.name ||
						"unknown",
					error: "MCP config does not belong to this user",
				};
			}
		}

		const serverName =
			config.displayName || config.mcpServer?.name || config.id;

		// Build server description for embedding
		const descriptionParts: string[] = [`Server: ${serverName}`];

		if (config.description) {
			descriptionParts.push(config.description);
		}

		if (config.domainKeywords && config.domainKeywords.length > 0) {
			descriptionParts.push(
				`Keywords: ${config.domainKeywords.join(", ")}`,
			);
		}

		if (config.exampleQueries && config.exampleQueries.length > 0) {
			descriptionParts.push(
				`Example queries: ${config.exampleQueries.join("; ")}`,
			);
		}

		const serverDescription = descriptionParts.join(". ");

		// Get AI provider config
		const effectiveUserId = userId || config.userId;
		if (!effectiveUserId) {
			return {
				success: false,
				serverName,
				error: "No user ID available for AI provider lookup",
			};
		}

		const effectiveOrgId =
			organizationId || config.organizationId || undefined;

		let providerConfig:
			| Awaited<ReturnType<typeof getSystemRAGProviderConfig>>
			| undefined;
		try {
			providerConfig = await getSystemRAGProviderConfig({
				userId: effectiveUserId,
				organizationId: effectiveOrgId,
			});
		} catch (error) {
			if (error instanceof AIProviderNotConfiguredError) {
				return {
					success: false,
					serverName,
					error: "No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
				};
			}
			throw error;
		}

		// Generate embedding for server description
		const embeddingResult = await generateEmbeddings(
			[serverDescription],
			{ userId: effectiveUserId, organizationId: effectiveOrgId },
			providerConfig,
		);

		if (
			!embeddingResult.embeddings ||
			embeddingResult.embeddings.length !== 1
		) {
			return {
				success: false,
				serverName,
				error: "Failed to generate embedding for server",
			};
		}

		// Create capability point for Qdrant
		// Use configId to ensure uniqueness (avoid collisions when multiple configs have same display name)
		const serverId = userId
			? `${userId}:server:${mcpConfigId}`
			: `server:${mcpConfigId}`;

		const capabilityPoint: CapabilityPoint = {
			id: serverId,
			type: "mcp_server" as const,
			name: serverName,
			description: serverDescription,
			embedding: embeddingResult.embeddings[0],
			userId: userId || null,
			organizationId: organizationId || null,
			metadata: {
				configId: mcpConfigId,
				serverName,
				category: "mcp_server",
				domainKeywords: config.domainKeywords,
				exampleQueries: config.exampleQueries,
				toolCount: config.toolCount,
				updatedAt: new Date().toISOString(),
			},
		};

		// Upsert to Qdrant
		const result = await upsertCapabilities([capabilityPoint]);

		if (result.success === 0) {
			return {
				success: false,
				serverName,
				error: "Failed to upsert server to Qdrant",
			};
		}

		logger.info("[MCP Server Ingestion] Server ingestion complete", {
			serverName,
			configId: mcpConfigId,
		});

		return {
			success: true,
			serverName,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[MCP Server Ingestion] Server ingestion failed", {
			mcpConfigId,
			error: errorMessage,
		});
		return {
			success: false,
			serverName: "unknown",
			error: errorMessage,
		};
	}
}

/**
 * Ingest ALL enabled MCP servers for a tenant into Qdrant
 *
 * Used for initial setup or full refresh of server index
 */
export async function ingestAllMcpServersActivity(
	input: IngestAllMcpServersInput,
): Promise<IngestAllMcpServersOutput> {
	const { userId, organizationId } = input;

	logger.info(
		"[MCP Server Ingestion] Starting full server ingestion for tenant",
		{
			userId: userId ? `${userId.slice(0, 8)}...` : undefined,
			organizationId,
		},
	);

	try {
		// Get all enabled MCP configs for the tenant
		const configs = await listMcpConfigsForTenant({
			userId,
			organizationId,
		});

		const enabledConfigs = configs.filter((c) => c.enabled);

		if (enabledConfigs.length === 0) {
			logger.info("[MCP Server Ingestion] No enabled MCP configs found");
			return {
				success: true,
				serverCount: 0,
				errors: [],
			};
		}

		logger.info(
			`[MCP Server Ingestion] Found ${enabledConfigs.length} enabled servers`,
		);

		const errors: string[] = [];

		// Ingest each server
		for (const config of enabledConfigs) {
			try {
				const result = await ingestMcpServerActivity({
					mcpConfigId: config.id,
					userId,
					organizationId,
				});

				if (!result.success) {
					errors.push(
						`${result.serverName}: ${result.error || "Unknown error"}`,
					);
				}
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : String(error);
				errors.push(
					`${config.displayName || config.mcpServer?.name || config.id}: ${errorMsg}`,
				);
			}
		}

		logger.info("[MCP Server Ingestion] Full server ingestion complete", {
			serverCount: enabledConfigs.length,
			errorCount: errors.length,
		});

		return {
			success: errors.length === 0,
			serverCount: enabledConfigs.length,
			errors,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[MCP Server Ingestion] Full server ingestion failed", {
			error: errorMessage,
		});
		return {
			success: false,
			serverCount: 0,
			errors: [errorMessage],
		};
	}
}
