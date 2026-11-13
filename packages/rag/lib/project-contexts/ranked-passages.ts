import { getProjectRagSettings } from "@repo/database";
import { logger } from "@repo/logs";
import { rethrowIfDispatchStopped } from "@repo/utils/dispatch-guard";
import {
	createReranker,
	getRerankerConfig,
	isCrossEncoderAvailable,
} from "../reranking";
import {
	DEFAULT_RERANK_CONFIG,
	type RerankerProviderType,
} from "../reranking/types";
import { chunkPool, DEFAULT_CHUNK_OVERLAP, rankedPool } from "./ranked-pool";
import {
	type ProjectContextRetrievalOptions,
	type RetrievedContext,
	retrieveProjectContexts,
} from "./retrieval";

const POOL_SIZE = 50;
const KEEP_CHUNKS = 20;

type FallbackReason =
	| "RANKED_PASSAGES_DISABLED"
	| "RANKED_PASSAGES_NO_PROVIDER"
	| "RANKED_PASSAGES_UNAVAILABLE"
	| "RANKED_PASSAGES_INVALID_SCORES"
	| "RANKED_PASSAGES_TIMEOUT";

class RerankFallback extends Error {
	constructor(readonly reason: FallbackReason) {
		super(reason);
	}
}

/** Retrieve and render the ranked chunk sample used for story drafting. */
export async function retrieveRankedPassages(
	options: ProjectContextRetrievalOptions,
): Promise<string> {
	const contexts = await retrieveProjectContexts({
		...options,
		topK: POOL_SIZE,
		diversify: true,
		maxContexts: POOL_SIZE,
		skipRerank: true,
		includeMatchedPassages: true,
	});
	const { chunks } = chunkPool(contexts, POOL_SIZE);
	if (!chunks.length) {
		return rankedPool(contexts, [], KEEP_CHUNKS).context;
	}

	let maxOverlap = DEFAULT_CHUNK_OVERLAP;
	let ranked = chunks.map((chunk) => ({
		...chunk,
		rerankedScore: chunk.score,
	}));
	const deadline = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// Bound configuration and availability checks too, not just the provider call.
		ranked = await Promise.race([
			(async () => {
				const settings = await getProjectRagSettings(options.projectId);
				deadline.signal.throwIfAborted();
				maxOverlap = settings.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
				if (!settings.enableReranking) {
					throw new RerankFallback("RANKED_PASSAGES_DISABLED");
				}
				const tenant = {
					userId: options.userId,
					organizationId: options.organizationId,
					projectId: options.projectId,
				};
				const config = await getRerankerConfig(
					settings.rerankerProvider as RerankerProviderType,
					undefined,
					tenant,
				);
				deadline.signal.throwIfAborted();
				if (!config.provider) {
					throw new RerankFallback("RANKED_PASSAGES_NO_PROVIDER");
				}
				if (
					config.provider === "cross-encoder" &&
					!isCrossEncoderAvailable()
				) {
					throw new RerankFallback("RANKED_PASSAGES_UNAVAILABLE");
				}
				const reranker = createReranker(config);
				const available = await reranker.isAvailable();
				deadline.signal.throwIfAborted();
				if (!available) {
					throw new RerankFallback("RANKED_PASSAGES_UNAVAILABLE");
				}
				const sources = new Map(
					contexts.map((source) => [source.id, source]),
				);
				const results = await reranker.rerank({
					query: options.query,
					documents: chunks.map((chunk) => ({
						...(sources.get(chunk.sourceId) as RetrievedContext),
						id: chunk.id,
						content: chunk.content,
						score: chunk.score,
					})),
					topK: chunks.length,
					minRelevanceScore: 0,
				});
				if (!Array.isArray(results)) {
					throw new RerankFallback("RANKED_PASSAGES_INVALID_SCORES");
				}
				const scores = new Map(
					results.map((result) => [
						result.document.id,
						result.relevanceScore,
					]),
				);
				return chunks.map((chunk) => {
					const score = scores.get(chunk.id);
					if (!Number.isFinite(score)) {
						throw new RerankFallback(
							"RANKED_PASSAGES_INVALID_SCORES",
						);
					}
					return { ...chunk, rerankedScore: score as number };
				});
			})(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					deadline.abort(
						new RerankFallback("RANKED_PASSAGES_TIMEOUT"),
					);
					reject(deadline.signal.reason);
				}, DEFAULT_RERANK_CONFIG.timeout);
			}),
		]);
	} catch (error) {
		// A stopped chat turn is cancellation, not a reranking failure.
		rethrowIfDispatchStopped(error);
		logger.warn("[RankedPassages] Using retrieval scores", {
			reason:
				error instanceof RerankFallback
					? error.reason
					: "RANKED_PASSAGES_FAILED",
		});
	} finally {
		clearTimeout(timer);
	}
	return rankedPool(contexts, ranked, KEEP_CHUNKS, maxOverlap).context;
}
