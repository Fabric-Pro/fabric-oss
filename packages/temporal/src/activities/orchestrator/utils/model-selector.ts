/**
 * Model Selector Utility
 *
 * Provides intelligent AI model selection based on task requirements.
 * Uses the centralized getAIModel from @repo/ai.
 */

import type { AiJobKey } from "@repo/ai";
import { getAIModelWithMetadata, getRAGProviderConfig } from "@repo/ai";

/**
 * Embedding provider configuration for RAG
 */
export interface EmbeddingProviderConfig {
	apiKey: string;
	provider?: string;
	baseUrl?: string;
}

/**
 * Get the appropriate AI model using centralized model selection.
 *
 * Uses user/org preferences from the database, with fallback to system defaults.
 * Automatically detects the user's configured AI provider and selects
 * the appropriate provider mapping for the model.
 *
 * @param userId - User ID for API key resolution
 * @param organizationId - Optional organization ID
 * @param hasTools - Whether this request will use tool calling
 */
export async function getAiModel(
	userId: string,
	organizationId?: string,
	hasTools = false,
	modelOverride?: string,
	jobType?: AiJobKey,
) {
	// Determine the task type based on whether tools are needed
	const taskType = hasTools ? "TOOL_CALLING" : "COMPLEX";

	// Use centralized single entry point. The orchestrator is a chat surface
	// too — a message sent from Fabric AI in orchestrator mode generates here
	// (Fizzy #2230).
	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{
			taskType,
			complexity: "medium",
			requiresToolCalling: hasTools,
			modelOverride,
		},
		{ userId, organizationId, featureKey: "chat-agent", jobType },
	);

	console.log(
		`[Orchestrator] Dynamic model selected: ${metadata.modelString} (source: ${metadata.selectionSource}, provider: ${metadata.provider})`,
	);

	// Track usage (fire-and-forget)
	trackUsage();

	return model;
}

/**
 * Get the appropriate AI model along with provider and modelString metadata.
 *
 * Same as getAiModel but returns the full selection so callers can record
 * which provider/model string was actually used (e.g. for stream diagnostics).
 *
 * @param userId - User ID for API key resolution
 * @param organizationId - Optional organization ID
 * @param hasTools - Whether this request will use tool calling
 * @param modelOverride - Optional model override
 */
export async function getAiModelWithSelection(
	userId: string,
	organizationId?: string,
	hasTools = false,
	modelOverride?: string,
	jobType?: AiJobKey,
) {
	const taskType = hasTools ? "TOOL_CALLING" : "COMPLEX";

	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{
			taskType,
			complexity: "medium",
			requiresToolCalling: hasTools,
			modelOverride,
		},
		{ userId, organizationId, featureKey: "chat-agent", jobType },
	);

	console.log(
		`[Orchestrator] Dynamic model selected: ${metadata.modelString} (source: ${metadata.selectionSource}, provider: ${metadata.provider})`,
	);

	trackUsage();

	return {
		model,
		provider: metadata.provider,
		modelString: metadata.modelString,
	};
}

/**
 * Get embedding provider configuration for RAG operations.
 *
 * Returns the user's configured AI provider API key. Note that the actual
 * provider used for embeddings may differ (e.g., OpenAI for embeddings even
 * when user's default is Cerebras) - this is handled by the embedding generator.
 *
 * @param userId - User ID for API key resolution
 * @param organizationId - Optional organization ID
 * @returns Embedding provider configuration
 */
export async function getEmbeddingConfig(
	userId: string,
	organizationId?: string,
): Promise<EmbeddingProviderConfig> {
	try {
		// Use centralized RAG provider config
		const config = await getRAGProviderConfig({ userId, organizationId });

		return {
			apiKey: config.apiKey,
			provider: config.provider ?? undefined,
			baseUrl: config.baseUrl ?? undefined,
		};
	} catch (error) {
		console.error("[ModelSelector] Failed to get embedding config:", error);
		throw new Error(
			"No AI provider configured for embeddings. Please configure an AI provider in Settings > AI Providers.",
		);
	}
}
