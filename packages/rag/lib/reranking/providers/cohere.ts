/**
 * Cohere Reranker Provider
 *
 * Uses Cohere's rerank API for high-quality document reranking.
 * Cohere's rerank model is trained specifically for retrieval tasks
 * and provides excellent relevance scoring.
 *
 * Pricing: ~$0.001 per search (1000 documents)
 * Latency: 200-500ms typically
 *
 * @see https://docs.cohere.com/reference/rerank
 */

import { logger } from "@repo/logs";
import type {
	RerankerConfig,
	RerankerProvider,
	RerankerProviderType,
	RerankOptions,
	RerankResult,
} from "../types";
import { DEFAULT_RERANK_CONFIG, RERANKER_MODELS } from "../types";

/**
 * Cohere API rerank response structure
 */
interface CohereRerankResponse {
	id: string;
	results: Array<{
		index: number;
		relevance_score: number;
	}>;
	meta?: {
		api_version?: { version: string };
		billed_units?: { search_units: number };
	};
}

/**
 * Cohere API error response
 */
interface CohereErrorResponse {
	message: string;
	status_code?: number;
}

/**
 * Cohere Reranker Provider implementation
 */
export class CohereRerankerProvider implements RerankerProvider {
	readonly providerType: RerankerProviderType = "cohere";

	private readonly apiKey: string;
	private readonly model: string;
	private readonly timeout: number;
	private readonly baseUrl = "https://api.cohere.ai/v2";

	constructor(config: RerankerConfig) {
		if (!config.apiKey) {
			throw new Error(
				"Cohere API key is required for CohereRerankerProvider",
			);
		}

		this.apiKey = config.apiKey;
		this.model = config.model || RERANKER_MODELS.cohere.default;
		this.timeout = config.timeout || DEFAULT_RERANK_CONFIG.timeout;
	}

	/**
	 * Rerank documents using Cohere's rerank API
	 */
	async rerank(options: RerankOptions): Promise<RerankResult[]> {
		const {
			query,
			documents,
			topK = DEFAULT_RERANK_CONFIG.topK,
			minRelevanceScore = DEFAULT_RERANK_CONFIG.minRelevanceScore,
		} = options;

		if (documents.length === 0) {
			return [];
		}

		// Cohere has a limit of 1000 documents per request
		if (documents.length > 1000) {
			logger.warn(
				`[CohereReranker] Input exceeds 1000 documents (${documents.length}), truncating`,
			);
		}

		const documentsToRerank = documents.slice(0, 1000);

		const startTime = Date.now();

		try {
			const response = await fetch(`${this.baseUrl}/rerank`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					model: this.model,
					query,
					documents: documentsToRerank.map((doc) => doc.content),
					top_n: Math.min(topK, documentsToRerank.length),
					return_documents: false,
				}),
				signal: AbortSignal.timeout(this.timeout),
			});

			if (!response.ok) {
				const errorBody =
					(await response.json()) as CohereErrorResponse;
				throw new Error(
					`Cohere API error: ${errorBody.message || response.statusText}`,
				);
			}

			const result = (await response.json()) as CohereRerankResponse;

			const latencyMs = Date.now() - startTime;
			logger.info(
				`[CohereReranker] Reranked ${documentsToRerank.length} docs in ${latencyMs}ms`,
			);

			// Map results back to documents with scores
			const rerankedResults: RerankResult[] = result.results
				.filter((r) => r.relevance_score >= minRelevanceScore)
				.map((r) => ({
					document: documentsToRerank[r.index],
					relevanceScore: r.relevance_score,
					originalIndex: r.index,
				}))
				.sort((a, b) => b.relevanceScore - a.relevanceScore)
				.slice(0, topK);

			return rerankedResults;
		} catch (error) {
			if (error instanceof Error && error.name === "TimeoutError") {
				logger.error(
					`[CohereReranker] Request timed out after ${this.timeout}ms`,
				);
				throw new Error("Cohere rerank request timed out");
			}

			logger.error(`[CohereReranker] Rerank failed: ${error}`);
			throw error;
		}
	}

	/**
	 * Check if the Cohere API is available
	 */
	async isAvailable(): Promise<boolean> {
		try {
			// Simple API check - Cohere doesn't have a dedicated health endpoint
			// but we can verify the API key works with a minimal request
			const response = await fetch(`${this.baseUrl}/models`, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					Accept: "application/json",
				},
				signal: AbortSignal.timeout(5000),
			});

			return response.ok;
		} catch {
			return false;
		}
	}
}

/**
 * Factory function to create a Cohere reranker
 */
export function createCohereReranker(
	config: Partial<RerankerConfig> = {},
): CohereRerankerProvider {
	return new CohereRerankerProvider({
		provider: "cohere",
		...config,
	} as RerankerConfig);
}
