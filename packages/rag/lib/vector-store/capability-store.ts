/**
 * Capability Vector Store
 *
 * Qdrant collection for semantic search of MCP tools and agent capabilities.
 * Provides persistent vector storage with multi-tenant isolation.
 *
 * Features:
 * - Store tool/agent descriptions as vector embeddings
 * - Semantic search for capability matching
 * - Multi-tenant isolation (userId, organizationId)
 * - Physical isolation: Organization data in separate collections
 * - Graceful degradation if Qdrant unavailable
 */

import { logger } from "@repo/logs";
import { ensureCollection } from "../collection-manager";
import { generatePointId } from "../utils";
import { qdrantClient } from "./client";

// Collection configuration
export const CAPABILITY_COLLECTION = "fabric_capabilities";

/**
 * Get the collection name for capabilities based on organization
 */
async function getCapabilityCollection(
	organizationId?: string | null,
): Promise<string> {
	return ensureCollection("fabric_capabilities", organizationId);
}

// =============================================================================
// Types
// =============================================================================

export type CapabilityType = "mcp_tool" | "mcp_server" | "agent" | "workflow";

export interface CapabilityPoint {
	/** Unique ID for the capability */
	id: string;
	/** Type of capability */
	type: CapabilityType;
	/** Name of the capability */
	name: string;
	/** Description for display */
	description: string;
	/** Embedding vector */
	embedding: number[];
	/** User ID for tenant isolation (null for system-wide) */
	userId: string | null;
	/** Organization ID for tenant isolation (null for user-specific) */
	organizationId: string | null;
	/** Additional metadata */
	metadata: {
		/** For MCP tools: server name */
		serverName?: string;
		/** For MCP tools: config ID */
		configId?: string;
		/** Category for filtering */
		category?: string;
		/** Risk level */
		riskLevel?: "low" | "medium" | "high" | "critical";
		/** Is read-only operation */
		isReadOnly?: boolean;
		/** Skills/tags */
		skills?: string[];
		/** Limitations */
		limitations?: string[];
		/** Input schema (for tools) */
		inputSchema?: Record<string, unknown>;
		/** For MCP servers: domain keywords for semantic matching */
		domainKeywords?: string[];
		/** For MCP servers: example queries for semantic matching */
		exampleQueries?: string[];
		/** For MCP servers: number of tools available */
		toolCount?: number;
		/** Last updated timestamp */
		updatedAt: string;
	};
}

export interface CapabilitySearchOptions {
	/** Query text for semantic search */
	query?: string;
	/** Query embedding (if already generated) */
	queryEmbedding?: number[];
	/** Filter by capability type */
	type?: CapabilityType;
	/** Filter by category */
	category?: string;
	/** User ID for tenant isolation */
	userId: string;
	/** Organization ID for tenant isolation */
	organizationId?: string;
	/** Include system-wide capabilities */
	includeSystem?: boolean;
	/** Minimum similarity score (0-1) */
	minScore?: number;
	/** Maximum results */
	limit?: number;
}

export interface CapabilitySearchResult {
	/** Capability data */
	capability: Omit<CapabilityPoint, "embedding">;
	/** Similarity score (0-1) */
	score: number;
}

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize capability collection
 * Creates the collection if it doesn't exist
 * @deprecated Use getCapabilityCollection() instead which handles collection per org
 */
export async function initializeCapabilityCollection(): Promise<boolean> {
	try {
		// Initialize the shared collection for personal data (orgId = null)
		await getCapabilityCollection(null);
		return true;
	} catch (error) {
		logger.error(
			"[CapabilityStore] Failed to initialize collection:",
			error,
		);
		return false;
	}
}

// =============================================================================
// CRUD Operations
// =============================================================================

/**
 * Upsert a capability to the vector store
 */
export async function upsertCapability(
	capability: CapabilityPoint,
): Promise<boolean> {
	try {
		// Get collection name (org data is in separate collection = physical isolation)
		const collectionName = await getCapabilityCollection(
			capability.organizationId,
		);

		const pointId = generatePointId(capability.id);

		await qdrantClient.upsert(collectionName, {
			wait: true,
			points: [
				{
					id: pointId,
					vector: capability.embedding,
					payload: {
						capabilityId: capability.id,
						type: capability.type,
						name: capability.name,
						description: capability.description,
						userId: capability.userId,
						organizationId: capability.organizationId,
						metadata: capability.metadata,
					},
				},
			],
		});

		logger.debug(`[CapabilityStore] Upserted capability: ${capability.id}`);
		return true;
	} catch (error) {
		logger.error("[CapabilityStore] Failed to upsert capability:", error);
		return false;
	}
}

/**
 * Upsert multiple capabilities in batch
 * Note: All capabilities must belong to the same organization for batch upsert
 */
export async function upsertCapabilities(
	capabilities: CapabilityPoint[],
): Promise<{ success: number; failed: number }> {
	if (capabilities.length === 0) {
		return { success: 0, failed: 0 };
	}

	try {
		// Group capabilities by organizationId for proper routing
		const orgGroups = new Map<string | null, CapabilityPoint[]>();
		for (const cap of capabilities) {
			const orgId = cap.organizationId || null;
			if (!orgGroups.has(orgId)) {
				orgGroups.set(orgId, []);
			}
			orgGroups.get(orgId)?.push(cap);
		}

		let totalSuccess = 0;
		let totalFailed = 0;

		// Process each organization group separately
		for (const [orgId, orgCapabilities] of orgGroups) {
			try {
				const collectionName = await getCapabilityCollection(orgId);

				const points = orgCapabilities.map((cap) => ({
					id: generatePointId(cap.id),
					vector: cap.embedding,
					payload: {
						capabilityId: cap.id,
						type: cap.type,
						name: cap.name,
						description: cap.description,
						userId: cap.userId,
						organizationId: cap.organizationId,
						metadata: cap.metadata,
					},
				}));

				await qdrantClient.upsert(collectionName, {
					wait: true,
					points,
				});

				totalSuccess += orgCapabilities.length;
			} catch (error) {
				logger.error(
					`[CapabilityStore] Failed to upsert capabilities for org ${orgId}:`,
					error,
				);
				totalFailed += orgCapabilities.length;
			}
		}

		logger.info(
			`[CapabilityStore] Upserted ${totalSuccess} capabilities (${totalFailed} failed)`,
		);
		return { success: totalSuccess, failed: totalFailed };
	} catch (error) {
		logger.error("[CapabilityStore] Failed to upsert capabilities:", error);
		return { success: 0, failed: capabilities.length };
	}
}

/**
 * Delete a capability by ID
 */
export async function deleteCapability(
	capabilityId: string,
	organizationId?: string | null,
): Promise<boolean> {
	try {
		const collectionName = await getCapabilityCollection(organizationId);

		const pointId = generatePointId(capabilityId);
		await qdrantClient.delete(collectionName, {
			wait: true,
			points: [pointId],
		});

		logger.debug(`[CapabilityStore] Deleted capability: ${capabilityId}`);
		return true;
	} catch (error) {
		logger.error("[CapabilityStore] Failed to delete capability:", error);
		return false;
	}
}

/**
 * Delete all capabilities for a specific MCP server
 *
 * TENANT ISOLATION (per-user configs within orgs):
 * - Always filter by userId (each user has their own tool index)
 * - If organizationId is provided: Also filter by organizationId (org context)
 * - This ensures User A's Firecrawl tools don't get deleted when User B deletes theirs
 */
export async function deleteCapabilitiesByServer(
	serverName: string,
	userId: string,
	organizationId?: string,
): Promise<number> {
	try {
		// Get collection name (org data is in separate collection = physical isolation)
		const collectionName = await getCapabilityCollection(organizationId);

		// Build tenant filter - always include userId for per-user isolation
		const mustFilters: Array<Record<string, unknown>> = [
			{ key: "metadata.serverName", match: { value: serverName } },
			{ key: "userId", match: { value: userId } },
		];

		// If in org context, also filter by organizationId
		if (organizationId) {
			mustFilters.push({
				key: "organizationId",
				match: { value: organizationId },
			});
		}

		const filter: Record<string, unknown> = {
			must: mustFilters,
		};

		const result = await qdrantClient.delete(collectionName, {
			wait: true,
			filter,
		});

		logger.info(
			`[CapabilityStore] Deleted capabilities for server: ${serverName}`,
			{ userId, organizationId },
		);
		return typeof result === "object" ? 1 : 0;
	} catch (error) {
		logger.error(
			"[CapabilityStore] Failed to delete capabilities by server:",
			error,
		);
		return 0;
	}
}

/**
 * Delete all capabilities for a user/organization
 */
export async function deleteCapabilitiesByTenant(
	userId: string,
	organizationId?: string,
): Promise<number> {
	try {
		// Get collection name (org data is in separate collection = physical isolation)
		const collectionName = await getCapabilityCollection(organizationId);

		const filter: Record<string, unknown> = organizationId
			? {
					should: [
						{ key: "userId", match: { value: userId } },
						{
							key: "organizationId",
							match: { value: organizationId },
						},
					],
				}
			: { must: [{ key: "userId", match: { value: userId } }] };

		await qdrantClient.delete(collectionName, {
			wait: true,
			filter,
		});

		logger.info(
			`[CapabilityStore] Deleted capabilities for tenant: userId=${userId}, orgId=${organizationId}`,
		);
		return 1;
	} catch (error) {
		logger.error(
			"[CapabilityStore] Failed to delete capabilities by tenant:",
			error,
		);
		return 0;
	}
}

/**
 * Delete capabilities by config ID (for OAuth integration tools)
 * Used when disconnecting an OAuth integration or updating tools
 */
export async function deleteCapabilitiesByConfigId(
	configId: string,
	userId: string,
	organizationId?: string,
): Promise<number> {
	try {
		// Get collection name (org data is in separate collection = physical isolation)
		const collectionName = await getCapabilityCollection(organizationId);

		// Build tenant filter - always include userId for per-user isolation
		const mustFilters: Array<Record<string, unknown>> = [
			{ key: "metadata.configId", match: { value: configId } },
			{ key: "userId", match: { value: userId } },
		];

		// If in org context, also filter by organizationId
		if (organizationId) {
			mustFilters.push({
				key: "organizationId",
				match: { value: organizationId },
			});
		}

		const filter: Record<string, unknown> = {
			must: mustFilters,
		};

		const _result = await qdrantClient.delete(collectionName, {
			wait: true,
			filter,
		});

		logger.info(
			`[CapabilityStore] Deleted capabilities for configId: ${configId}`,
		);
		return 1;
	} catch (error) {
		logger.error(
			"[CapabilityStore] Failed to delete capabilities by configId:",
			error,
		);
		return 0;
	}
}

// =============================================================================
// Search Operations
// =============================================================================

/**
 * Search capabilities by semantic similarity
 * Physical isolation: Organization data is in separate collections
 */
export async function searchCapabilities(
	options: CapabilitySearchOptions,
): Promise<CapabilitySearchResult[]> {
	const {
		queryEmbedding,
		type,
		category,
		userId,
		organizationId,
		includeSystem = true,
		minScore = 0.3,
		limit = 10,
	} = options;

	if (!queryEmbedding) {
		logger.warn("[CapabilityStore] No query embedding provided for search");
		return [];
	}

	try {
		// Get collection name (org data is in separate collection = physical isolation)
		const collectionName = await getCapabilityCollection(organizationId);

		// Build tenant isolation filter
		// Per-user isolation: Each user has their own tool index, even within orgs
		// This ensures User A only sees tools from servers they've configured
		const tenantConditions: Array<Record<string, unknown>> = [];

		// User's own capabilities (includes both personal and org-context configs)
		// All user tools are stored with userId set, so this catches all their tools
		tenantConditions.push({ key: "userId", match: { value: userId } });

		// System-wide capabilities (userId = null, like Fabric AI tools)
		if (includeSystem) {
			tenantConditions.push({ is_null: { key: "userId" } });
		}

		const filter: Record<string, unknown> = {
			must: [
				{ should: tenantConditions },
				...(type ? [{ key: "type", match: { value: type } }] : []),
				...(category
					? [{ key: "metadata.category", match: { value: category } }]
					: []),
			],
		};

		const results = await qdrantClient.search(collectionName, {
			vector: queryEmbedding,
			filter,
			limit,
			score_threshold: minScore,
			with_payload: true,
		});

		return results.map((result) => ({
			capability: {
				id: (result.payload?.capabilityId as string) || "",
				type: (result.payload?.type as CapabilityType) || "mcp_tool",
				name: (result.payload?.name as string) || "",
				description: (result.payload?.description as string) || "",
				userId: result.payload?.userId as string | null,
				organizationId: result.payload?.organizationId as string | null,
				metadata: (result.payload
					?.metadata as CapabilityPoint["metadata"]) || {
					updatedAt: new Date().toISOString(),
				},
			},
			score: result.score,
		}));
	} catch (error) {
		logger.error("[CapabilityStore] Failed to search capabilities:", error);
		return [];
	}
}

/**
 * Get all capabilities for a tenant (for index rebuild)
 * Physical isolation: Organization data is in separate collections
 */
export async function getCapabilitiesByTenant(
	userId: string,
	organizationId?: string,
	type?: CapabilityType,
	limit = 1000,
	metadataFilter?: Record<string, unknown>,
): Promise<CapabilitySearchResult[]> {
	try {
		// Get collection name (org data is in separate collection = physical isolation)
		const collectionName = await getCapabilityCollection(organizationId);

		// Per-user isolation: Each user has their own tool index
		// Tools are stored with userId set (even in org context)
		const tenantConditions: Array<Record<string, unknown>> = [
			// User's own tools
			{ key: "userId", match: { value: userId } },
			// System tools (Fabric AI, etc. have userId=null)
			{ is_null: { key: "userId" } },
		];

		// Build filter with optional metadata filtering
		const mustConditions: Array<Record<string, unknown>> = [
			{ should: tenantConditions },
			...(type ? [{ key: "type", match: { value: type } }] : []),
		];

		// Add metadata filters if provided
		if (metadataFilter) {
			for (const [key, value] of Object.entries(metadataFilter)) {
				mustConditions.push({
					key: `metadata.${key}`,
					match: { value },
				});
			}
		}

		const filter: Record<string, unknown> = {
			must: mustConditions,
		};

		const results = await qdrantClient.scroll(collectionName, {
			filter,
			limit,
			with_payload: true,
			with_vector: false,
		});

		return results.points.map((point) => ({
			capability: {
				id: (point.payload?.capabilityId as string) || "",
				type: (point.payload?.type as CapabilityType) || "mcp_tool",
				name: (point.payload?.name as string) || "",
				description: (point.payload?.description as string) || "",
				userId: point.payload?.userId as string | null,
				organizationId: point.payload?.organizationId as string | null,
				metadata: (point.payload
					?.metadata as CapabilityPoint["metadata"]) || {
					updatedAt: new Date().toISOString(),
				},
			},
			score: 1.0, // No semantic score for scroll
		}));
	} catch (error) {
		logger.error(
			"[CapabilityStore] Failed to get capabilities by tenant:",
			error,
		);
		return [];
	}
}

/**
 * Check if Qdrant is available
 */
export async function isCapabilityStoreAvailable(): Promise<boolean> {
	try {
		await qdrantClient.getCollections();
		return true;
	} catch {
		return false;
	}
}

/**
 * Get collection stats for a specific organization or personal data
 */
export async function getCapabilityStoreStats(
	organizationId?: string | null,
): Promise<{
	totalPoints: number;
	indexedPoints: number;
} | null> {
	try {
		const collectionName = await getCapabilityCollection(organizationId);
		const info = await qdrantClient.getCollection(collectionName);
		return {
			totalPoints: info.points_count || 0,
			indexedPoints: info.indexed_vectors_count || 0,
		};
	} catch {
		return null;
	}
}
