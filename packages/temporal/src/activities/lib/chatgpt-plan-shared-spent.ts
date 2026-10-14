import type { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { chatGptPlanSpentError } from "@repo/ai/lib/chatgpt-plan/plan-spent-response";
import { pickChatGptPlanSource } from "@repo/ai/lib/chatgpt-plan/pool";
import {
	aiApiFallbackApproved,
	currentAiJobType,
} from "@repo/ai/lib/job-context";

/**
 * Whether every shared ChatGPT plan this background run may use is spent right
 * now (Fizzy #2770), for a step whose failure arrives without the plan's own
 * error — an agent run that ended on the gateway's refusal, say. The run's job
 * type comes from the run itself (`runWithAiJobType`).
 *
 * Null when a plan is left, when no plan serves the run, when the run names no
 * job, under an AUTO policy (the retry then runs on the organization's
 * provider), or when the check itself fails: the original error stands.
 */
export async function sharedPlansSpentError(context: {
	userId: string;
	organizationId?: string | null;
}): Promise<SubscriptionPlanExhaustedError | null> {
	const jobType = currentAiJobType();
	// A run approved to bill the organization's provider never waits.
	if (!context.organizationId || !jobType || aiApiFallbackApproved()) {
		return null;
	}
	try {
		const plan = await pickChatGptPlanSource({
			userId: context.userId,
			organizationId: context.organizationId,
			jobType,
		});
		if (!plan || !("exhausted" in plan)) {
			return null;
		}
		if (
			plan.audience === "background" &&
			plan.policy?.apiFallbackBackground === "AUTO"
		) {
			return null;
		}
		return chatGptPlanSpentError(plan);
	} catch {
		return null;
	}
}
