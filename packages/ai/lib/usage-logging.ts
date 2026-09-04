import type { AiTaskType } from "@repo/database/prisma/generated/client";
import type {
	AIModelMetadata,
	AIOperationContext,
} from "./dynamic-model-selector";

interface TokenUsage {
	inputTokens?: number | null;
	outputTokens?: number | null;
	totalTokens?: number | null;
	/** Prompt tokens served from cache (a read) — priced below the input rate. */
	cachedInputTokens?: number | null;
	/** Prompt tokens written into the cache — priced above the input rate (Anthropic). */
	cacheCreationInputTokens?: number | null;
	/** Reasoning/thinking tokens (already folded into outputTokens by most providers). */
	reasoningTokens?: number | null;
}

interface LogModelUsageParams {
	context: AIOperationContext;
	metadata: AIModelMetadata;
	taskType: AiTaskType;
	usage: TokenUsage;
	latencyMs: number;
	projectId?: string;
	agentId?: string;
	conversationId?: string;
	success?: boolean;
	errorMessage?: string;
}

interface LogEmbeddingUsageParams {
	context: AIOperationContext;
	metadata: AIModelMetadata;
	usageTokens: number;
	latencyMs: number;
	projectId?: string;
	agentId?: string;
	conversationId?: string;
	success?: boolean;
	errorMessage?: string;
}

/**
 * Maps a resolved call's billing mode to the `AiUsageBillingCategory` written
 * on its usage row.
 *
 * Two of the four inputs can no longer be produced (Fizzy #1875): the
 * allowance and the Stripe-metered overage are gone, so
 * `getTenantAiGatewayBillingState` now returns only `external_provider` (every
 * user-facing call) and `platform_unbilled` (background and ingestion work,
 * which keeps its own resolver — R13). Their cases stay on purpose, and the
 * mode union stays four-wide with them, for two reasons:
 *
 *  - Rows already written carry `INCLUDED_CREDIT` and `STRIPE_METERED`, and
 *    reporting still groups by them (`getProjectUsageSummary` buckets the full
 *    enum; the project usage view reads those two buckets by name). The
 *    categories are history, not live states.
 *  - The out-of-process agent path round-trips the mode as an opaque string —
 *    `/api/ai/keys/exchange` hands `billingMode` to a runtime, which returns it
 *    to `/api/internal/ai-usage`. Keeping the mapping total means a token
 *    minted before this change cannot land an unclassifiable row.
 *
 * Do not narrow this to the two live modes without also retiring the historical
 * enum members, which KTD3 deliberately keeps.
 */
export function getAiBillingCategory(metadata: AIModelMetadata) {
	switch (metadata.billingMode) {
		case "included_credit":
			return "INCLUDED_CREDIT" as const;
		case "metered_stripe":
			return "STRIPE_METERED" as const;
		case "platform_unbilled":
			return "PLATFORM_UNBILLED" as const;
		default:
			return "EXTERNAL_BYOK" as const;
	}
}

export function logModelUsageAsync(_params: LogModelUsageParams): void {
	// NO-OP — superseded by the global usage interceptor.
	//
	// Every in-process language model is resolved through getAIModelWithMetadata
	// (./dynamic-model-selector.ts), which now wraps it with
	// wrapModelWithUsageLogging so usage — including the full prompt-cache +
	// reasoning token breakdown — is recorded automatically for every generate/
	// stream call. Recording here as well would double-count, so this is
	// intentionally inert: callers (and tests) may keep calling it with no effect.
	// Embeddings still use logEmbeddingUsageAsync below, which is NOT yet
	// intercepted and remains the real logger for that model type.
}

export function logEmbeddingUsageAsync(_params: LogEmbeddingUsageParams): void {
	// NO-OP — superseded by the embedding usage interceptor.
	//
	// Every in-process embedding model is resolved through
	// getAIEmbeddingModelWithMetadata (./dynamic-model-selector.ts), which now
	// wraps it with wrapEmbeddingModelWithUsageLogging so embed usage is recorded
	// automatically. Recording here as well would double-count.
}
