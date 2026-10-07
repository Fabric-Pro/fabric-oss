import { AIProviderNotConfiguredError, getAIModelWithMetadata } from "@repo/ai";
import { planServesInteractiveWork } from "@repo/ai/lib/chatgpt-plan/pool";

/**
 * The organization's model for CopilotKit's own service adapter, which is
 * built from the provider's raw key and base URL — so never the member's
 * ChatGPT plan. `null` when the organization has no provider of its own but
 * this member's agents run on a plan — their own (Fizzy #2939) or one the
 * organization shares (Fizzy #2770): the route then serves the agents without
 * a provider instead of refusing the request.
 */
export async function resolveCopilotOrgModel(params: {
	userId: string;
	organizationId: string | undefined;
}): Promise<Awaited<ReturnType<typeof getAIModelWithMetadata>> | null> {
	try {
		return await getAIModelWithMetadata(
			{ taskType: "TOOL_CALLING" },
			{ ...params, excludeChatGptPlan: true },
		);
	} catch (error) {
		if (
			error instanceof AIProviderNotConfiguredError &&
			(await planServesInteractiveWork(params))
		) {
			return null;
		}
		throw error;
	}
}
