/**
 * MCP Server Ingestion Workflow
 *
 * Temporal workflow for ingesting MCP server metadata into Qdrant.
 * Enables semantic server selection (Phase 1) without hardcoded regex patterns.
 *
 * Features:
 * - Automatic server metadata ingestion on config changes
 * - Tenant isolation (personal vs organization accounts)
 * - Retry logic with exponential backoff
 */

import {
	ApplicationFailure,
	log,
	proxyActivities,
	sleep,
} from "@temporalio/workflow";

import type {
	IngestMcpServerInput,
	IngestMcpServerOutput,
} from "../activities/mcp-tool-ingestion";

// =============================================================================
// Activity Proxies
// =============================================================================

const { ingestMcpServerActivity, ingestAllMcpServersActivity } =
	proxyActivities<{
		ingestMcpServerActivity: (
			input: IngestMcpServerInput,
		) => Promise<IngestMcpServerOutput>;
		ingestAllMcpServersActivity: (input: {
			userId?: string;
			organizationId?: string;
		}) => Promise<{
			success: boolean;
			serverCount: number;
			errors: string[];
		}>;
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

export interface McpServerIngestionInput {
	/** Type of operation */
	operation: "ingest_server" | "ingest_all_servers";
	/** MCP config ID (for single server ingest) */
	mcpConfigId?: string;
	/** User ID (for personal accounts) */
	userId?: string;
	/** Organization ID (for org accounts) */
	organizationId?: string;
}

export interface McpServerIngestionOutput {
	success: boolean;
	operation: string;
	serverName?: string;
	serverCount?: number;
	errors?: string[];
	error?: string;
}

// =============================================================================
// Workflows
// =============================================================================

/**
 * Main workflow for MCP server metadata ingestion
 *
 * Handles:
 * - ingest_server: Ingest metadata for a single MCP server
 * - ingest_all_servers: Ingest metadata for all enabled servers
 */
export async function mcpServerIngestionWorkflow(
	input: McpServerIngestionInput,
): Promise<McpServerIngestionOutput> {
	const { operation, mcpConfigId, userId, organizationId } = input;

	log.info("[MCP Server Ingestion] Starting workflow", {
		operation,
		mcpConfigId,
		userId: userId ? `${userId.slice(0, 8)}...` : undefined,
		organizationId,
	});

	try {
		if (operation === "ingest_all_servers") {
			// Ingest all enabled servers for tenant
			const result = await ingestAllMcpServersActivity({
				userId,
				organizationId,
			});

			return {
				success: result.success,
				operation,
				serverCount: result.serverCount,
				errors: result.errors,
			};
		}

		if (operation === "ingest_server") {
			if (!mcpConfigId) {
				throw ApplicationFailure.nonRetryable(
					"mcpConfigId is required for ingest_server operation",
					"MCP_SERVER_INGESTION_VALIDATION_ERROR",
				);
			}

			// Ingest single server
			const result = await ingestMcpServerActivity({
				mcpConfigId,
				userId,
				organizationId,
			});

			return {
				success: result.success,
				operation,
				serverName: result.serverName,
				error: result.error,
			};
		}

		throw ApplicationFailure.nonRetryable(
			`Unknown operation: ${operation}`,
			"MCP_SERVER_INGESTION_VALIDATION_ERROR",
		);
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		log.error("[MCP Server Ingestion] Workflow failed", {
			error: errorMessage,
		});

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"MCP_SERVER_INGESTION_FAILED",
		);
	}
}

/**
 * Workflow triggered when an MCP config is created/updated
 *
 * Debounces rapid updates with a 1-second delay
 */
export async function onMcpServerChangedWorkflow(input: {
	mcpConfigId: string;
	userId?: string;
	organizationId?: string;
	delayMs?: number;
}): Promise<McpServerIngestionOutput> {
	const { mcpConfigId, userId, organizationId, delayMs = 1000 } = input;

	log.info("[MCP Server Ingestion] Config changed, debouncing...", {
		mcpConfigId,
		delayMs,
	});

	// Debounce rapid updates
	await sleep(delayMs);

	log.info("[MCP Server Ingestion] Debounce complete, starting ingestion", {
		mcpConfigId,
	});

	const result = await ingestMcpServerActivity({
		mcpConfigId,
		userId,
		organizationId,
	});

	return {
		success: result.success,
		operation: "ingest_server",
		serverName: result.serverName,
		error: result.error,
	};
}
