import {
	db,
	getAiProviderApiKey,
	getEmbeddingProviderConfig,
} from "@repo/database";

/**
 * Whether the tenant has any provider a saved model preference can apply to:
 * any enabled organization provider, or the personal default/documents provider.
 * Saved specialized choices can still run without an organization default.
 */
export async function hasAnyAiProvider(params: {
	userId: string;
	organizationId?: string | null;
}): Promise<boolean> {
	if (params.organizationId) {
		const rows = await db.cloudProviderConfig.findMany({
			where: { organizationId: params.organizationId, enabled: true },
			select: { id: true },
			take: 1,
		});
		return rows.length > 0;
	}
	const [llm, embedding] = await Promise.all([
		getAiProviderApiKey(params),
		getEmbeddingProviderConfig(params),
	]);
	return Boolean(llm.provider || embedding.provider);
}
