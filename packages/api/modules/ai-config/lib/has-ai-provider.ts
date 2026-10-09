import {
	getAiProviderApiKey,
	getEmbeddingProviderConfig,
} from "@repo/database";

/**
 * Whether the tenant has any provider a saved model preference can apply to:
 * a default LLM provider, or a documents provider. An embeddings-only key is
 * never the default, so the default alone would hide its EMBEDDING choice.
 */
export async function hasAnyAiProvider(params: {
	userId: string;
	organizationId?: string | null;
}): Promise<boolean> {
	const [llm, embedding] = await Promise.all([
		getAiProviderApiKey(params),
		getEmbeddingProviderConfig(params),
	]);
	return Boolean(llm.provider || embedding.provider);
}
