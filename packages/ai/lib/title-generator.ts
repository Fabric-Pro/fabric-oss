import { generateText } from "ai";
import { getAIModelWithMetadata } from "./dynamic-model-selector";
import { promptGenerateChatTitle } from "./prompts";
import { logModelUsageAsync } from "./usage-logging";

/**
 * Context for title generation
 * When provided, uses dynamic model selection based on user/org preferences
 */
export interface TitleGenerationContext {
	userId: string;
	organizationId?: string;
	projectId?: string;
}

/**
 * Generate a concise title for a chat conversation based on the first user message
 *
 * @param {string} firstMessage - The first user message in the conversation
 * @param {TitleGenerationContext} context - Context for dynamic model selection (required)
 * @return {Promise<string>} A concise, descriptive title (3-6 words)
 */
export async function generateChatTitle(
	firstMessage: string,
	context: TitleGenerationContext,
): Promise<string> {
	try {
		// Truncate very long messages to avoid excessive token usage
		const truncatedMessage =
			firstMessage.length > 200
				? `${firstMessage.substring(0, 200)}...`
				: firstMessage;

		// Get model using centralized single entry point
		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{
				userId: context.userId,
				organizationId: context.organizationId,
				// The interceptor inside getAIModelWithMetadata is the only usage
				// recorder now (logModelUsageAsync is a documented no-op), so a
				// projectId that stops here is a usage row filed under no project.
				projectId: context.projectId,
			},
		);

		const generationStart = Date.now();
		const { text, usage } = await generateText({
			model,
			prompt: promptGenerateChatTitle(truncatedMessage),
		});
		trackUsage();
		logModelUsageAsync({
			context: {
				userId: context.userId,
				organizationId: context.organizationId,
			},
			metadata,
			taskType: "SIMPLE",
			usage,
			latencyMs: Date.now() - generationStart,
			projectId: context.projectId,
		});

		// Clean up the response (remove quotes, trim whitespace)
		const cleanTitle = text.replace(/^["']|["']$/g, "").trim();

		// Fallback to truncated message if generation fails or is empty
		if (!cleanTitle) {
			return truncatedMessage.substring(0, 50);
		}

		return cleanTitle;
	} catch (error) {
		// Fallback to truncated first message if AI generation fails
		console.error("Failed to generate chat title:", error);
		return firstMessage.substring(0, 50);
	}
}
