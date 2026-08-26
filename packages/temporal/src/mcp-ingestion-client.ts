/**
 * MCP Tool Ingestion Client
 *
 * Provides functions to trigger MCP tool ingestion workflows from the API layer.
 * Used when MCP configs are created, updated, or deleted.
 */

import { getTemporalClient, isTemporalAvailable } from "./client";

const TASK_QUEUE = "fabric-worker";

/**
 * Trigger tool ingestion for a single MCP config
 *
 * Call this when:
 * - A new MCP config is created
 * - An existing MCP config is updated (URL, auth, etc.)
 * - An MCP config is re-enabled
 *
 * Note: API key, provider, and baseUrl parameters are deprecated.
 * The workflow activity now fetches its own provider config from the database,
 * following the established pattern used in workspace-document-activities.ts
 */
export async function triggerMcpToolIngestion(params: {
	mcpConfigId: string;
	serverName: string;
	userId?: string;
	organizationId?: string;
	/** @deprecated API key is now fetched from database inside activities */
	apiKey?: string;
	/** @deprecated AI provider is now determined from database config */
	aiProvider?: string;
	/** @deprecated Base URL is now determined from database config */
	aiProviderBaseUrl?: string | null;
}): Promise<{ workflowId: string } | null> {
	const { mcpConfigId, serverName, userId, organizationId } = params;
	// Note: apiKey, aiProvider, aiProviderBaseUrl are deprecated and ignored

	if (!(await isTemporalAvailable())) {
		console.warn(
			"[MCP Ingestion] Temporal not available, skipping tool ingestion",
		);
		return null;
	}

	try {
		const client = await getTemporalClient();
		const workflowId = `mcp-ingest-${mcpConfigId}-${Date.now()}`;

		const handle = await client.workflow.start(
			"onMcpConfigChangedWorkflow",
			{
				taskQueue: TASK_QUEUE,
				workflowId,
				args: [
					{
						mcpConfigId,
						userId,
						organizationId,
						delayMs: 1000, // 1 second delay for debouncing rapid updates
					},
				],
			},
		);

		console.log(
			`[MCP Ingestion] Started tool ingestion workflow for ${serverName}`,
			{
				workflowId: handle.workflowId,
				mcpConfigId,
			},
		);

		return { workflowId: handle.workflowId };
	} catch (error) {
		console.error(
			"[MCP Ingestion] Failed to trigger tool ingestion:",
			error,
		);
		return null;
	}
}

/**
 * Trigger tool deletion for an MCP server
 *
 * Call this when:
 * - An MCP config is deleted
 * - An MCP config is disabled
 */
export async function triggerMcpToolDeletion(params: {
	serverName: string;
	userId: string;
	organizationId?: string;
}): Promise<{ workflowId: string } | null> {
	const { serverName, userId, organizationId } = params;

	if (!(await isTemporalAvailable())) {
		console.warn(
			"[MCP Ingestion] Temporal not available, skipping tool deletion",
		);
		return null;
	}

	try {
		const client = await getTemporalClient();
		const workflowId = `mcp-delete-${serverName.replace(/[^a-zA-Z0-9]/g, "-")}-${Date.now()}`;

		const handle = await client.workflow.start(
			"onMcpConfigDeletedWorkflow",
			{
				taskQueue: TASK_QUEUE,
				workflowId,
				args: [
					{
						serverName,
						userId,
						organizationId,
					},
				],
			},
		);

		console.log(
			`[MCP Ingestion] Started tool deletion workflow for ${serverName}`,
			{
				workflowId: handle.workflowId,
			},
		);

		return { workflowId: handle.workflowId };
	} catch (error) {
		console.error(
			"[MCP Ingestion] Failed to trigger tool deletion:",
			error,
		);
		return null;
	}
}

/**
 * Trigger full tool ingestion for all enabled MCP configs of a tenant
 *
 * Call this when:
 * - User wants to refresh all tools
 * - Initial setup for a new user/organization
 *
 * Note: API key, provider, and baseUrl parameters are deprecated.
 * The workflow activity now fetches its own provider config from the database,
 * following the established pattern used in workspace-document-activities.ts
 */
export async function triggerFullMcpToolIngestion(params: {
	userId?: string;
	organizationId?: string;
	/** @deprecated API key is now fetched from database inside activities */
	apiKey?: string;
	/** @deprecated AI provider is now determined from database config */
	aiProvider?: string;
	/** @deprecated Base URL is now determined from database config */
	aiProviderBaseUrl?: string | null;
}): Promise<{ workflowId: string } | null> {
	const { userId, organizationId } = params;
	// Note: apiKey, aiProvider, aiProviderBaseUrl are deprecated and ignored

	if (!(await isTemporalAvailable())) {
		console.warn(
			"[MCP Ingestion] Temporal not available, skipping full ingestion",
		);
		return null;
	}

	try {
		const client = await getTemporalClient();
		const tenantId = organizationId || userId || "unknown";
		const workflowId = `mcp-ingest-all-${tenantId.slice(0, 16)}-${Date.now()}`;

		const handle = await client.workflow.start("mcpToolIngestionWorkflow", {
			taskQueue: TASK_QUEUE,
			workflowId,
			args: [
				{
					operation: "ingest_all",
					userId,
					organizationId,
				},
			],
		});

		console.log("[MCP Ingestion] Started full ingestion workflow", {
			workflowId: handle.workflowId,
			tenantId,
		});

		return { workflowId: handle.workflowId };
	} catch (error) {
		console.error(
			"[MCP Ingestion] Failed to trigger full ingestion:",
			error,
		);
		return null;
	}
}

// =============================================================================
// MCP Server Ingestion (Phase 1: Semantic Server Selection)
// =============================================================================

/**
 * Trigger server metadata ingestion for a single MCP config
 *
 * Call this when:
 * - A new MCP config is created
 * - An existing MCP config is updated (displayName, description, keywords, etc.)
 * - An MCP config is re-enabled
 *
 * This indexes the server in Qdrant for semantic server selection.
 * Should be called alongside triggerMcpToolIngestion for complete indexing.
 */
export async function triggerMcpServerIngestion(params: {
	mcpConfigId: string;
	serverName: string;
	userId?: string;
	organizationId?: string;
}): Promise<{ workflowId: string } | null> {
	const { mcpConfigId, serverName, userId, organizationId } = params;

	if (!(await isTemporalAvailable())) {
		console.warn(
			"[MCP Server Ingestion] Temporal not available, skipping server ingestion",
		);
		return null;
	}

	try {
		const client = await getTemporalClient();
		const workflowId = `mcp-server-ingest-${mcpConfigId}-${Date.now()}`;

		const handle = await client.workflow.start(
			"onMcpServerChangedWorkflow",
			{
				taskQueue: TASK_QUEUE,
				workflowId,
				args: [
					{
						mcpConfigId,
						userId,
						organizationId,
						delayMs: 1000, // 1 second delay for debouncing rapid updates
					},
				],
			},
		);

		console.log(
			`[MCP Server Ingestion] Started server ingestion workflow for ${serverName}`,
			{
				workflowId: handle.workflowId,
				mcpConfigId,
			},
		);

		return { workflowId: handle.workflowId };
	} catch (error) {
		console.error(
			"[MCP Server Ingestion] Failed to trigger server ingestion:",
			error,
		);
		return null;
	}
}

/**
 * Trigger full server ingestion for all enabled MCP configs of a tenant
 *
 * Call this when:
 * - User wants to refresh all servers
 * - Initial setup for a new user/organization
 * - Migration to semantic server selection (one-time)
 */
export async function triggerFullMcpServerIngestion(params: {
	userId?: string;
	organizationId?: string;
}): Promise<{ workflowId: string } | null> {
	const { userId, organizationId } = params;

	if (!(await isTemporalAvailable())) {
		console.warn(
			"[MCP Server Ingestion] Temporal not available, skipping full server ingestion",
		);
		return null;
	}

	try {
		const client = await getTemporalClient();
		const tenantId = organizationId || userId || "unknown";
		const workflowId = `mcp-server-ingest-all-${tenantId.slice(0, 16)}-${Date.now()}`;

		const handle = await client.workflow.start(
			"mcpServerIngestionWorkflow",
			{
				taskQueue: TASK_QUEUE,
				workflowId,
				args: [
					{
						operation: "ingest_all_servers",
						userId,
						organizationId,
					},
				],
			},
		);

		console.log(
			"[MCP Server Ingestion] Started full server ingestion workflow",
			{
				workflowId: handle.workflowId,
				tenantId,
			},
		);

		return { workflowId: handle.workflowId };
	} catch (error) {
		console.error(
			"[MCP Server Ingestion] Failed to trigger full server ingestion:",
			error,
		);
		return null;
	}
}
