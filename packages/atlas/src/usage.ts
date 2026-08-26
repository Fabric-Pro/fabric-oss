/**
 * AI-usage metering for Atlas generations.
 *
 * `logModelUsageAsync` (from `@repo/ai`) writes the usage row AND fires the
 * `@repo/payments` usage-limit recorder hook — per-limit counters and 80% / 100%
 * threshold notifications run automatically after each insert. So every Atlas AI
 * call (module/file describe, business derivation, onboarding tour, chat,
 * on-demand regenerate) now counts toward the workspace's AI usage + limits.
 *
 * This is what the bare `trackUsage()` from `getAIModelWithMetadata` does NOT do
 * — that only stamps the provider's last-used timestamp. Fire-and-forget; never
 * throws (a metering hiccup must never fail an analysis).
 */
import {
	type AIModelMetadata,
	type AIOperationContext,
	logModelUsageAsync,
} from "@repo/ai";
import type { AiTaskType } from "@repo/database/prisma/generated/client";
import type { AtlasContext } from "./types";

interface TokenUsage {
	inputTokens?: number | null;
	outputTokens?: number | null;
	totalTokens?: number | null;
}

export function recordAtlasUsage(args: {
	ctx: AtlasContext;
	metadata: AIModelMetadata | undefined;
	taskType: AiTaskType;
	usage: TokenUsage | undefined;
	/** `Date.now()` captured just before the generation, for latency. */
	startedAt: number;
	projectId?: string;
}): void {
	if (!args.metadata) {
		return;
	}
	const context: AIOperationContext = {
		userId: args.ctx.userId,
		organizationId: args.ctx.organizationId ?? undefined,
	};
	logModelUsageAsync({
		context,
		metadata: args.metadata,
		taskType: args.taskType,
		usage: args.usage ?? {},
		latencyMs: Math.max(0, Date.now() - args.startedAt),
		projectId: args.projectId,
	});
}
