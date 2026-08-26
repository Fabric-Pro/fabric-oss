/**
 * Data Source Tools
 *
 * AI tools that allow agents to search and access workspace knowledge
 * and connector data during execution.
 *
 * These tools provide synthetic filesystem access, enabling agents to:
 *
 * 1. Search workspace documents (Qdrant vectors)
 * 2. List available data sources
 * 3. Read specific documents
 * 4. Search connector data (Slack, Notion, GitHub, etc.)
 */

import { db } from "@repo/database";
import { tool } from "ai";
import { z } from "zod";

// =============================================================================
// Qdrant Types and Stubs (TODO: implement proper Qdrant querying)
// =============================================================================

interface QdrantSearchResult {
	id: string | number;
	score: number;
	payload?: Record<string, unknown>;
}

/**
 * Stub implementation for Qdrant querying
 * TODO: Replace with actual @repo/rag search functionality
 */
async function queryQdrant(_params: {
	collectionName: string;
	query: string;
	limit: number;
	filter: Record<string, unknown>;
}): Promise<QdrantSearchResult[]> {
	// Stub - returns empty results
	// TODO: Implement using @repo/rag retrieval functions
	console.warn("[data-source-tools] queryQdrant is a stub implementation");
	return [];
}

// =============================================================================
// Types
// =============================================================================

export interface DataSourceConfig {
	workspaceIds: string[];
	connectorIds?: string[];
	userId: string;
	organizationId?: string;
}

export interface SearchResult {
	id: string;
	content: string;
	source: string;
	sourceType: "workspace" | "connector";
	metadata: Record<string, unknown>;
	score: number;
}

export interface DocumentInfo {
	id: string;
	name: string;
	type: string;
	source: string;
	sourceType: "workspace" | "connector";
	lastUpdated: string;
	size?: number;
}

// =============================================================================
// Tool Definitions
// =============================================================================

/**
 * Create data source search tool
 *
 * Allows agents to search across workspace documents using semantic search.
 */
export function createSearchDataSourcesTool(config: DataSourceConfig) {
	const inputSchema = z.object({
		query: z.string().describe("Natural language search query"),
		limit: z
			.number()
			.min(1)
			.max(20)
			.default(5)
			.describe("Maximum number of results to return"),
		sourceFilter: z
			.enum(["all", "workspace", "connector"])
			.default("all")
			.describe("Filter results by source type"),
		workspaceId: z
			.string()
			.optional()
			.describe("Specific workspace ID to search (optional)"),
	});

	return tool({
		description: `Search through available data sources (documents, knowledge bases) using semantic search.

This searches across:
- Workspace documents (PDFs, docs, text files)
- Indexed knowledge from connected services

Use this to find relevant information before answering questions.`,
		inputSchema,
		execute: async (params: z.infer<typeof inputSchema>) => {
			const { query, limit, sourceFilter, workspaceId } = params;
			const results = await searchDataSources({
				query,
				limit,
				sourceFilter,
				workspaceId,
				config,
			});

			if (results.length === 0) {
				return {
					found: false,
					message: "No relevant documents found for your query.",
					results: [],
				};
			}

			return {
				found: true,
				count: results.length,
				results: results.map((r) => ({
					source: r.source,
					sourceType: r.sourceType,
					content: r.content,
					relevance: Math.round(r.score * 100),
				})),
			};
		},
	});
}

/**
 * Create list data sources tool
 *
 * Allows agents to discover what data sources are available.
 */
export function createListDataSourcesTool(config: DataSourceConfig) {
	const inputSchema = z.object({
		includeStats: z
			.boolean()
			.default(false)
			.describe("Include document counts and last updated times"),
	});

	return tool({
		description: `List all available data sources that can be searched.

Returns information about:
- Workspace documents and their types
- Connected services (Slack, Notion, GitHub, etc.)

Use this to understand what data is available before searching.`,
		inputSchema,
		execute: async (params: z.infer<typeof inputSchema>) => {
			const { includeStats } = params;
			const sources = await listDataSources(config, includeStats);

			return {
				totalSources: sources.length,
				sources: sources.map((s) => ({
					id: s.id,
					name: s.name,
					type: s.type,
					source: s.source,
					...(includeStats && {
						lastUpdated: s.lastUpdated,
						documentCount: s.size,
					}),
				})),
			};
		},
	});
}

/**
 * Create read document tool
 *
 * Allows agents to read full document content by ID.
 */
export function createReadDocumentTool(config: DataSourceConfig) {
	const inputSchema = z.object({
		documentId: z.string().describe("The document ID from search results"),
		maxLength: z
			.number()
			.max(50000)
			.default(10000)
			.describe("Maximum characters to return"),
	});

	return tool({
		description: `Read the full content of a specific document by its ID.

Use this after searching to get complete document content.
Note: Large documents may be truncated.`,
		inputSchema,
		execute: async (params: z.infer<typeof inputSchema>) => {
			const { documentId, maxLength } = params;
			const document = await readDocument(documentId, maxLength, config);

			if (!document) {
				return {
					found: false,
					error: "Document not found or not accessible.",
				};
			}

			return {
				found: true,
				id: document.id,
				name: document.name,
				content: document.content,
				truncated: document.truncated,
				metadata: document.metadata,
			};
		},
	});
}

/**
 * Create workspace summary tool
 *
 * Provides a summary of workspace contents for context.
 */
export function createWorkspaceSummaryTool(config: DataSourceConfig) {
	const inputSchema = z.object({
		workspaceId: z.string().describe("Workspace ID to summarize"),
	});

	return tool({
		description: `Get a summary of a specific workspace's contents.

Useful for understanding what knowledge is available in a workspace
before searching.`,
		inputSchema,
		execute: async (params: z.infer<typeof inputSchema>) => {
			const { workspaceId } = params;
			// Verify workspace access
			if (
				config.workspaceIds.length > 0 &&
				!config.workspaceIds.includes(workspaceId)
			) {
				return {
					error: "Workspace not accessible to this agent.",
				};
			}

			const summary = await getWorkspaceSummary(workspaceId, config);

			if (!summary) {
				return {
					error: "Workspace not found.",
				};
			}

			return summary;
		},
	});
}

// =============================================================================
// Implementation Functions
// =============================================================================

/**
 * Search across data sources using semantic search
 */
async function searchDataSources(params: {
	query: string;
	limit: number;
	sourceFilter: "all" | "workspace" | "connector";
	workspaceId?: string;
	config: DataSourceConfig;
}): Promise<SearchResult[]> {
	const { query, limit, sourceFilter, workspaceId, config } = params;
	const results: SearchResult[] = [];

	// Search workspaces
	if (sourceFilter === "all" || sourceFilter === "workspace") {
		const workspaceIdsToSearch = workspaceId
			? [workspaceId]
			: config.workspaceIds;

		for (const wsId of workspaceIdsToSearch) {
			try {
				const qdrantResults = await queryQdrant({
					collectionName: `workspace_${wsId}`,
					query,
					limit,
					filter: {},
				});

				for (const result of qdrantResults) {
					results.push({
						id: result.id.toString(),
						content: (result.payload?.content as string) || "",
						source: (result.payload?.source as string) || wsId,
						sourceType: "workspace",
						metadata: result.payload || {},
						score: result.score,
					});
				}
			} catch (error) {
				// Workspace might not have a Qdrant collection yet
				console.warn(`Failed to search workspace ${wsId}:`, error);
			}
		}
	}

	// Search connectors
	if (
		(sourceFilter === "all" || sourceFilter === "connector") &&
		config.connectorIds?.length
	) {
		// TODO: Implement connector search when connectors are built
		// This will query the ConnectorDocument table
	}

	// Sort by score and limit
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, limit);
}

/**
 * List available data sources
 */
async function listDataSources(
	config: DataSourceConfig,
	includeStats: boolean,
): Promise<DocumentInfo[]> {
	const sources: DocumentInfo[] = [];

	// Get workspace info
	if (config.workspaceIds.length > 0) {
		const workspaces = await db.workspace.findMany({
			where: {
				id: { in: config.workspaceIds },
			},
			include: {
				_count: includeStats
					? { select: { documents: true } }
					: undefined,
			},
		});

		for (const ws of workspaces) {
			sources.push({
				id: ws.id,
				name: ws.name,
				type: ws.type,
				source: "workspace",
				sourceType: "workspace",
				lastUpdated: ws.updatedAt.toISOString(),
				size: includeStats
					? (ws as { _count?: { documents: number } })._count
							?.documents
					: undefined,
			});
		}
	}

	// Get connector info
	if (config.connectorIds?.length) {
		// TODO: Add connector listing when connectors are built
	}

	return sources;
}

/**
 * Read full document content
 */
async function readDocument(
	documentId: string,
	maxLength: number,
	config: DataSourceConfig,
): Promise<{
	id: string;
	name: string;
	content: string;
	truncated: boolean;
	metadata: Record<string, unknown>;
} | null> {
	// Try workspace documents first
	const document = await db.workspaceDocument.findFirst({
		where: {
			id: documentId,
			workspace: {
				id: { in: config.workspaceIds },
			},
		},
	});

	if (document) {
		const content = document.extractedText || "";
		const truncated = content.length > maxLength;

		return {
			id: document.id,
			name: document.filename,
			content: truncated ? `${content.slice(0, maxLength)}...` : content,
			truncated,
			metadata: {
				type: document.mimeType,
				size: document.size,
				createdAt: document.createdAt.toISOString(),
				status: document.status,
			},
		};
	}

	// TODO: Try connector documents when available

	return null;
}

/**
 * Get workspace summary
 */
async function getWorkspaceSummary(
	workspaceId: string,
	config: DataSourceConfig,
): Promise<{
	id: string;
	name: string;
	description: string | null;
	documentCount: number;
	documentTypes: Record<string, number>;
	lastActivity: string;
} | null> {
	const workspace = await db.workspace.findFirst({
		where: {
			id: workspaceId,
			OR: [
				{ id: { in: config.workspaceIds } },
				{ userId: config.userId, organizationId: null },
				{
					organizationId: config.organizationId ?? undefined,
				},
			],
		},
		include: {
			documents: {
				select: {
					mimeType: true,
					createdAt: true,
				},
			},
		},
	});

	if (!workspace) {
		return null;
	}

	// Count document types
	const typeCount: Record<string, number> = {};
	let latestActivity = workspace.updatedAt;

	for (const doc of workspace.documents) {
		const type = doc.mimeType || "unknown";
		typeCount[type] = (typeCount[type] || 0) + 1;

		if (doc.createdAt > latestActivity) {
			latestActivity = doc.createdAt;
		}
	}

	return {
		id: workspace.id,
		name: workspace.name,
		description: workspace.description,
		documentCount: workspace.documents.length,
		documentTypes: typeCount,
		lastActivity: latestActivity.toISOString(),
	};
}

// =============================================================================
// Tool Set Factory
// =============================================================================

/**
 * Create all data source tools for an agent
 */
export function createDataSourceTools(config: DataSourceConfig) {
	return {
		search_data_sources: createSearchDataSourcesTool(config),
		list_data_sources: createListDataSourcesTool(config),
		read_document: createReadDocumentTool(config),
		workspace_summary: createWorkspaceSummaryTool(config),
	};
}

/**
 * Create minimal data source tools (just search)
 */
export function createMinimalDataSourceTools(config: DataSourceConfig) {
	return {
		search_knowledge: createSearchDataSourcesTool(config),
	};
}
