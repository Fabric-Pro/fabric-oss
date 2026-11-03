import { AI_CALL_PURPOSES } from "@repo/ai/lib/call-purpose";
import { assertGatewayRerankUsageLimits } from "@repo/ai/lib/gateway-rerank-limits";
import { logAiUsageAsync } from "@repo/database";
import { logger } from "@repo/logs";
import {
	guardDispatch,
	rethrowIfDispatchStopped,
	throwIfDispatchStopped,
} from "@repo/utils/dispatch-guard";
import { createGateway, rerank } from "ai";
import type {
	RerankerConfig,
	RerankerProvider,
	RerankOptions,
	RerankResult,
} from "../types";
import { DEFAULT_RERANK_CONFIG, RERANKER_MODELS } from "../types";

export class GatewayRerankerProvider implements RerankerProvider {
	readonly providerType = "gateway";
	private readonly model: string;

	constructor(private readonly config: RerankerConfig) {
		if (!config.apiKey) {
			throw new Error("Gateway reranker requires a credential");
		}
		this.model = config.model || RERANKER_MODELS.gateway.default;
	}

	async rerank({
		query,
		documents,
		topK = DEFAULT_RERANK_CONFIG.topK,
		minRelevanceScore = DEFAULT_RERANK_CONFIG.minRelevanceScore,
	}: RerankOptions): Promise<RerankResult[]> {
		if (!documents.length) {
			return [];
		}
		const start = Date.now();
		const timeout = this.config.timeout ?? DEFAULT_RERANK_CONFIG.timeout;
		const timeoutSignal = AbortSignal.timeout(timeout);
		const abortSignal = await guardDispatch(timeoutSignal);
		throwIfDispatchStopped();
		// Limit refusals retain their identity and do not enter the SDK sanitizer.
		const modelCanonicalName = await assertGatewayRerankUsageLimits({
			...this.config.tenant,
			providerConfigId: this.config.providerConfigId,
			providerModelId: this.model,
		});
		// The turn can stop while the limit gate awaits its database reads.
		throwIfDispatchStopped();
		try {
			const model = createGateway({
				apiKey: this.config.apiKey,
			}).rerankingModel(this.model);
			const result = await rerank({
				model,
				query,
				documents: documents.map((document) => document.content),
				topN: Math.min(topK, documents.length),
				abortSignal,
				// Retries also need a fresh dispatch check; keep one guarded send.
				maxRetries: 0,
			});
			try {
				const generationId =
					result.providerMetadata?.gateway?.generationId;
				logAiUsageAsync({
					...this.config.tenant,
					organizationId:
						this.config.tenant?.organizationId ?? undefined,
					provider: "VERCEL_GATEWAY",
					providerModelId: this.model,
					modelCanonicalName: modelCanonicalName ?? undefined,
					providerConfigId: this.config.providerConfigId,
					taskType: "EMBEDDING",
					callPurpose: AI_CALL_PURPOSES.projectRetrievalRerank,
					inputTokens: 0,
					outputTokens: 0,
					totalTokens: 0,
					gatewayGenerationId:
						typeof generationId === "string"
							? generationId
							: undefined,
					latencyMs: Date.now() - start,
					success: true,
				});
			} catch {
				logger.warn("[GatewayReranker] Usage logging failed");
			}
			return result.ranking
				.filter((entry) => entry.score >= minRelevanceScore)
				.map((entry) => ({
					document: documents[entry.originalIndex],
					relevanceScore: entry.score,
					originalIndex: entry.originalIndex,
				}))
				.sort((a, b) => b.relevanceScore - a.relevanceScore)
				.slice(0, topK);
		} catch (error) {
			rethrowIfDispatchStopped(error);
			// SDK messages, causes, bodies and headers can contain credentials.
			const failure =
				error && typeof error === "object"
					? (error as {
							name?: unknown;
							statusCode?: unknown;
							type?: unknown;
						})
					: {};
			const fields = {
				name:
					typeof failure.name === "string" ? failure.name : undefined,
				statusCode:
					typeof failure.statusCode === "number" &&
					Number.isFinite(failure.statusCode)
						? failure.statusCode
						: undefined,
				type:
					typeof failure.type === "string" ? failure.type : undefined,
			};
			const timedOut =
				timeoutSignal.aborted ||
				fields.name === "TimeoutError" ||
				fields.name === "GatewayTimeoutError" ||
				fields.type === "timeout_error";
			throw new Error(
				`${timedOut ? `Gateway rerank request timed out after ${timeout}ms` : "Gateway rerank request failed"} ${JSON.stringify(fields)}`,
			);
		}
	}

	async isAvailable(): Promise<boolean> {
		return !!this.config.apiKey;
	}
}
