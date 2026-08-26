/**
 * Tool Index Service
 *
 * Provides dynamic tool discovery and indexing for the orchestrator.
 * Implements token-efficient tool search following Anthropic's Advanced Tool Use patterns.
 *
 * Key features:
 * - On-demand tool indexing from MCP servers
 * - BM25 text search for keyword matching
 * - Embedding-based semantic search via Qdrant
 * - Qdrant persistence for vector storage
 * - Multi-tenant isolation (userId, organizationId)
 * - TTL-based caching for efficiency
 * - Server-level invalidation
 */

import {
	generateEmbedding,
	generateEmbeddings,
} from "@repo/rag/lib/embedding/generator";
import type { TenantContext } from "@repo/rag/lib/embedding/types";
import {
	type CapabilityPoint,
	type CapabilitySearchOptions,
	deleteCapabilitiesByServer,
	getCapabilitiesByTenant,
	isCapabilityStoreAvailable,
	searchCapabilities,
	upsertCapabilities,
} from "@repo/rag/lib/vector-store/capability-store";

// =============================================================================
// Infrastructure Tools
// =============================================================================

/**
 * Fabric AI tools that are always enabled regardless of the user's
 * enabledFabricToolIds setting. These are project infrastructure, not
 * user-togglable features. Both searchQdrant and loadFromQdrant use this set.
 */
const INFRASTRUCTURE_FABRIC_TOOLS = new Set([
	"project_rag_query",
	"workspace_rag_query",
	"workspace_rag_summarize",
	"fabric_list_architecture_decisions",
	"fabric_list_feature_decisions",
	"fabric_list_security_findings",
]);

// =============================================================================
// Types
// =============================================================================

export interface ToolIndexEntry {
	/** Unique ID: "serverName:toolName" */
	id: string;
	/** MCP server name */
	serverName: string;
	/** Tool name */
	toolName: string;
	/** Tool description for matching */
	description: string;
	/** Extracted keywords for BM25 search */
	keywords: string[];
	/** Pre-computed embedding for semantic search */
	embedding?: number[];
	/** Tool category for filtering */
	category?: ToolCategory;
	/** Risk level determined from tool name */
	riskLevel: "low" | "medium" | "high" | "critical";
	/** Whether this is a read-only tool */
	isReadOnly: boolean;
	/** Input schema for the tool */
	inputSchema?: Record<string, unknown>;
	/** When this entry was last updated */
	lastUpdated: Date;
	/** MCP config ID for direct execution */
	configId: string;
}

export type ToolCategory =
	| "project_management"
	| "communication"
	| "development"
	| "documentation"
	| "data"
	| "automation"
	| "search"
	| "file"
	| "unknown";

export interface ToolSearchOptions {
	/** Natural language query */
	query: string;
	/** Optional category filter */
	category?: ToolCategory;
	/** Maximum results to return */
	limit?: number;
	/** Minimum confidence score (0-1) */
	minConfidence?: number;
	/** Whether to include read-only tools only */
	readOnlyOnly?: boolean;
	/** User ID for tenant isolation */
	userId?: string;
	/** Organization ID for tenant isolation */
	organizationId?: string;
	/** API key for AI Gateway or direct provider (deprecated, use providerConfig) */
	apiKey?: string;
	/** Full provider configuration (apiKey, provider, baseUrl) */
	providerConfig?: {
		apiKey: string;
		provider?: string | null;
		baseUrl?: string | null;
	};
	/** Whether to include system-wide tools */
	includeSystem?: boolean;
	/** Specific MCP config IDs to include (null = all) */
	enabledMcpConfigIds?: string[] | null;
	/** Specific OAuth integration IDs to include (null = all) */
	enabledIntegrationIds?: string[] | null;
	/** Specific Fabric AI tool IDs to include (null = all, [] = none) */
	enabledFabricToolIds?: string[] | null;
}

export interface ToolSearchResult {
	/** Tool entry */
	tool: ToolIndexEntry;
	/** Confidence score (0-1) */
	confidence: number;
	/** Why this tool matched */
	matchReason: string;
	/** Keyword matches */
	keywordMatches: string[];
	/** Semantic similarity score (if applicable) */
	semanticScore?: number;
}

export interface BuildIndexOptions {
	/** MCP configs to index */
	configs: Array<{
		id: string;
		serverName: string;
		tools: Array<{
			name: string;
			description?: string;
			inputSchema?: Record<string, unknown>;
		}>;
	}>;
	/** Whether to generate embeddings */
	generateEmbeddings?: boolean;
	/** Tenant context for API calls */
	tenantContext?: TenantContext;
	/** API key for AI Gateway (deprecated, use providerConfig) */
	apiKey?: string;
	/** Full provider configuration (apiKey, provider, baseUrl) */
	providerConfig?: {
		apiKey: string;
		provider?: string | null;
		baseUrl?: string | null;
	};
	/** User ID for tenant isolation (null for system-wide) */
	userId?: string | null;
	/** Organization ID for tenant isolation */
	organizationId?: string | null;
	/** Whether to persist to Qdrant */
	persistToQdrant?: boolean;
}

// =============================================================================
// BM25 Implementation
// =============================================================================

/**
 * Simple BM25 implementation for keyword-based search
 */
class BM25Index {
	private documents: Map<string, string[]> = new Map();
	private df: Map<string, number> = new Map(); // Document frequency
	private avgDocLen = 0;
	private k1 = 1.5;
	private b = 0.75;

	/**
	 * Add a document to the index
	 */
	addDocument(id: string, terms: string[]): void {
		const normalizedTerms = terms.map((t) => t.toLowerCase());
		this.documents.set(id, normalizedTerms);

		// Update document frequency
		const uniqueTerms = new Set(normalizedTerms);
		for (const term of uniqueTerms) {
			this.df.set(term, (this.df.get(term) || 0) + 1);
		}

		// Update average document length
		let totalLen = 0;
		for (const doc of this.documents.values()) {
			totalLen += doc.length;
		}
		this.avgDocLen = totalLen / this.documents.size;
	}

	/**
	 * Remove a document from the index
	 */
	removeDocument(id: string): void {
		const doc = this.documents.get(id);
		if (!doc) {
			return;
		}

		// Update document frequency
		const uniqueTerms = new Set(doc);
		for (const term of uniqueTerms) {
			const count = this.df.get(term) || 0;
			if (count <= 1) {
				this.df.delete(term);
			} else {
				this.df.set(term, count - 1);
			}
		}

		this.documents.delete(id);

		// Update average document length
		if (this.documents.size > 0) {
			let totalLen = 0;
			for (const doc of this.documents.values()) {
				totalLen += doc.length;
			}
			this.avgDocLen = totalLen / this.documents.size;
		} else {
			this.avgDocLen = 0;
		}
	}

	/**
	 * Search for documents matching the query
	 */
	search(
		query: string,
		limit = 10,
	): Array<{ id: string; score: number; matchedTerms: string[] }> {
		const queryTerms = query
			.toLowerCase()
			.split(/\s+/)
			.filter((t) => t.length > 2);
		const N = this.documents.size;
		const results: Array<{
			id: string;
			score: number;
			matchedTerms: string[];
		}> = [];

		for (const [docId, docTerms] of this.documents) {
			let score = 0;
			const matchedTerms: string[] = [];

			for (const queryTerm of queryTerms) {
				// Count term frequency in document
				const tf = docTerms.filter((t) => t.includes(queryTerm)).length;
				if (tf === 0) {
					continue;
				}

				matchedTerms.push(queryTerm);

				// Calculate IDF
				const docFreq = this.df.get(queryTerm) || 0;
				const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);

				// Calculate BM25 score
				const docLen = docTerms.length;
				const tfNorm =
					(tf * (this.k1 + 1)) /
					(tf +
						this.k1 *
							(1 - this.b + (this.b * docLen) / this.avgDocLen));

				score += idf * tfNorm;
			}

			if (score > 0) {
				results.push({ id: docId, score, matchedTerms });
			}
		}

		// Sort by score descending and limit
		return results.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/**
	 * Clear the index
	 */
	clear(): void {
		this.documents.clear();
		this.df.clear();
		this.avgDocLen = 0;
	}
}

// =============================================================================
// Tool Index Class
// =============================================================================

/**
 * Tool Index for dynamic tool discovery
 */
export class ToolIndex {
	private entries: Map<string, ToolIndexEntry> = new Map();
	private bm25Index: BM25Index = new BM25Index();
	private serverToTools: Map<string, Set<string>> = new Map();
	private categoryToTools: Map<ToolCategory, Set<string>> = new Map();

	// Cache settings
	private lastBuildTime: Date | null = null;
	private buildInProgress = false;
	private readonly cacheTtlMs: number = 5 * 60 * 1000; // 5 minutes
	/** Tenant key that built the current cache (userId:organizationId) */
	private lastTenantKey: string | null = null;

	/**
	 * Build or rebuild the tool index from MCP configs
	 */
	async buildIndex(options: BuildIndexOptions): Promise<void> {
		if (this.buildInProgress) {
			console.log("[ToolIndex] Build already in progress, skipping");
			return;
		}

		this.buildInProgress = true;
		const persistToQdrant = options.persistToQdrant ?? true; // Default to persisting
		console.log(
			`[ToolIndex] Building index for ${options.configs.length} servers (persist=${persistToQdrant})`,
		);

		try {
			const newEntries: ToolIndexEntry[] = [];

			for (const config of options.configs) {
				for (const tool of config.tools) {
					const entry = this.createToolEntry(
						config.id,
						config.serverName,
						tool.name,
						tool.description,
						tool.inputSchema,
					);
					newEntries.push(entry);
				}
			}

			// Build tenant context from either explicit tenantContext or fallback to options.userId/organizationId
			// IMPORTANT: This is used consistently for both embedding generation AND Qdrant persistence
			const effectiveTenantContext = options.tenantContext?.userId
				? options.tenantContext
				: options.userId
					? {
							userId: options.userId,
							organizationId: options.organizationId ?? undefined,
						}
					: null;

			// Generate embeddings (required for Qdrant persistence)
			// NOTE: providerConfig is no longer required - generateEmbeddings() uses
			// tenantContext internally via getAIEmbeddingModelWithMetadata()
			if (
				(options.generateEmbeddings || persistToQdrant) &&
				newEntries.length > 0
			) {
				if (effectiveTenantContext) {
					await this.generateToolEmbeddings(
						newEntries,
						effectiveTenantContext,
					);
				} else {
					console.warn(
						"[ToolIndex] Skipping embedding generation: no userId available (neither tenantContext nor options.userId)",
					);
				}
			}

			// Clear and rebuild in-memory indices
			this.clear();
			for (const entry of newEntries) {
				this.addEntry(entry);
			}

			// Persist to Qdrant for semantic vector search
			// Use the same tenant identifiers as embedding generation for consistency
			if (
				persistToQdrant &&
				newEntries.length > 0 &&
				effectiveTenantContext?.userId
			) {
				await this.persistToQdrant(
					newEntries,
					effectiveTenantContext.userId,
					effectiveTenantContext.organizationId ?? null,
				);
			}

			this.lastBuildTime = new Date();
			if (effectiveTenantContext?.userId) {
				this.lastTenantKey = `${effectiveTenantContext.userId}:${effectiveTenantContext.organizationId ?? ""}`;
			}
			console.log(
				`[ToolIndex] Index built with ${newEntries.length} tools`,
			);
		} finally {
			this.buildInProgress = false;
		}
	}

	/**
	 * Add a single server's tools to the index
	 */
	async addServer(
		configId: string,
		serverName: string,
		tools: Array<{
			name: string;
			description?: string;
			inputSchema?: Record<string, unknown>;
		}>,
		options: {
			userId?: string | null;
			organizationId?: string | null;
			tenantContext?: TenantContext;
			/** @deprecated Use providerConfig instead */
			apiKey?: string;
			providerConfig?: {
				apiKey: string;
				provider?: string | null;
				baseUrl?: string | null;
			};
			persistToQdrant?: boolean;
		},
	): Promise<void> {
		const {
			userId = null,
			organizationId = null,
			tenantContext,
			apiKey: _apiKey,
			providerConfig: _providerConfig,
			persistToQdrant = true,
		} = options;

		// Build effective tenant context for consistent tenant identification
		const effectiveTenantContext: TenantContext | undefined =
			tenantContext ??
			(userId
				? { userId, organizationId: organizationId ?? undefined }
				: undefined);

		// Remove existing tools for this server (from memory and Qdrant)
		// Use effectiveTenantContext for consistency
		await this.invalidateServer(
			serverName,
			effectiveTenantContext?.userId,
			effectiveTenantContext?.organizationId,
		);

		// Create entries
		const entries: ToolIndexEntry[] = [];
		for (const tool of tools) {
			const entry = this.createToolEntry(
				configId,
				serverName,
				tool.name,
				tool.description,
				tool.inputSchema,
			);
			entries.push(entry);
			this.addEntry(entry);
		}

		// Generate embeddings and persist to Qdrant
		// NOTE: providerConfig is no longer required - generateEmbeddings() uses
		// tenantContext internally via getAIEmbeddingModelWithMetadata()
		// effectiveTenantContext is already computed above for invalidateServer
		if (persistToQdrant && entries.length > 0) {
			if (effectiveTenantContext?.userId) {
				await this.generateToolEmbeddings(
					entries,
					effectiveTenantContext,
				);
				// IMPORTANT: Use effectiveTenantContext for consistency with embedding generation
				await this.persistToQdrant(
					entries,
					effectiveTenantContext.userId,
					effectiveTenantContext.organizationId ?? null,
				);
			} else {
				console.warn(
					"[ToolIndex] Skipping embedding generation: no tenant context with userId available",
				);
			}
		}

		console.log(
			`[ToolIndex] Added ${tools.length} tools from server: ${serverName} (persist=${persistToQdrant})`,
		);
	}

	/**
	 * Search for tools matching the query
	 * Uses Qdrant semantic search when userId is provided, falls back to in-memory search otherwise
	 *
	 * NOTE: providerConfig is no longer required - embedding generation uses
	 * tenantContext internally via getAIEmbeddingModelWithMetadata()
	 */
	async search(
		options: ToolSearchOptions,
		tenantContext?: TenantContext,
	): Promise<ToolSearchResult[]> {
		const {
			query,
			category,
			limit = 10,
			minConfidence = 0.2,
			readOnlyOnly = false,
			userId,
			organizationId,
			includeSystem = true,
		} = options;

		console.log(`[ToolIndex] Searching for: "${query}" (userId=${userId})`);

		// Use Qdrant semantic search if userId is provided and Qdrant is available
		if (userId) {
			try {
				const qdrantAvailable = await isCapabilityStoreAvailable();
				if (qdrantAvailable) {
					// tenantContext is used internally by generateEmbedding() to resolve
					// the embedding model and API key via getAIEmbeddingModelWithMetadata()
					const effectiveTenantContext: TenantContext =
						tenantContext ?? {
							userId,
							organizationId,
						};

					return await this.searchQdrant(query, {
						category,
						limit,
						minConfidence,
						readOnlyOnly,
						userId,
						organizationId,
						includeSystem,
						tenantContext: effectiveTenantContext,
						enabledMcpConfigIds: options.enabledMcpConfigIds,
						enabledIntegrationIds: options.enabledIntegrationIds,
						enabledFabricToolIds: options.enabledFabricToolIds,
					});
				}
			} catch (error) {
				console.warn(
					"[ToolIndex] Qdrant search failed, falling back to in-memory:",
					error,
				);
			}
		}

		// Fall back to in-memory BM25 search
		return this.searchInMemory(query, {
			category,
			limit,
			minConfidence,
			readOnlyOnly,
		});
	}

	/**
	 * Search using Qdrant semantic vector search
	 *
	 * NOTE: providerConfig is no longer required - generateEmbedding() uses
	 * tenantContext internally via getAIEmbeddingModelWithMetadata()
	 */
	private async searchQdrant(
		query: string,
		options: {
			category?: ToolCategory;
			limit: number;
			minConfidence: number;
			readOnlyOnly: boolean;
			userId: string;
			organizationId?: string;
			includeSystem: boolean;
			tenantContext: TenantContext;
			enabledMcpConfigIds?: string[] | null;
			enabledIntegrationIds?: string[] | null;
			enabledFabricToolIds?: string[] | null;
		},
	): Promise<ToolSearchResult[]> {
		// Generate query embedding - tenantContext is used internally to resolve
		// embedding model and API key via getAIEmbeddingModelWithMetadata()
		const result = await generateEmbedding(query, options.tenantContext);

		// Search Qdrant
		const searchOptions: CapabilitySearchOptions = {
			queryEmbedding: result.embedding,
			type: "mcp_tool",
			category: options.category,
			userId: options.userId,
			organizationId: options.organizationId,
			includeSystem: options.includeSystem,
			minScore: options.minConfidence,
			limit: options.limit,
		};

		const qdrantResults = await searchCapabilities(searchOptions);

		// Debug: Log raw Qdrant results before filtering
		if (qdrantResults.length > 0) {
			console.log(
				`[ToolIndex] Qdrant returned ${qdrantResults.length} raw results (top scores: ${qdrantResults
					.slice(0, 5)
					.map((r) => `${r.capability.name}=${r.score.toFixed(3)}`)
					.join(", ")})`,
			);
		} else {
			console.log(
				`[ToolIndex] Qdrant returned 0 results for query: "${query}" (minScore=${options.minConfidence}, userId=${options.userId}, orgId=${options.organizationId})`,
			);
		}

		// CRITICAL: Filter by enabled MCP config IDs, Integration IDs, and Fabric AI tool IDs
		// This ensures tools from disabled integrations/servers don't appear in search results
		const enabledConfigSet = Array.isArray(options.enabledMcpConfigIds)
			? new Set(options.enabledMcpConfigIds)
			: null;
		const enabledIntegrationSet = Array.isArray(
			options.enabledIntegrationIds,
		)
			? new Set(options.enabledIntegrationIds)
			: null;
		const enabledFabricToolSet = Array.isArray(options.enabledFabricToolIds)
			? new Set(options.enabledFabricToolIds)
			: null;

		const mcpExplicitlyDisabled =
			enabledConfigSet !== null && enabledConfigSet.size === 0;
		const integrationsExplicitlyDisabled =
			enabledIntegrationSet !== null && enabledIntegrationSet.size === 0;

		const filteredQdrantResults = qdrantResults.filter((qResult) => {
			const configId = qResult.capability.metadata?.configId as
				| string
				| undefined;

			if (!configId) {
				// No configId = system tool (Fabric AI, etc.) - always include
				return true;
			}

			// Fabric AI tools: configId === "fabric-ai-server"
			// Apply tool-name-level filtering when enabledFabricToolIds is provided
			if (configId === "fabric-ai-server") {
				if (enabledFabricToolSet !== null) {
					const toolName = qResult.capability.name;
					if (INFRASTRUCTURE_FABRIC_TOOLS.has(toolName)) {
						return true;
					}
					const isEnabled = enabledFabricToolSet.has(toolName);
					if (!isEnabled) {
						console.log(
							`[ToolIndex] Excluding Fabric AI tool from search (not in enabled list): ${toolName}`,
						);
					}
					return isEnabled;
				}
				// No Fabric tool filter = include all (config-level filter still applies below)
			}

			// Check if this is an OAuth integration tool (configId format: oauth:integration:{integrationId})
			if (configId.startsWith("oauth:integration:")) {
				const integrationId = configId.replace(
					"oauth:integration:",
					"",
				);

				// If integrations are explicitly disabled (empty array), exclude
				if (integrationsExplicitlyDisabled) {
					console.log(
						`[ToolIndex] Excluding OAuth tool from search (integrations disabled): ${qResult.capability.name}`,
					);
					return false;
				}

				// If we have a specific list of enabled integrations, check it
				if (enabledIntegrationSet !== null) {
					const isEnabled = enabledIntegrationSet.has(integrationId);
					if (!isEnabled) {
						console.log(
							`[ToolIndex] Excluding OAuth tool from search (integration not enabled): ${qResult.capability.name}`,
						);
					}
					return isEnabled;
				}

				// No filter = include all OAuth tools
				return true;
			}

			// Regular MCP tools: configId is the MCPConfig.id from database
			// If MCP tools are explicitly disabled (empty array), exclude
			if (mcpExplicitlyDisabled) {
				console.log(
					`[ToolIndex] Excluding MCP tool from search (MCP disabled): ${qResult.capability.name}`,
				);
				return false;
			}

			// If we have a specific list of enabled configs, check it
			if (enabledConfigSet !== null) {
				const isEnabled = enabledConfigSet.has(configId);
				if (!isEnabled) {
					console.log(
						`[ToolIndex] Excluding MCP tool from search (config not enabled): ${qResult.capability.name}`,
					);
				}
				return isEnabled;
			}

			// No filter = include all MCP tools
			return true;
		});

		// Debug: Log filter results
		console.log(
			`[ToolIndex] After config/integration filter: ${filteredQdrantResults.length} of ${qdrantResults.length} results remain`,
		);

		// Get BM25 scores for hybrid matching
		const bm25Results = this.bm25Index.search(query, options.limit * 2);
		const bm25Scores = new Map(
			bm25Results.map((r) => [
				r.id,
				{ score: r.score, matched: r.matchedTerms },
			]),
		);

		// Debug: Log BM25 results
		if (bm25Results.length > 0) {
			console.log(
				`[ToolIndex] BM25 top results: ${bm25Results
					.slice(0, 5)
					.map(
						(r) =>
							`${r.id}(score=${r.score.toFixed(2)}, terms=${r.matchedTerms.join(",")})`,
					)
					.join("; ")}`,
			);
		}

		// Convert to ToolSearchResult with hybrid scoring
		const results: ToolSearchResult[] = [];
		const filteredOutByHybrid: Array<{
			name: string;
			semantic: number;
			bm25: number;
			hybrid: number;
		}> = [];

		for (const qResult of filteredQdrantResults) {
			const toolId = qResult.capability.id;
			const entry = this.entries.get(toolId);

			// Skip if read-only filter not met
			if (options.readOnlyOnly && entry && !entry.isReadOnly) {
				continue;
			}

			const semanticScore = qResult.score;
			const bm25Data = bm25Scores.get(toolId);
			const bm25Score = bm25Data ? Math.min(bm25Data.score / 10, 1) : 0;

			// Hybrid score: 60% semantic + 40% BM25
			const confidence = 0.6 * semanticScore + 0.4 * bm25Score;

			if (confidence < options.minConfidence) {
				filteredOutByHybrid.push({
					name: qResult.capability.name,
					semantic: semanticScore,
					bm25: bm25Score,
					hybrid: confidence,
				});
			}

			if (confidence >= options.minConfidence) {
				// Use in-memory entry if available, otherwise construct from Qdrant result
				const tool: ToolIndexEntry = entry || {
					id: toolId,
					serverName: qResult.capability.metadata.serverName || "",
					toolName: qResult.capability.name,
					description: qResult.capability.description,
					keywords: [],
					category: qResult.capability.metadata.category as
						| ToolCategory
						| undefined,
					riskLevel: qResult.capability.metadata.riskLevel || "low",
					isReadOnly: qResult.capability.metadata.isReadOnly || false,
					inputSchema: qResult.capability.metadata.inputSchema,
					lastUpdated: new Date(
						qResult.capability.metadata.updatedAt,
					),
					configId: qResult.capability.metadata.configId || "",
				};

				results.push({
					tool,
					confidence: Math.min(confidence, 1),
					matchReason: `Semantic match (${(semanticScore * 100).toFixed(1)}%) + keyword (${(bm25Score * 100).toFixed(1)}%)`,
					keywordMatches: bm25Data?.matched || [],
					semanticScore,
				});
			}
		}

		// Debug: Log tools filtered out by hybrid scoring
		if (filteredOutByHybrid.length > 0) {
			console.log(
				`[ToolIndex] ${filteredOutByHybrid.length} results filtered by hybrid score (threshold=${options.minConfidence}): ${filteredOutByHybrid
					.map(
						(t) =>
							`${t.name}(sem=${t.semantic.toFixed(3)},bm25=${t.bm25.toFixed(3)},hybrid=${t.hybrid.toFixed(3)})`,
					)
					.join(", ")}`,
			);
		}

		return results
			.sort((a, b) => b.confidence - a.confidence)
			.slice(0, options.limit);
	}

	/**
	 * In-memory BM25 search fallback
	 */
	private searchInMemory(
		query: string,
		options: {
			category?: ToolCategory;
			limit: number;
			minConfidence: number;
			readOnlyOnly: boolean;
		},
	): ToolSearchResult[] {
		const { category, limit, minConfidence, readOnlyOnly } = options;

		// Filter candidates by category and read-only
		let candidates = Array.from(this.entries.values());

		if (category) {
			const categoryTools = this.categoryToTools.get(category);
			if (categoryTools) {
				candidates = candidates.filter((e) => categoryTools.has(e.id));
			} else {
				candidates = [];
			}
		}

		if (readOnlyOnly) {
			candidates = candidates.filter((e) => e.isReadOnly);
		}

		if (candidates.length === 0) {
			return [];
		}

		// BM25 search
		const bm25Results = this.bm25Index.search(query, limit * 2);
		const bm25Scores = new Map(
			bm25Results.map((r) => [
				r.id,
				{ score: r.score, matched: r.matchedTerms },
			]),
		);

		// Build results with scores
		const results: ToolSearchResult[] = [];

		for (const entry of candidates) {
			const bm25Data = bm25Scores.get(entry.id);
			let confidence = 0;
			let matchReason = "";
			const keywordMatches: string[] = [];

			if (bm25Data) {
				// Normalize BM25 score to 0-1 range (rough approximation)
				const normalizedBm25 = Math.min(bm25Data.score / 10, 1);
				confidence = normalizedBm25;
				keywordMatches.push(...bm25Data.matched);
				matchReason = `Keyword match: ${bm25Data.matched.join(", ")}`;
			}

			// Direct name match boost
			const queryLower = query.toLowerCase();
			const toolNameLower = entry.toolName.toLowerCase();
			if (
				toolNameLower.includes(queryLower) ||
				queryLower.includes(toolNameLower)
			) {
				confidence += 0.3;
				matchReason = `Direct name match: ${entry.toolName}`;
			}

			// Server name match boost
			const serverLower = entry.serverName.toLowerCase();
			if (queryLower.includes(serverLower)) {
				confidence += 0.2;
				matchReason += ` (server: ${entry.serverName})`;
			}

			if (confidence >= minConfidence) {
				results.push({
					tool: entry,
					confidence: Math.min(confidence, 1),
					matchReason,
					keywordMatches,
				});
			}
		}

		// Sort by confidence and limit
		return results
			.sort((a, b) => b.confidence - a.confidence)
			.slice(0, limit);
	}

	/**
	 * Search with semantic similarity using query embedding
	 */
	async searchSemantic(
		query: string,
		queryEmbedding: number[],
		options: Omit<ToolSearchOptions, "query" | "useSemanticSearch">,
	): Promise<ToolSearchResult[]> {
		const {
			category,
			limit = 10,
			minConfidence = 0.2,
			readOnlyOnly = false,
		} = options;

		// Filter candidates
		let candidates = Array.from(this.entries.values()).filter(
			(e) => e.embedding && e.embedding.length > 0,
		);

		if (category) {
			const categoryTools = this.categoryToTools.get(category);
			if (categoryTools) {
				candidates = candidates.filter((e) => categoryTools.has(e.id));
			} else {
				candidates = [];
			}
		}

		if (readOnlyOnly) {
			candidates = candidates.filter((e) => e.isReadOnly);
		}

		// Get BM25 results for hybrid scoring
		const bm25Results = this.bm25Index.search(query, limit * 2);
		const bm25Scores = new Map(
			bm25Results.map((r) => [
				r.id,
				{ score: r.score, matched: r.matchedTerms },
			]),
		);

		// Calculate semantic similarity and combine with BM25
		const results: ToolSearchResult[] = [];

		for (const entry of candidates) {
			// Type guard - candidates are pre-filtered to have embeddings
			if (!entry.embedding) {
				continue;
			}
			const semanticScore = this.cosineSimilarity(
				queryEmbedding,
				entry.embedding,
			);
			const bm25Data = bm25Scores.get(entry.id);
			const bm25Score = bm25Data ? Math.min(bm25Data.score / 10, 1) : 0;

			// Hybrid score: 60% semantic + 40% BM25
			const confidence = 0.6 * semanticScore + 0.4 * bm25Score;

			if (confidence >= minConfidence) {
				results.push({
					tool: entry,
					confidence: Math.min(confidence, 1),
					matchReason: `Semantic match (${(semanticScore * 100).toFixed(1)}%) + keyword (${(bm25Score * 100).toFixed(1)}%)`,
					keywordMatches: bm25Data?.matched || [],
					semanticScore,
				});
			}
		}

		return results
			.sort((a, b) => b.confidence - a.confidence)
			.slice(0, limit);
	}

	/**
	 * Get a tool entry by ID
	 */
	getEntry(id: string): ToolIndexEntry | undefined {
		return this.entries.get(id);
	}

	/**
	 * Get all tools for a server
	 */
	getServerTools(serverName: string): ToolIndexEntry[] {
		const toolIds = this.serverToTools.get(serverName);
		if (!toolIds) {
			return [];
		}
		return Array.from(toolIds)
			.map((id) => this.entries.get(id))
			.filter((e): e is ToolIndexEntry => !!e);
	}

	/**
	 * Get tools by category
	 */
	getCategoryTools(category: ToolCategory): ToolIndexEntry[] {
		const toolIds = this.categoryToTools.get(category);
		if (!toolIds) {
			return [];
		}
		return Array.from(toolIds)
			.map((id) => this.entries.get(id))
			.filter((e): e is ToolIndexEntry => !!e);
	}

	/**
	 * Get all tool entries
	 */
	getAllEntries(): ToolIndexEntry[] {
		return Array.from(this.entries.values());
	}

	/**
	 * Get all server names
	 */
	getServerNames(): string[] {
		return Array.from(this.serverToTools.keys());
	}

	/**
	 * Invalidate (remove) all tools from a server
	 * Removes from both in-memory index and Qdrant
	 */
	async invalidateServer(
		serverName: string,
		userId?: string,
		organizationId?: string,
	): Promise<void> {
		// Remove from in-memory index
		const toolIds = this.serverToTools.get(serverName);
		if (toolIds) {
			for (const id of toolIds) {
				const entry = this.entries.get(id);
				if (entry) {
					// Remove from BM25 index
					this.bm25Index.removeDocument(id);
					// Remove from category index
					if (entry.category) {
						this.categoryToTools.get(entry.category)?.delete(id);
					}
					// Remove from entries
					this.entries.delete(id);
				}
			}
			this.serverToTools.delete(serverName);
		}

		// Remove from Qdrant if tenant info is provided
		if (userId) {
			try {
				await deleteCapabilitiesByServer(
					serverName,
					userId,
					organizationId,
				);
				console.log(
					`[ToolIndex] Invalidated tools for server: ${serverName} (Qdrant + memory)`,
				);
			} catch (error) {
				console.warn(
					`[ToolIndex] Failed to delete from Qdrant for server: ${serverName}`,
					error,
				);
			}
		} else {
			console.log(
				`[ToolIndex] Invalidated tools for server: ${serverName} (memory only)`,
			);
		}
	}

	/**
	 * Legacy sync version for backward compatibility
	 * @deprecated Use invalidateServer(serverName, userId, organizationId) instead
	 */
	invalidateServerSync(serverName: string): void {
		const toolIds = this.serverToTools.get(serverName);
		if (!toolIds) {
			return;
		}

		for (const id of toolIds) {
			const entry = this.entries.get(id);
			if (entry) {
				// Remove from BM25 index
				this.bm25Index.removeDocument(id);
				// Remove from category index
				if (entry.category) {
					this.categoryToTools.get(entry.category)?.delete(id);
				}
				// Remove from entries
				this.entries.delete(id);
			}
		}

		this.serverToTools.delete(serverName);
		console.log(`[ToolIndex] Invalidated tools for server: ${serverName}`);
	}

	/**
	 * Check if the index needs rebuilding
	 */
	needsRebuild(userId?: string, organizationId?: string): boolean {
		if (!this.lastBuildTime) {
			return true;
		}
		// Force rebuild if tenant changed — prevents cross-tenant cache leaks
		if (userId) {
			const tenantKey = `${userId}:${organizationId ?? ""}`;
			if (
				this.lastTenantKey !== null &&
				this.lastTenantKey !== tenantKey
			) {
				console.log(
					`[ToolIndex] Tenant changed (${this.lastTenantKey} → ${tenantKey}), forcing rebuild`,
				);
				return true;
			}
		}
		const age = Date.now() - this.lastBuildTime.getTime();
		return age > this.cacheTtlMs;
	}

	/**
	 * Get index statistics
	 */
	getStats(): {
		totalTools: number;
		servers: number;
		categories: Record<string, number>;
		hasEmbeddings: number;
		lastBuildTime: Date | null;
	} {
		const categories: Record<string, number> = {};
		for (const [cat, tools] of this.categoryToTools) {
			categories[cat] = tools.size;
		}

		const hasEmbeddings = Array.from(this.entries.values()).filter(
			(e) => e.embedding && e.embedding.length > 0,
		).length;

		return {
			totalTools: this.entries.size,
			servers: this.serverToTools.size,
			categories,
			hasEmbeddings,
			lastBuildTime: this.lastBuildTime,
		};
	}

	/**
	 * Load tools from Qdrant capability store (fast, no MCP connections)
	 * This is the preferred method for rebuilding the in-memory index when
	 * the data already exists in Qdrant but the local cache has expired.
	 *
	 * Returns true if loading was successful (found tools), false otherwise.
	 */
	async loadFromQdrant(
		userId: string,
		organizationId?: string,
		enabledMcpConfigIds?: string[] | null,
		enabledIntegrationIds?: string[] | null,
		enabledFabricToolIds?: string[] | null,
	): Promise<boolean> {
		if (this.buildInProgress) {
			console.log(
				"[ToolIndex] Build already in progress, skipping loadFromQdrant",
			);
			return false;
		}

		// Check if Qdrant is available
		const isAvailable = await isCapabilityStoreAvailable();
		if (!isAvailable) {
			console.log(
				"[ToolIndex] Qdrant not available, cannot load from cache",
			);
			return false;
		}

		this.buildInProgress = true;
		console.log(
			"[ToolIndex] Loading tools from Qdrant cache (no MCP connections)...",
		);

		try {
			// Get all cached tools from Qdrant
			const capabilities = await getCapabilitiesByTenant(
				userId,
				organizationId,
				"mcp_tool", // Only load MCP tools
				1000, // Max tools
			);

			if (capabilities.length === 0) {
				console.log("[ToolIndex] No cached tools found in Qdrant");
				return false;
			}

			// CRITICAL: Filter by enabled MCP config IDs and Integration IDs if provided
			// This respects Orchestrator preferences (disabled integrations/servers are excluded)
			let filteredCapabilities = capabilities;

			// Build filter sets
			const enabledConfigSet = Array.isArray(enabledMcpConfigIds)
				? new Set(enabledMcpConfigIds)
				: null;
			const enabledIntegrationSet = Array.isArray(enabledIntegrationIds)
				? new Set(enabledIntegrationIds)
				: null;
			const enabledFabricToolSet = Array.isArray(enabledFabricToolIds)
				? new Set(enabledFabricToolIds)
				: null;

			// Check for explicit "disable all" cases
			const mcpExplicitlyDisabled =
				enabledConfigSet !== null && enabledConfigSet.size === 0;
			const integrationsExplicitlyDisabled =
				enabledIntegrationSet !== null &&
				enabledIntegrationSet.size === 0;

			// Debug: Log what we're filtering with
			if (enabledConfigSet) {
				console.log(
					"[ToolIndex] Filtering MCP tools with enabled configs:",
					Array.from(enabledConfigSet),
				);
			}
			if (enabledIntegrationSet) {
				console.log(
					"[ToolIndex] Filtering OAuth tools with enabled integrations:",
					Array.from(enabledIntegrationSet),
				);
			}
			if (enabledFabricToolSet) {
				console.log(
					"[ToolIndex] Filtering Fabric AI tools with enabled tool IDs:",
					Array.from(enabledFabricToolSet),
				);
			}

			filteredCapabilities = capabilities.filter((result) => {
				const cap = result.capability;
				const metadata = cap.metadata || {};
				const configId = metadata.configId as string | undefined;

				if (!configId) {
					// No configId = system tool (Fabric AI, etc.) - always include
					console.log(
						`[ToolIndex] Including system tool (no configId): ${cap.name}`,
					);
					return true;
				}

				// Fabric AI tools: apply tool-name-level filtering
				if (configId === "fabric-ai-server") {
					if (enabledFabricToolSet !== null) {
						if (INFRASTRUCTURE_FABRIC_TOOLS.has(cap.name)) {
							return true;
						}
						const isEnabled = enabledFabricToolSet.has(cap.name);
						if (!isEnabled) {
							console.log(
								`[ToolIndex] Excluding Fabric AI tool (not in enabled list): ${cap.name}`,
							);
						}
						return isEnabled;
					}
					// No Fabric tool filter = config-level filter still applies below
				}

				// Check if this is an OAuth integration tool (configId format: oauth:integration:{integrationId})
				if (configId.startsWith("oauth:integration:")) {
					const integrationId = configId.replace(
						"oauth:integration:",
						"",
					);

					// If integrations are explicitly disabled (empty array), exclude
					if (integrationsExplicitlyDisabled) {
						console.log(
							`[ToolIndex] Excluding OAuth tool (integrations disabled): ${cap.name}`,
						);
						return false;
					}

					// If we have a specific list of enabled integrations, check it
					if (enabledIntegrationSet !== null) {
						const isEnabled =
							enabledIntegrationSet.has(integrationId);
						console.log(
							`[ToolIndex] OAuth Tool: ${cap.name}, integrationId: ${integrationId}, enabled: ${isEnabled}`,
						);
						return isEnabled;
					}

					// No filter = include all OAuth tools
					console.log(
						`[ToolIndex] Including OAuth tool (no filter): ${cap.name}`,
					);
					return true;
				}

				// Regular MCP tools: configId is the MCPConfig.id from database
				// If MCP tools are explicitly disabled (empty array), exclude
				if (mcpExplicitlyDisabled) {
					console.log(
						`[ToolIndex] Excluding MCP tool (MCP disabled): ${cap.name}`,
					);
					return false;
				}

				// If we have a specific list of enabled configs, check it
				if (enabledConfigSet !== null) {
					const isEnabled = enabledConfigSet.has(configId);
					console.log(
						`[ToolIndex] MCP Tool: ${cap.name}, configId: ${configId}, enabled: ${isEnabled}`,
					);
					return isEnabled;
				}

				// No filter = include all MCP tools
				console.log(
					`[ToolIndex] Including MCP tool (no filter): ${cap.name}`,
				);
				return true;
			});

			console.log(
				`[ToolIndex] Filtered from ${capabilities.length} to ${filteredCapabilities.length} tools based on enabled configs/integrations`,
			);

			if (filteredCapabilities.length === 0) {
				console.log("[ToolIndex] No tools match enabled config filter");
				return false;
			}

			// Clear existing in-memory index
			this.clear();

			// Convert capabilities back to ToolIndexEntry format
			for (const result of filteredCapabilities) {
				const cap = result.capability;
				const metadata = cap.metadata || {};
				const serverName = metadata.serverName || "unknown";
				const toolName = cap.name;
				// CRITICAL: Use the capability ID from Qdrant, not a reconstructed one
				// Ingestion stores IDs as "userId:serverName:toolName" for user tools
				// or "serverName:toolName" for system tools
				const id = cap.id || `${serverName}:${toolName}`;

				const entry: ToolIndexEntry = {
					id,
					serverName,
					toolName,
					description: cap.description || "",
					keywords: this.extractKeywords(
						toolName,
						cap.description,
						serverName,
					),
					category:
						(metadata.category as ToolCategory) ||
						this.inferCategory(
							toolName,
							cap.description,
							serverName,
						),
					riskLevel:
						metadata.riskLevel || this.determineRiskLevel(toolName),
					isReadOnly:
						metadata.isReadOnly ?? this.isReadOnlyTool(toolName),
					inputSchema: metadata.inputSchema,
					lastUpdated: new Date(metadata.updatedAt || Date.now()),
					configId: metadata.configId || "",
					// Note: embeddings are stored in Qdrant, not needed in memory
					// because semantic search goes directly to Qdrant
				};

				this.addEntry(entry);
			}

			this.lastBuildTime = new Date();
			this.lastTenantKey = `${userId}:${organizationId ?? ""}`;
			console.log(
				`[ToolIndex] Loaded ${filteredCapabilities.length} tools from Qdrant cache`,
			);
			return true;
		} catch (error) {
			console.warn("[ToolIndex] Failed to load from Qdrant:", error);
			return false;
		} finally {
			this.buildInProgress = false;
		}
	}

	/**
	 * Clear all entries
	 */
	clear(): void {
		this.entries.clear();
		this.bm25Index.clear();
		this.serverToTools.clear();
		this.categoryToTools.clear();
	}

	// ==========================================================================
	// Private Methods
	// ==========================================================================

	private addEntry(entry: ToolIndexEntry): void {
		this.entries.set(entry.id, entry);

		// Add to BM25 index
		this.bm25Index.addDocument(entry.id, entry.keywords);

		// Add to server index
		if (!this.serverToTools.has(entry.serverName)) {
			this.serverToTools.set(entry.serverName, new Set());
		}
		this.serverToTools.get(entry.serverName)?.add(entry.id);

		// Add to category index
		if (entry.category) {
			if (!this.categoryToTools.has(entry.category)) {
				this.categoryToTools.set(entry.category, new Set());
			}
			this.categoryToTools.get(entry.category)?.add(entry.id);
		}
	}

	private createToolEntry(
		configId: string,
		serverName: string,
		toolName: string,
		description?: string,
		inputSchema?: Record<string, unknown>,
	): ToolIndexEntry {
		const id = `${serverName}:${toolName}`;
		const keywords = this.extractKeywords(
			toolName,
			description,
			serverName,
		);
		const category = this.inferCategory(toolName, description, serverName);
		const riskLevel = this.determineRiskLevel(toolName);
		const isReadOnly = this.isReadOnlyTool(toolName);

		return {
			id,
			serverName,
			toolName,
			description: description || "",
			keywords,
			category,
			riskLevel,
			isReadOnly,
			inputSchema,
			lastUpdated: new Date(),
			configId,
		};
	}

	private extractKeywords(
		name: string,
		description?: string,
		serverName?: string,
	): string[] {
		const keywords: string[] = [];

		// IMPORTANT: Add server name keywords FIRST (highest priority for BM25)
		// This ensures "context7" in query matches tools from "Context7" server
		if (serverName) {
			// Add full server name
			keywords.push(serverName.toLowerCase());
			// Add parts of server name (split by spaces, dashes, underscores)
			const serverParts = serverName
				.toLowerCase()
				.split(/[\s\-_]+/)
				.filter((w) => w.length > 2);
			keywords.push(...serverParts);
			// Add without common suffixes (e.g., "Context7 MCP" -> "context7")
			const nameWithoutSuffix = serverName
				.toLowerCase()
				.replace(/\s*(mcp|server|api|service)$/i, "")
				.trim();
			if (nameWithoutSuffix.length > 2) {
				keywords.push(nameWithoutSuffix);
			}
		}

		// Extract from name (split camelCase and snake_case)
		const nameWords = name
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.replace(/_/g, " ")
			.toLowerCase()
			.split(/\s+/)
			.filter((w) => w.length > 2);
		keywords.push(...nameWords);

		// Add common operation keywords based on name patterns
		const nameLower = name.toLowerCase();
		if (nameLower.includes("search")) {
			keywords.push("search", "find", "query");
		}
		if (nameLower.includes("get") || nameLower.includes("list")) {
			keywords.push("read", "fetch", "retrieve");
		}
		if (nameLower.includes("create")) {
			keywords.push("create", "add", "new");
		}
		if (nameLower.includes("update")) {
			keywords.push("update", "modify", "change");
		}
		if (nameLower.includes("delete")) {
			keywords.push("delete", "remove");
		}
		if (nameLower.includes("scrape")) {
			keywords.push("scrape", "crawl", "extract");
		}

		// Extract from description
		if (description) {
			const descWords = description
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 3 && !this.isStopWord(w));
			keywords.push(...descWords.slice(0, 20)); // Limit description keywords
		}

		// Deduplicate
		return [...new Set(keywords)];
	}

	private inferCategory(
		name: string,
		description?: string,
		serverName?: string,
	): ToolCategory {
		const combined =
			`${name} ${description || ""} ${serverName || ""}`.toLowerCase();

		// Project management
		if (
			combined.includes("fizzy") ||
			combined.includes("kanban") ||
			combined.includes("board") ||
			combined.includes("card") ||
			combined.includes("task") ||
			combined.includes("project") ||
			combined.includes("linear") ||
			combined.includes("jira")
		) {
			return "project_management";
		}

		// Communication
		if (
			combined.includes("slack") ||
			combined.includes("message") ||
			combined.includes("email") ||
			combined.includes("notification") ||
			combined.includes("chat")
		) {
			return "communication";
		}

		// Development
		if (
			combined.includes("github") ||
			combined.includes("git") ||
			combined.includes("code") ||
			combined.includes("commit") ||
			combined.includes("pull request") ||
			combined.includes("repository")
		) {
			return "development";
		}

		// Documentation
		if (
			combined.includes("document") ||
			combined.includes("doc") ||
			combined.includes("wiki") ||
			combined.includes("confluence") ||
			combined.includes("notion")
		) {
			return "documentation";
		}

		// Search
		if (
			combined.includes("search") ||
			combined.includes("scrape") ||
			combined.includes("crawl") ||
			combined.includes("firecrawl") ||
			combined.includes("web")
		) {
			return "search";
		}

		// File operations
		if (
			combined.includes("file") ||
			combined.includes("upload") ||
			combined.includes("download") ||
			combined.includes("storage")
		) {
			return "file";
		}

		// Data
		if (
			combined.includes("database") ||
			combined.includes("sql") ||
			combined.includes("query") ||
			combined.includes("data")
		) {
			return "data";
		}

		// Automation
		if (
			combined.includes("automate") ||
			combined.includes("workflow") ||
			combined.includes("trigger") ||
			combined.includes("schedule")
		) {
			return "automation";
		}

		return "unknown";
	}

	private determineRiskLevel(
		toolName: string,
	): "low" | "medium" | "high" | "critical" {
		const nameLower = toolName.toLowerCase();

		if (nameLower.includes("delete") || nameLower.includes("remove")) {
			return "critical";
		}

		if (
			nameLower.includes("create") ||
			nameLower.includes("add") ||
			nameLower.includes("post")
		) {
			return "high";
		}

		if (
			nameLower.includes("update") ||
			nameLower.includes("modify") ||
			nameLower.includes("patch")
		) {
			return "medium";
		}

		return "low";
	}

	private isReadOnlyTool(toolName: string): boolean {
		const nameLower = toolName.toLowerCase();
		return (
			(nameLower.includes("get") ||
				nameLower.includes("list") ||
				nameLower.includes("search") ||
				nameLower.includes("find") ||
				nameLower.includes("read") ||
				nameLower.includes("fetch") ||
				nameLower.includes("query")) &&
			!(
				nameLower.includes("create") ||
				nameLower.includes("update") ||
				nameLower.includes("delete") ||
				nameLower.includes("add") ||
				nameLower.includes("remove") ||
				nameLower.includes("post") ||
				nameLower.includes("patch")
			)
		);
	}

	private isStopWord(word: string): boolean {
		const stopWords = new Set([
			"the",
			"a",
			"an",
			"and",
			"or",
			"but",
			"in",
			"on",
			"at",
			"to",
			"for",
			"of",
			"with",
			"by",
			"from",
			"as",
			"is",
			"was",
			"are",
			"were",
			"been",
			"be",
			"have",
			"has",
			"had",
			"do",
			"does",
			"did",
			"will",
			"would",
			"could",
			"should",
			"may",
			"might",
			"must",
			"shall",
			"can",
			"this",
			"that",
			"these",
			"those",
			"it",
			"its",
		]);
		return stopWords.has(word);
	}

	/**
	 * Generate embeddings for tool entries
	 *
	 * NOTE: providerConfig is no longer required - generateEmbeddings() uses
	 * tenantContext internally via getAIEmbeddingModelWithMetadata()
	 */
	private async generateToolEmbeddings(
		entries: ToolIndexEntry[],
		tenantContext: TenantContext,
	): Promise<void> {
		console.log(
			`[ToolIndex] Generating embeddings for ${entries.length} tools`,
		);

		// Prepare texts for embedding
		// IMPORTANT: Server name comes FIRST for better semantic matching
		// This ensures "use context7 to..." queries match Context7 tools
		const texts = entries.map((e) => {
			// Put server name FIRST - this is critical for matching user queries
			// like "use context7 mcp to..." or "use firecrawl to..."
			const parts: string[] = [];
			if (e.serverName) {
				// Include server name prominently at the start
				parts.push(`[${e.serverName}]`);
				// Also add normalized version for better matching
				const normalized = e.serverName
					.toLowerCase()
					.replace(/\s*(mcp|server|api|service)$/i, "")
					.trim();
				if (normalized !== e.serverName.toLowerCase()) {
					parts.push(`[${normalized}]`);
				}
			}
			// Then add tool name
			parts.push(
				e.toolName
					.replace(/([a-z])([A-Z])/g, "$1 $2")
					.replace(/_/g, " "),
			);
			// Then description
			if (e.description) {
				parts.push(e.description);
			}
			return parts.join(" - ");
		});

		try {
			// Batch generate embeddings (more efficient)
			// tenantContext is used internally to resolve embedding model and API key
			const result = await generateEmbeddings(texts, tenantContext);

			// Assign embeddings to entries
			for (let i = 0; i < entries.length; i++) {
				entries[i].embedding = result.embeddings[i];
			}

			console.log(
				`[ToolIndex] Generated ${result.embeddings.length} embeddings (${result.totalTokens} tokens)`,
			);
		} catch (error) {
			console.error("[ToolIndex] Failed to generate embeddings:", error);
			// Continue without embeddings - BM25 search will still work
		}
	}

	private cosineSimilarity(a: number[], b: number[]): number {
		if (a.length !== b.length) {
			return 0;
		}

		let dotProduct = 0;
		let normA = 0;
		let normB = 0;

		for (let i = 0; i < a.length; i++) {
			dotProduct += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}

		const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
		return magnitude === 0 ? 0 : dotProduct / magnitude;
	}

	/**
	 * Persist tool entries to Qdrant for semantic vector search
	 */
	private async persistToQdrant(
		entries: ToolIndexEntry[],
		userId: string | null,
		organizationId: string | null,
	): Promise<void> {
		const entriesWithEmbeddings = entries.filter(
			(e): e is ToolIndexEntry & { embedding: number[] } =>
				!!e.embedding && e.embedding.length > 0,
		);

		if (entriesWithEmbeddings.length === 0) {
			console.log("[ToolIndex] No embeddings to persist to Qdrant");
			return;
		}

		// Convert to CapabilityPoint format
		const capabilityPoints: CapabilityPoint[] = entriesWithEmbeddings.map(
			(entry) => ({
				id: entry.id,
				type: "mcp_tool" as const,
				name: entry.toolName,
				description: entry.description,
				embedding: entry.embedding,
				userId,
				organizationId,
				metadata: {
					serverName: entry.serverName,
					configId: entry.configId,
					category: entry.category,
					riskLevel: entry.riskLevel,
					isReadOnly: entry.isReadOnly,
					inputSchema: entry.inputSchema,
					updatedAt: entry.lastUpdated.toISOString(),
				},
			}),
		);

		try {
			const result = await upsertCapabilities(capabilityPoints);
			console.log(
				`[ToolIndex] Persisted ${result.success} capabilities to Qdrant (${result.failed} failed)`,
			);
		} catch (error) {
			console.error("[ToolIndex] Failed to persist to Qdrant:", error);
			// Continue - in-memory index still works
		}
	}
}

// =============================================================================
// Singleton Instance
// =============================================================================

/** Global tool index instance */
export const toolIndex = new ToolIndex();
