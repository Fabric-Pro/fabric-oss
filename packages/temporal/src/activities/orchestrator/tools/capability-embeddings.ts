/**
 * Capability Embeddings Service
 *
 * Provides semantic search capabilities using embeddings for tool
 * and agent discovery. Pre-computes and caches embeddings for
 * efficient similarity matching.
 *
 * Uses @repo/rag embedding generator which routes through Vercel AI Gateway.
 */

import { logger } from "@repo/logs";
import { generateEmbedding, generateEmbeddings } from "@repo/rag";

// =============================================================================
// Types
// =============================================================================

export interface EmbeddingCacheEntry {
	/** The embedding vector */
	embedding: number[];
	/** When this embedding was computed */
	computedAt: Date;
	/** Model used to generate the embedding */
	model: string;
	/** Token count for the source text */
	tokens?: number;
}

export interface EmbeddingCacheOptions {
	/** TTL for cached embeddings (default: 1 hour) */
	defaultTtlMs?: number;
	/** Maximum cache entries (default: 1000) */
	maxEntries?: number;
}

export interface EmbeddingSearchResult {
	/** ID of the matched item */
	id: string;
	/** Cosine similarity score (0-1) */
	similarity: number;
}

// =============================================================================
// Cosine Similarity
// =============================================================================

/**
 * Calculate cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		throw new Error("Vectors must have the same length");
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
	if (magnitude === 0) {
		return 0;
	}

	return dotProduct / magnitude;
}

// =============================================================================
// Embedding Cache
// =============================================================================

/**
 * In-memory cache for embeddings with TTL support.
 */
export class EmbeddingCache {
	private cache: Map<string, EmbeddingCacheEntry & { expiresAt: number }> =
		new Map();
	private defaultTtlMs: number;
	private maxEntries: number;

	constructor(options: EmbeddingCacheOptions = {}) {
		this.defaultTtlMs = options.defaultTtlMs ?? 60 * 60 * 1000; // 1 hour
		this.maxEntries = options.maxEntries ?? 1000;
	}

	/**
	 * Get an embedding from cache.
	 */
	get(key: string): EmbeddingCacheEntry | null {
		const entry = this.cache.get(key);
		if (!entry) {
			return null;
		}

		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			return null;
		}

		return {
			embedding: entry.embedding,
			computedAt: entry.computedAt,
			model: entry.model,
			tokens: entry.tokens,
		};
	}

	/**
	 * Set an embedding in cache.
	 */
	set(key: string, entry: EmbeddingCacheEntry, ttlMs?: number): void {
		// Evict oldest entries if at capacity
		if (this.cache.size >= this.maxEntries) {
			const oldest = Array.from(this.cache.entries()).sort(
				(a, b) => a[1].expiresAt - b[1].expiresAt,
			)[0];
			if (oldest) {
				this.cache.delete(oldest[0]);
			}
		}

		this.cache.set(key, {
			...entry,
			expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
		});
	}

	/**
	 * Check if a key exists in cache.
	 */
	has(key: string): boolean {
		return this.get(key) !== null;
	}

	/**
	 * Get all cached embeddings (non-expired).
	 */
	getAll(): Map<string, EmbeddingCacheEntry> {
		const now = Date.now();
		const result = new Map<string, EmbeddingCacheEntry>();

		for (const [key, entry] of this.cache) {
			if (now <= entry.expiresAt) {
				result.set(key, {
					embedding: entry.embedding,
					computedAt: entry.computedAt,
					model: entry.model,
					tokens: entry.tokens,
				});
			}
		}

		return result;
	}

	/**
	 * Clear the cache.
	 */
	clear(): void {
		this.cache.clear();
	}

	/**
	 * Get cache statistics.
	 */
	stats(): { size: number; maxEntries: number } {
		return {
			size: this.cache.size,
			maxEntries: this.maxEntries,
		};
	}
}

// =============================================================================
// Singleton Instance
// =============================================================================

export const embeddingCache = new EmbeddingCache();

// =============================================================================
// Embedding Generation Functions
// =============================================================================

/**
 * Get or generate an embedding for a text.
 * Uses cache to avoid redundant embedding generation.
 */
export async function getOrGenerateEmbedding(
	text: string,
	cacheKey: string,
	apiKey: string,
	userId?: string,
	organizationId?: string,
): Promise<number[]> {
	// Check cache first
	const cached = embeddingCache.get(cacheKey);
	if (cached) {
		logger.debug(`[CapabilityEmbeddings] Cache hit for: ${cacheKey}`);
		return cached.embedding;
	}

	// Generate new embedding
	logger.info(`[CapabilityEmbeddings] Generating embedding for: ${cacheKey}`);
	try {
		const result = await generateEmbedding(
			text,
			{
				userId,
				organizationId,
			},
			apiKey,
		);

		// Cache the result
		embeddingCache.set(cacheKey, {
			embedding: result.embedding,
			computedAt: new Date(),
			model: result.model,
			tokens: result.tokens,
		});

		return result.embedding;
	} catch (error) {
		logger.error(
			`[CapabilityEmbeddings] Failed to generate embedding for ${cacheKey}:`,
			error,
		);
		throw error;
	}
}

/**
 * Get or generate embeddings for multiple texts in batch.
 * More efficient than generating individually.
 */
export async function getOrGenerateEmbeddings(
	items: Array<{ text: string; cacheKey: string }>,
	apiKey: string,
	userId?: string,
	organizationId?: string,
): Promise<Map<string, number[]>> {
	const result = new Map<string, number[]>();
	const toGenerate: Array<{ text: string; cacheKey: string; index: number }> =
		[];

	// Check cache for each item
	for (let i = 0; i < items.length; i++) {
		const { text, cacheKey } = items[i];
		const cached = embeddingCache.get(cacheKey);

		if (cached) {
			result.set(cacheKey, cached.embedding);
		} else {
			toGenerate.push({ text, cacheKey, index: i });
		}
	}

	if (toGenerate.length === 0) {
		logger.debug(
			`[CapabilityEmbeddings] All ${items.length} embeddings found in cache`,
		);
		return result;
	}

	// Generate missing embeddings in batch
	logger.info(
		`[CapabilityEmbeddings] Generating ${toGenerate.length} embeddings (${items.length - toGenerate.length} from cache)`,
	);

	try {
		const texts = toGenerate.map((item) => item.text);
		const batchResult = await generateEmbeddings(
			texts,
			{
				userId,
				organizationId,
			},
			apiKey,
		);

		// Cache and add to results
		for (let i = 0; i < toGenerate.length; i++) {
			const { cacheKey } = toGenerate[i];
			const embedding = batchResult.embeddings[i];

			embeddingCache.set(cacheKey, {
				embedding,
				computedAt: new Date(),
				model: batchResult.model,
			});

			result.set(cacheKey, embedding);
		}

		return result;
	} catch (error) {
		logger.error(
			"[CapabilityEmbeddings] Failed to generate batch embeddings:",
			error,
		);
		throw error;
	}
}

// =============================================================================
// Semantic Search Functions
// =============================================================================

/**
 * Find the most similar items to a query using embeddings.
 */
export async function semanticSearch(
	query: string,
	items: Array<{ id: string; text: string }>,
	options: {
		limit?: number;
		minSimilarity?: number;
		userId?: string;
		organizationId?: string;
		apiKey: string;
	},
): Promise<EmbeddingSearchResult[]> {
	const {
		limit = 10,
		minSimilarity = 0.3,
		userId,
		organizationId,
		apiKey,
	} = options;

	if (items.length === 0) {
		return [];
	}

	// Generate query embedding
	const queryEmbedding = await getOrGenerateEmbedding(
		query,
		`query:${query}`,
		apiKey,
		userId,
		organizationId,
	);

	// Generate item embeddings in batch
	const itemEmbeddings = await getOrGenerateEmbeddings(
		items.map((item) => ({
			text: item.text,
			cacheKey: `item:${item.id}`,
		})),
		apiKey,
		userId,
		organizationId,
	);

	// Calculate similarities
	const results: EmbeddingSearchResult[] = [];

	for (const item of items) {
		const embedding = itemEmbeddings.get(`item:${item.id}`);
		if (!embedding) {
			continue;
		}

		const similarity = cosineSimilarity(queryEmbedding, embedding);
		if (similarity >= minSimilarity) {
			results.push({ id: item.id, similarity });
		}
	}

	// Sort by similarity and limit
	return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

/**
 * Find the most similar items to a query using pre-computed embeddings.
 * More efficient when embeddings are already available.
 */
export function semanticSearchPrecomputed(
	queryEmbedding: number[],
	items: Array<{ id: string; embedding: number[] }>,
	options: {
		limit?: number;
		minSimilarity?: number;
	} = {},
): EmbeddingSearchResult[] {
	const { limit = 10, minSimilarity = 0.3 } = options;

	const results: EmbeddingSearchResult[] = [];

	for (const item of items) {
		const similarity = cosineSimilarity(queryEmbedding, item.embedding);
		if (similarity >= minSimilarity) {
			results.push({ id: item.id, similarity });
		}
	}

	return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

// =============================================================================
// Hybrid Search (BM25 + Embedding)
// =============================================================================

/**
 * Combine BM25 keyword scores with embedding similarity scores.
 * Uses weighted average: 40% BM25 + 60% embedding (as per plan).
 */
export function hybridScore(
	bm25Score: number,
	embeddingSimilarity: number,
	options: {
		bm25Weight?: number;
		embeddingWeight?: number;
	} = {},
): number {
	const bm25Weight = options.bm25Weight ?? 0.4;
	const embeddingWeight = options.embeddingWeight ?? 0.6;

	// Normalize BM25 score to 0-1 range (assuming typical BM25 scores are 0-10)
	const normalizedBm25 = Math.min(bm25Score / 10, 1);

	return bm25Weight * normalizedBm25 + embeddingWeight * embeddingSimilarity;
}

/**
 * Combine BM25 and embedding search results.
 */
export function mergeSearchResults(
	bm25Results: Array<{ id: string; score: number }>,
	embeddingResults: EmbeddingSearchResult[],
	options: {
		limit?: number;
		bm25Weight?: number;
		embeddingWeight?: number;
	} = {},
): Array<{ id: string; score: number; bm25Score: number; similarity: number }> {
	const { limit = 10, bm25Weight = 0.4, embeddingWeight = 0.6 } = options;

	// Create lookup maps
	const bm25Map = new Map(bm25Results.map((r) => [r.id, r.score]));
	const embeddingMap = new Map(
		embeddingResults.map((r) => [r.id, r.similarity]),
	);

	// Combine all unique IDs
	const allIds = new Set([
		...bm25Results.map((r) => r.id),
		...embeddingResults.map((r) => r.id),
	]);

	// Calculate hybrid scores
	const results = Array.from(allIds).map((id) => {
		const bm25Score = bm25Map.get(id) ?? 0;
		const similarity = embeddingMap.get(id) ?? 0;
		const score = hybridScore(bm25Score, similarity, {
			bm25Weight,
			embeddingWeight,
		});

		return { id, score, bm25Score, similarity };
	});

	return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
