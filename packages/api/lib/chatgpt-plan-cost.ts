/**
 * What a member's ChatGPT plan usage would have cost on API billing — an
 * estimate for the usage analytics (Fizzy #2939). Plan rows really cost the
 * organization nothing and keep a stored cost of 0; this only prices their
 * tokens at the catalog price of the OpenAI API model each plan model is
 * compared with.
 */
import { chatGptPlanApiPriceReference } from "@repo/ai/lib/chatgpt-plan/models";
import {
	type ChatGptPlanModelUsage,
	estimateAiUsageCostUsd,
} from "@repo/database";

export interface ChatGptPlanApiCostEstimate {
	estimatedApiCostMicroUsd: number;
	/** The API models the plan models were priced as. */
	referenceModels: string[];
}

export async function estimateChatGptPlanApiCost(
	usageByModel: ChatGptPlanModelUsage[],
): Promise<ChatGptPlanApiCostEstimate> {
	const references = new Set<string>();
	let costUsd = 0;
	for (const usage of usageByModel) {
		const reference = chatGptPlanApiPriceReference(usage.providerModelId);
		references.add(reference);
		costUsd += await estimateAiUsageCostUsd({
			provider: "OPENAI_DIRECT",
			providerModelId: reference,
			modelCanonicalName: reference,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cachedInputTokens: usage.cachedInputTokens,
		});
	}
	return {
		estimatedApiCostMicroUsd: Math.round(costUsd * 1_000_000),
		referenceModels: [...references].sort(),
	};
}
