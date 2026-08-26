/**
 * Knowledge Fetcher
 *
 * Fetches knowledge from various sources for agent context:
 * - Workspace documents (RAG)
 * - Integration data
 * - MCP server resources
 *
 * Reuses existing infrastructure from direct-chat and template-instance.
 */

import { logger } from "@repo/logs";
import type {
	FetchKnowledgeInput,
	FetchKnowledgeResult,
	KnowledgeChunk,
	KnowledgeSourceConfig,
} from "./types";

/**
 * Default maximum results per source
 */
const DEFAULT_MAX_RESULTS = 10;

/**
 * Default minimum similarity for RAG
 */
const DEFAULT_MIN_SIMILARITY = 0.3;

/**
 * Fetch knowledge from configured sources
 *
 * This activity fetches relevant context from:
 * 1. Workspace documents (using existing RAG infrastructure)
 * 2. Integration data sources
 * 3. MCP server resources
 */
export async function fetchKnowledgeSources(
	input: FetchKnowledgeInput,
): Promise<FetchKnowledgeResult> {
	const {
		knowledgeSources,
		workspaceIds,
		query,
		userId,
		organizationId,
		executionId,
		maxResultsPerSource = DEFAULT_MAX_RESULTS,
	} = input;

	logger.info("[KnowledgeFetcher] Starting knowledge fetch", {
		executionId,
		sourceCount: knowledgeSources.length,
		workspaceCount: workspaceIds.length,
		query: query.substring(0, 100),
	});

	const allChunks: KnowledgeChunk[] = [];
	const sourcesFetched: string[] = [];
	const errors: Array<{ source: string; error: string }> = [];

	// 1. Fetch from workspace documents (RAG)
	if (workspaceIds.length > 0) {
		try {
			const workspaceChunks = await fetchFromWorkspaces(
				workspaceIds,
				query,
				userId,
				organizationId,
				maxResultsPerSource,
			);
			allChunks.push(...workspaceChunks);
			sourcesFetched.push("workspace");
			logger.info("[KnowledgeFetcher] Fetched workspace chunks", {
				count: workspaceChunks.length,
			});
		} catch (error) {
			const errorMsg =
				error instanceof Error ? error.message : "Unknown error";
			logger.error("[KnowledgeFetcher] Workspace fetch failed", {
				error: errorMsg,
			});
			errors.push({ source: "workspace", error: errorMsg });
		}
	}

	// 2. Fetch from knowledge sources
	for (const source of knowledgeSources) {
		try {
			const chunks = await fetchFromSource(
				source,
				query,
				userId,
				organizationId,
				maxResultsPerSource,
			);
			allChunks.push(...chunks);
			sourcesFetched.push(source.type);
			logger.info("[KnowledgeFetcher] Fetched from source", {
				type: source.type,
				count: chunks.length,
			});
		} catch (error) {
			const errorMsg =
				error instanceof Error ? error.message : "Unknown error";
			logger.error("[KnowledgeFetcher] Source fetch failed", {
				type: source.type,
				error: errorMsg,
			});
			errors.push({ source: source.type, error: errorMsg });
		}
	}

	// Sort by similarity
	allChunks.sort((a, b) => b.similarity - a.similarity);

	logger.info("[KnowledgeFetcher] Knowledge fetch complete", {
		executionId,
		totalChunks: allChunks.length,
		sourcesFetched,
		errorCount: errors.length,
	});

	return {
		chunks: allChunks,
		totalChunks: allChunks.length,
		sourcesFetched,
		errors: errors.length > 0 ? errors : undefined,
	};
}

/**
 * Fetch relevant documents from workspaces using existing RAG infrastructure
 */
async function fetchFromWorkspaces(
	workspaceIds: string[],
	query: string,
	userId: string,
	organizationId?: string,
	maxResults: number = DEFAULT_MAX_RESULTS,
): Promise<KnowledgeChunk[]> {
	// Reuse existing workspace RAG retrieval activity
	const { retrieveWorkspaceDocumentsActivity } = await import(
		"../direct-chat/rag-retrieval"
	);

	const result = await retrieveWorkspaceDocumentsActivity(
		query,
		userId,
		organizationId,
		workspaceIds,
		undefined,
		maxResults,
		DEFAULT_MIN_SIMILARITY,
	);

	if (!result.sources || result.sources.length === 0) {
		return [];
	}

	// Convert sources to KnowledgeChunk format
	return result.sources.map((source) => ({
		content: source.excerpt || "",
		similarity: source.similarity || 0.5,
		source: {
			type: "workspace",
			id: source.id,
			name: source.title,
		},
		metadata: {
			type: source.type,
		},
	}));
}

/**
 * Fetch from a specific knowledge source
 */
async function fetchFromSource(
	source: KnowledgeSourceConfig,
	query: string,
	userId: string,
	organizationId?: string,
	maxResults: number = DEFAULT_MAX_RESULTS,
): Promise<KnowledgeChunk[]> {
	switch (source.type.toLowerCase()) {
		case "workspace":
			if (source.workspaceId) {
				return fetchFromWorkspaces(
					[source.workspaceId],
					query,
					userId,
					organizationId,
					maxResults,
				);
			}
			return [];

		case "integration":
			return fetchFromIntegration(
				source,
				query,
				userId,
				organizationId,
				maxResults,
			);

		case "mcp":
			// MCP sources require tool execution during agent turn
			// Knowledge is fetched via tool calls, not upfront
			logger.info(
				"[KnowledgeFetcher] MCP source - tools loaded separately",
				{
					configId: source.config?.configId,
				},
			);
			return [];

		default:
			// Treat any type with an integrationId as an integration data source
			// This handles OAuth integration types like microsoft_graph, github, etc.
			if (source.integrationId) {
				logger.info(
					"[KnowledgeFetcher] Routing to integration handler",
					{ type: source.type },
				);
				return fetchFromIntegration(
					source,
					query,
					userId,
					organizationId,
					maxResults,
				);
			}
			logger.warn("[KnowledgeFetcher] Unknown source type", {
				type: source.type,
			});
			return [];
	}
}

/**
 * Fetch from an integration data source using existing handler
 */
async function fetchFromIntegration(
	source: KnowledgeSourceConfig,
	_query: string,
	userId: string,
	organizationId?: string,
	maxResults: number = DEFAULT_MAX_RESULTS,
): Promise<KnowledgeChunk[]> {
	if (!source.integrationId) {
		logger.warn(
			"[KnowledgeFetcher] Integration source missing integrationId",
			{
				type: source.type,
			},
		);
		return [];
	}

	try {
		// Use the existing integration handler
		const { IntegrationDataSourceHandler } = await import(
			"../template-instance/handlers/integration-handler"
		);

		const handler = new IntegrationDataSourceHandler();

		// Build a minimal data source definition
		const dataSource = {
			id: source.integrationId,
			type: "integration" as const,
			provider: source.type, // e.g., "slack", "github", "linear"
			operation: (source.config?.operation as string) || "search",
			config: {
				limit: maxResults,
				...source.config,
			},
		};

		// Build connections with the integration binding
		const connections = {
			integrationBindings: {
				[source.integrationId]: source.integrationId,
			},
		};

		// Validate the connection first
		const validation = await handler.validateConnection(
			dataSource,
			connections,
			userId,
			organizationId,
		);

		if (!validation.valid) {
			logger.warn("[KnowledgeFetcher] Integration validation failed", {
				integrationId: source.integrationId,
				error: validation.error,
			});
			return [];
		}

		// Fetch the data
		const result = await handler.fetchData(dataSource, connections, {
			userId,
			organizationId,
			executionId: `knowledge-${Date.now()}`,
			parameters: source.config || {},
		});

		if (!result.success || result.data.length === 0) {
			logger.info("[KnowledgeFetcher] Integration returned no data", {
				integrationId: source.integrationId,
				error: result.error,
			});
			return [];
		}

		// Convert integration data to knowledge chunks
		return result.data.slice(0, maxResults).map((item, index) => ({
			content: formatIntegrationItem(item, source.type),
			similarity: 1.0 - index * 0.05, // Decrease similarity for ordering
			source: {
				type: source.type,
				id: source.integrationId || "unknown",
				name: source.type,
			},
			metadata: {
				provider: source.type,
				recordIndex: index,
			},
		}));
	} catch (error) {
		logger.error("[KnowledgeFetcher] Integration fetch failed", {
			integrationId: source.integrationId,
			error: error instanceof Error ? error.message : "Unknown error",
		});
		return [];
	}
}

/**
 * Format integration data item as text for context
 */
function formatIntegrationItem(item: unknown, provider: string): string {
	if (typeof item === "string") {
		return item;
	}

	if (!item || typeof item !== "object") {
		return "";
	}

	const obj = item as Record<string, unknown>;

	switch (provider.toLowerCase()) {
		case "slack": {
			const text = (obj.text as string) || "";
			const user = (obj.user as string) || "unknown";
			const ts = obj.ts as string;
			const date = ts
				? new Date(Number.parseFloat(ts) * 1000).toISOString()
				: "";
			return `[${date}] ${user}: ${text}`;
		}

		case "github": {
			if (obj.title && obj.number) {
				const type = obj.pull_request ? "PR" : "Issue";
				return `${type} #${obj.number}: ${obj.title}\n${obj.body || ""}`;
			}
			if (obj.sha && obj.commit) {
				const commit = obj.commit as { message?: string };
				return `Commit ${(obj.sha as string).substring(0, 7)}: ${commit.message || ""}`;
			}
			return JSON.stringify(obj, null, 2);
		}

		case "linear": {
			if (obj.identifier && obj.title) {
				return `${obj.identifier}: ${obj.title}\n${obj.description || ""}`;
			}
			return JSON.stringify(obj, null, 2);
		}

		default:
			// Try common text fields
			for (const field of [
				"content",
				"text",
				"body",
				"message",
				"description",
				"title",
			]) {
				if (typeof obj[field] === "string" && obj[field]) {
					return obj[field] as string;
				}
			}
			return JSON.stringify(obj, null, 2);
	}
}

/**
 * Build a context prompt from retrieved knowledge chunks
 */
export function buildKnowledgeContextPrompt(
	chunks: KnowledgeChunk[],
	maxTokens = 4000,
): string {
	if (chunks.length === 0) {
		return "";
	}

	const contextParts: string[] = [];
	let currentLength = 0;
	const estimatedCharsPerToken = 4;
	const maxChars = maxTokens * estimatedCharsPerToken;

	for (const chunk of chunks) {
		const chunkText = formatChunkForContext(chunk);
		const chunkLength = chunkText.length;

		if (currentLength + chunkLength > maxChars) {
			break;
		}

		contextParts.push(chunkText);
		currentLength += chunkLength;
	}

	if (contextParts.length === 0) {
		return "";
	}

	return `## Retrieved Knowledge Context

The following information was retrieved from your knowledge base and may be relevant to the user's request:

${contextParts.join("\n\n---\n\n")}

Use this context to inform your response when relevant, but don't limit yourself to only this information.`;
}

/**
 * Format a single chunk for inclusion in context
 */
function formatChunkForContext(chunk: KnowledgeChunk): string {
	const sourceName = chunk.source.name || chunk.source.id;
	const relevance = (chunk.similarity * 100).toFixed(0);

	return `[Source: ${sourceName}] (${relevance}% relevant)
${chunk.content}`;
}
