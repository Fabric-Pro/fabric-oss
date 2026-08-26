/**
 * Project-Scoped Unified Search
 *
 * Fans out a query to all knowledge sources attached to a project,
 * merges results into a shared format, and ranks by weighted relevance.
 *
 * Sources searched (in parallel):
 * 1. Project contexts (Qdrant vector search)
 * 2. Workspace documents (Qdrant, multi-workspace)
 * 3. Connector-backed workspace documents (Qdrant + synced resource metadata)
 * 4. Web search (optional fallback via search orchestrator)
 *
 * Design principles:
 * - Every source is optional and fault-tolerant (one source failing doesn't break others)
 * - Results are always ranked with source-type weighting for consistency
 * - Tenant isolation follows the XOR pattern (organizationId vs userId)
 */

import { db, getConnectorBackedDocumentsForWorkspaces } from "@repo/database";
import { logger } from "@repo/logs";
import { generateEmbedding, generateSparseVector } from "../embedding";
import type { RetrievedContext } from "../project-contexts";
import {
	contextMetaHeader,
	retrieveProjectContexts,
} from "../project-contexts";
import { searchMultipleWorkspaces } from "../workspace-documents";
import type {
	ProjectSearchOptions,
	ProjectSearchResponse,
	UnifiedSearchResult,
	UnifiedSearchSourceType,
} from "./types";
import {
	DEFAULT_MIN_SIMILARITY,
	DEFAULT_PER_SOURCE_LIMIT,
	DEFAULT_SOURCE_WEIGHTS,
	DEFAULT_TOTAL_LIMIT,
} from "./types";

/**
 * Execute a unified search across all knowledge sources attached to a project.
 *
 * Results from different sources are normalized to a shared format, weighted
 * by source type, and merged into a single ranked list.
 */
export async function projectSearch(
	options: ProjectSearchOptions,
): Promise<ProjectSearchResponse> {
	const startTime = Date.now();
	const {
		projectId,
		query,
		userId,
		organizationId,
		perSourceLimit = DEFAULT_PER_SOURCE_LIMIT,
		totalLimit = DEFAULT_TOTAL_LIMIT,
		minSimilarity = DEFAULT_MIN_SIMILARITY,
		workspaceIds,
		sourceWeights = {},
		federatedSearchFn,
		webSearchFn,
		codeSearchFn,
	} = options;

	// Determine which sources to search
	const requestedSources = options.sources ?? [
		"project-context",
		...(codeSearchFn ? ["code" as const] : []),
		...(workspaceIds && workspaceIds.length > 0
			? ["workspace" as const]
			: []),
		...(workspaceIds && workspaceIds.length > 0
			? ["connector" as const]
			: []),
		...(webSearchFn ? ["web" as const] : []),
	];

	const connectorDocuments =
		workspaceIds &&
		workspaceIds.length > 0 &&
		(requestedSources.includes("workspace") ||
			requestedSources.includes("connector"))
			? await getConnectorBackedDocumentsForWorkspaces({
					workspaceIds,
					userId,
					organizationId,
				})
			: [];
	const connectorDocIds = connectorDocuments
		.map((doc) => doc.documentId)
		.filter((docId): docId is string => Boolean(docId));
	const connectorDocsById = new Map(
		connectorDocuments
			.filter((doc) => doc.documentId)
			.map((doc) => [doc.documentId as string, doc]),
	);

	const weights = { ...DEFAULT_SOURCE_WEIGHTS, ...sourceWeights };
	const allResults: UnifiedSearchResult[] = [];
	const sourceCounts: Record<UnifiedSearchSourceType, number> = {
		"project-context": 0,
		code: 0,
		workspace: 0,
		connector: 0,
		artifact: 0,
		web: 0,
	};
	const sourceErrors: Record<string, string> = {};
	const sourcesSearched: UnifiedSearchSourceType[] = [];

	logger.info(
		`[UnifiedSearch] Searching project ${projectId} for: "${query.slice(0, 80)}..." across ${requestedSources.join(", ")}`,
	);

	// Fan out to all sources in parallel
	const searchPromises: Promise<void>[] = [];

	// 1. Project contexts
	if (requestedSources.includes("project-context")) {
		sourcesSearched.push("project-context");
		searchPromises.push(
			searchProjectContexts({
				projectId,
				query,
				userId,
				organizationId,
				topK: perSourceLimit,
				minSimilarity,
			})
				.then((results) => {
					allResults.push(...results);
					sourceCounts["project-context"] = results.length;
				})
				.catch((err) => {
					sourceErrors["project-context"] =
						err instanceof Error ? err.message : String(err);
					logger.warn(
						`[UnifiedSearch] Project context search failed: ${sourceErrors["project-context"]}`,
					);
				}),
		);
	}

	// 2. Workspace documents
	if (
		requestedSources.includes("workspace") &&
		workspaceIds &&
		workspaceIds.length > 0
	) {
		sourcesSearched.push("workspace");
		searchPromises.push(
			searchWorkspaceDocs({
				workspaceIds,
				query,
				userId,
				organizationId,
				topK: Math.max(perSourceLimit * 3, perSourceLimit),
				minSimilarity,
				excludeDocumentIds: connectorDocIds,
				sourceType: "workspace",
			})
				.then((results) => {
					allResults.push(...results);
					sourceCounts.workspace = results.length;
				})
				.catch((err) => {
					sourceErrors.workspace =
						err instanceof Error ? err.message : String(err);
					logger.warn(
						`[UnifiedSearch] Workspace search failed: ${sourceErrors.workspace}`,
					);
				}),
		);
	}

	// 3. Connector-backed documents synced into attached workspaces
	if (requestedSources.includes("connector") && connectorDocIds.length > 0) {
		sourcesSearched.push("connector");
		searchPromises.push(
			searchWorkspaceDocs({
				workspaceIds: workspaceIds ?? [],
				query,
				userId,
				organizationId,
				topK: perSourceLimit,
				minSimilarity,
				documentIds: connectorDocIds,
				sourceType: "connector",
				connectorDocsById,
			})
				.then((results) => {
					allResults.push(...results);
					sourceCounts.connector = results.length;
				})
				.catch((err) => {
					sourceErrors.connector =
						err instanceof Error ? err.message : String(err);
					logger.warn(
						`[UnifiedSearch] Connector search failed: ${sourceErrors.connector}`,
					);
				}),
		);
	}

	// 3b. Federated live search (real-time Slack, GitHub, etc.)
	if (requestedSources.includes("connector") && federatedSearchFn) {
		searchPromises.push(
			federatedSearchFn(query, perSourceLimit)
				.then((results) => {
					allResults.push(...results);
					// Add to connector count (federated supplements indexed)
					sourceCounts.connector += results.length;
				})
				.catch((err) => {
					logger.warn(
						`[UnifiedSearch] Federated search failed: ${err instanceof Error ? err.message : err}`,
					);
				}),
		);
	}

	// 4. Code index search (AST-aware code chunks)
	if (requestedSources.includes("code") && codeSearchFn) {
		sourcesSearched.push("code");
		searchPromises.push(
			codeSearchFn(query, perSourceLimit)
				.then((results) => {
					allResults.push(...results);
					sourceCounts.code = results.length;
				})
				.catch((err) => {
					sourceErrors.code =
						err instanceof Error ? err.message : String(err);
					logger.warn(
						`[UnifiedSearch] Code search failed: ${sourceErrors.code}`,
					);
				}),
		);
	}

	// 5. Web search (optional fallback via injected function)
	if (requestedSources.includes("web") && webSearchFn) {
		sourcesSearched.push("web");
		searchPromises.push(
			webSearchFn(query, perSourceLimit)
				.then((results) => {
					allResults.push(...results);
					sourceCounts.web = results.length;
				})
				.catch((err) => {
					sourceErrors.web =
						err instanceof Error ? err.message : String(err);
					logger.warn(
						`[UnifiedSearch] Web search failed: ${sourceErrors.web}`,
					);
				}),
		);
	}

	// Wait for all sources
	await Promise.all(searchPromises);

	// Rank: apply source-type weights and sort
	const rankedResults = rankResults(allResults, weights, totalLimit);

	const searchTimeMs = Date.now() - startTime;
	logger.info(
		`[UnifiedSearch] Complete: ${rankedResults.length} results from ${sourcesSearched.length} sources in ${searchTimeMs}ms`,
	);

	return {
		results: rankedResults,
		sourceCounts,
		searchTimeMs,
		sourcesSearched,
		sourceErrors:
			Object.keys(sourceErrors).length > 0
				? (sourceErrors as Record<UnifiedSearchSourceType, string>)
				: undefined,
	};
}

// =============================================================================
// Source-Specific Search Functions
// =============================================================================

async function searchProjectContexts(options: {
	projectId: string;
	query: string;
	userId: string;
	organizationId?: string;
	topK: number;
	minSimilarity: number;
}): Promise<UnifiedSearchResult[]> {
	const contexts = await retrieveProjectContexts({
		projectId: options.projectId,
		query: options.query,
		userId: options.userId,
		organizationId: options.organizationId,
		topK: options.topK,
		similarityThreshold: options.minSimilarity,
		// Orchestrator unified search: diversify across distinct documents so one
		// multi-chunk document can't monopolise this source's results. Keep the
		// returned count at the caller's per-source limit.
		diversify: true,
		maxContexts: options.topK,
	});

	return contexts.map(contextToUnifiedResult);
}

function contextToUnifiedResult(ctx: RetrievedContext): UnifiedSearchResult {
	return {
		id: ctx.id,
		// Type label + AI guidance (#1888): metadata arrives flag-gated from
		// retrieval; header is "" when unset, so snippets are unchanged for
		// unannotated sources.
		content: `${contextMetaHeader(ctx)}${ctx.content}`,
		source: {
			type: "project-context",
			name: ctx.filename || ctx.sourceTitle || "Project Document",
			badge: "Project",
			url: ctx.sourceUrl,
			filename: ctx.filename,
		},
		relevance: ctx.score,
		metadata: ctx.metadata,
	};
}

async function searchWorkspaceDocs(options: {
	workspaceIds: string[];
	query: string;
	userId: string;
	organizationId?: string;
	topK: number;
	minSimilarity: number;
	documentIds?: string[];
	excludeDocumentIds?: string[];
	sourceType: "workspace" | "connector";
	connectorDocsById?: Map<
		string,
		{
			documentId: string | null;
			workspaceId: string | null;
			title: string;
			externalPath: string | null;
			lastSyncedAt: Date | null;
			connection: {
				id: string;
				name: string;
				provider: string;
				externalWorkspaceName: string | null;
			};
		}
	>;
}): Promise<UnifiedSearchResult[]> {
	const embeddingResult = await generateEmbedding(options.query, {
		userId: options.userId,
		organizationId: options.organizationId,
		tags: ["rag-query", "workspace-search"],
	});

	if (!embeddingResult?.embedding?.length) {
		return [];
	}

	const results = await searchMultipleWorkspaces({
		workspaceIds: options.workspaceIds,
		userId: options.userId,
		organizationId: options.organizationId,
		queryEmbedding: embeddingResult.embedding,
		querySparseVector: generateSparseVector(options.query),
		topK: options.topK,
		minSimilarity: options.minSimilarity,
		documentIds: options.documentIds,
	});

	const filteredResults = options.excludeDocumentIds?.length
		? results.filter(
				(result) =>
					!options.excludeDocumentIds?.includes(result.documentId),
			)
		: results;
	const limitedResults = filteredResults.slice(0, options.topK);
	const chunkContentByKey = await getWorkspaceChunkContentMap(limitedResults);
	const mappedResults: Array<UnifiedSearchResult | null> = limitedResults.map(
		(result): UnifiedSearchResult | null => {
			const chunk = chunkContentByKey.get(
				`${result.documentId}-${result.chunkIndex}`,
			);
			if (!chunk) {
				return null;
			}

			if (options.sourceType === "connector") {
				const connectorDoc = options.connectorDocsById?.get(
					result.documentId,
				);
				const providerName = connectorDoc?.connection.provider
					.toLowerCase()
					.replace(/_/g, " ");
				const title =
					connectorDoc?.title ||
					result.filename ||
					"Connected Document";

				return {
					id: result.chunkId,
					content: chunk.content,
					source: {
						type: "connector" as const,
						name: connectorDoc?.connection.name || title,
						badge: connectorDoc?.connection.provider ?? "CONNECTOR",
						url: connectorDoc?.externalPath || undefined,
						filename: title,
						freshness: connectorDoc?.lastSyncedAt
							? `Synced ${connectorDoc.lastSyncedAt.toISOString()}`
							: undefined,
					},
					relevance: result.score,
					metadata: {
						workspaceId: result.workspaceId,
						documentId: result.documentId,
						chunkIndex: result.chunkIndex,
						pageNumber: result.pageNumber,
						headings: result.headings,
						connectionId: connectorDoc?.connection.id,
						connectionName: connectorDoc?.connection.name,
						provider: connectorDoc?.connection.provider,
						providerLabel: providerName,
					},
				} satisfies UnifiedSearchResult;
			}

			return {
				id: result.chunkId,
				content: chunk.content,
				source: {
					type: "workspace" as const,
					name: result.filename || "Workspace Document",
					badge: "Workspace",
					filename: result.filename,
				},
				relevance: result.score,
				metadata: {
					workspaceId: result.workspaceId,
					documentId: result.documentId,
					chunkIndex: result.chunkIndex,
					pageNumber: result.pageNumber,
					headings: result.headings,
				},
			} satisfies UnifiedSearchResult;
		},
	);

	return mappedResults.filter(
		(result): result is UnifiedSearchResult => result !== null,
	);
}

async function getWorkspaceChunkContentMap(
	results: Array<{ documentId: string; chunkIndex: number }>,
) {
	if (results.length === 0) {
		return new Map<string, { content: string }>();
	}

	const chunks = await db.workspaceDocumentChunk.findMany({
		where: {
			OR: results.map(({ documentId, chunkIndex }) => ({
				documentId,
				chunkIndex,
			})),
		},
		select: {
			documentId: true,
			chunkIndex: true,
			content: true,
		},
	});

	return new Map(
		chunks.map((chunk) => [
			`${chunk.documentId}-${chunk.chunkIndex}`,
			{ content: chunk.content },
		]),
	);
}

// =============================================================================
// Ranking
// =============================================================================

/**
 * Apply source-type weights and produce a final ranked list.
 *
 * Each result's relevance score is multiplied by its source type weight,
 * then all results are sorted and truncated to the total limit.
 */
function rankResults(
	results: UnifiedSearchResult[],
	weights: Record<UnifiedSearchSourceType, number>,
	totalLimit: number,
): UnifiedSearchResult[] {
	// Apply source-type weighting
	const weighted = results.map((r) => ({
		...r,
		relevance: r.relevance * (weights[r.source.type] ?? 0.5),
	}));

	// Sort by weighted relevance (descending)
	weighted.sort((a, b) => b.relevance - a.relevance);

	// Truncate to total limit
	return weighted.slice(0, totalLimit);
}
