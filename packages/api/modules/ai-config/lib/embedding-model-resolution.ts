import { selectModelDynamic } from "@repo/ai/model-selector";
import type { AIProvider } from "@repo/database";

/** Resolve the embedding model through the runtime's provider-specific and fallback paths. */
export async function resolveEmbeddingModel(params: {
	userId: string;
	organizationId?: string | null;
	provider: string | null;
	ignorePreferences?: boolean;
	organizationOnly?: boolean;
}) {
	if (!params.provider) {
		return null;
	}
	try {
		return await selectModelDynamic(
			{
				taskType: "EMBEDDING",
				preferredProvider: params.provider as AIProvider,
				ignorePreferences: params.ignorePreferences ?? true,
			},
			{
				userId: params.userId,
				organizationId: params.organizationId ?? undefined,
				...(params.organizationOnly ? { organizationOnly: true } : {}),
			},
		);
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message.startsWith("[ModelSelector] No model configured") ||
				error.message.startsWith("[ModelSelector] Embedding provider"))
		) {
			return null;
		}
		throw error;
	}
}
