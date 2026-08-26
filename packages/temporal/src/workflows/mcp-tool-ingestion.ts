/**
 * MCP Tool Ingestion Workflow
 *
 * Temporal workflow for ingesting MCP server tools into Qdrant.
 * Triggered when users add/update/delete MCP configurations.
 *
 * Features:
 * - Automatic tool ingestion on config changes
 * - Tenant isolation (personal vs organization accounts)
 * - Retry logic with exponential backoff
 * - Cleanup on config deletion
 */

import {
	ApplicationFailure,
	log,
	proxyActivities,
	sleep,
} from "@temporalio/workflow";

import type {
	DeleteMcpToolsInput,
	DeleteMcpToolsOutput,
	IngestAllMcpToolsInput,
	IngestAllMcpToolsOutput,
	IngestMcpToolsInput,
	IngestMcpToolsOutput,
} from "../activities/mcp-tool-ingestion";

// =============================================================================
// Activity Proxies
// =============================================================================

const {
	ingestMcpToolsActivity,
	deleteMcpToolsActivity,
	ingestAllMcpToolsActivity,
} = proxyActivities<{
	ingestMcpToolsActivity: (
		input: IngestMcpToolsInput,
	) => Promise<IngestMcpToolsOutput>;
	deleteMcpToolsActivity: (
		input: DeleteMcpToolsInput,
	) => Promise<DeleteMcpToolsOutput>;
	ingestAllMcpToolsActivity: (
		input: IngestAllMcpToolsInput,
	) => Promise<IngestAllMcpToolsOutput>;
}>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1 second",
		backoffCoefficient: 2,
		maximumInterval: "30 seconds",
		maximumAttempts: 3,
	},
});

// =============================================================================
// Workflow Types
// =============================================================================

/**
 * SECURITY: Credentials are fetched internally by activities.
 * API keys are NOT passed in workflow inputs to avoid storing them in Temporal history.
 */
export interface McpToolIngestionInput {
	/** Type of operation */
	operation: "ingest" | "delete" | "ingest_all";
	/** MCP config ID (for ingest/delete single) */
	mcpConfigId?: string;
	/** Server name (for delete) */
	serverName?: string;
	/** User ID (for personal accounts) */
	userId?: string;
	/** Organization ID (for org accounts) */
	organizationId?: string;
}

export interface McpToolIngestionOutput {
	success: boolean;
	operation: string;
	toolCount?: number;
	serverName?: string;
	serverCount?: number;
	errors?: string[];
	error?: string;
}

// =============================================================================
// Workflows
// =============================================================================

/**
 * Main workflow for MCP tool ingestion operations
 *
 * Handles:
 * - ingest: Ingest tools from a single MCP config
 * - delete: Delete tools for a specific server
 * - ingest_all: Ingest tools from all enabled configs for a tenant
 */
export async function mcpToolIngestionWorkflow(
	input: McpToolIngestionInput,
): Promise<McpToolIngestionOutput> {
	const { operation, mcpConfigId, serverName, userId, organizationId } =
		input;
	// Note: apiKey, aiProvider, aiProviderBaseUrl from input are deprecated
	// Activities now fetch their own provider config from the database

	log.info("Starting MCP tool ingestion workflow", {
		operation,
		mcpConfigId,
		serverName,
		userId: userId ? `${userId.slice(0, 8)}...` : undefined,
		organizationId,
	});

	try {
		switch (operation) {
			case "ingest": {
				if (!mcpConfigId) {
					throw ApplicationFailure.nonRetryable(
						"mcpConfigId is required for ingest operation",
						"MCP_TOOL_INGESTION_VALIDATION_ERROR",
					);
				}

				const result = await ingestMcpToolsActivity({
					mcpConfigId,
					userId,
					organizationId,
				});

				return {
					success: result.success,
					operation,
					toolCount: result.toolCount,
					serverName: result.serverName,
					error: result.error,
				};
			}

			case "delete": {
				if (!serverName || !userId) {
					throw ApplicationFailure.nonRetryable(
						"serverName and userId are required for delete operation",
						"MCP_TOOL_INGESTION_VALIDATION_ERROR",
					);
				}

				const result = await deleteMcpToolsActivity({
					serverName,
					userId,
					organizationId,
				});

				return {
					success: result.success,
					operation,
					toolCount: result.deletedCount,
					serverName,
					error: result.error,
				};
			}

			case "ingest_all": {
				const result = await ingestAllMcpToolsActivity({
					userId,
					organizationId,
				});

				return {
					success: result.success,
					operation,
					toolCount: result.totalTools,
					serverCount: result.serverCount,
					errors: result.errors,
				};
			}

			default:
				throw ApplicationFailure.nonRetryable(
					`Unknown operation: ${operation}`,
					"MCP_TOOL_INGESTION_VALIDATION_ERROR",
				);
		}
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		log.error("MCP tool ingestion workflow failed", {
			error: errorMessage,
		});
		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"MCP_TOOL_INGESTION_FAILED",
		);
	}
}

/**
 * Workflow specifically for handling MCP config creation/update
 * Ingests tools and handles any errors gracefully
 *
 * Note: API key, provider, and baseUrl parameters are deprecated.
 * The activity now fetches its own provider config from the database,
 * following the established pattern used in workspace-document-activities.ts
 */
export async function onMcpConfigChangedWorkflow(input: {
	mcpConfigId: string;
	userId?: string;
	organizationId?: string;
	/** @deprecated API key is now fetched from database inside activities */
	apiKey?: string;
	/** @deprecated AI provider is now determined from database config */
	aiProvider?: string;
	/** @deprecated Base URL is now determined from database config */
	aiProviderBaseUrl?: string | null;
	/** Optional delay before ingestion (for debouncing rapid changes) */
	delayMs?: number;
}): Promise<McpToolIngestionOutput> {
	const { mcpConfigId, userId, organizationId, delayMs } = input;
	// Note: apiKey, aiProvider, aiProviderBaseUrl are deprecated and ignored

	log.info("MCP config changed, starting tool ingestion", {
		mcpConfigId,
		userId: userId ? `${userId.slice(0, 8)}...` : undefined,
		organizationId,
		delayMs,
	});

	// Optional delay for debouncing
	if (delayMs && delayMs > 0) {
		await sleep(delayMs);
	}

	return mcpToolIngestionWorkflow({
		operation: "ingest",
		mcpConfigId,
		userId,
		organizationId,
	});
}

/**
 * Workflow specifically for handling MCP config deletion
 * Cleans up tools from Qdrant
 */
export async function onMcpConfigDeletedWorkflow(input: {
	serverName: string;
	userId: string;
	organizationId?: string;
}): Promise<McpToolIngestionOutput> {
	const { serverName, userId, organizationId } = input;

	log.info("MCP config deleted, cleaning up tools", {
		serverName,
		userId: `${userId.slice(0, 8)}...`,
		organizationId,
	});

	return mcpToolIngestionWorkflow({
		operation: "delete",
		serverName,
		userId,
		organizationId,
	});
}
