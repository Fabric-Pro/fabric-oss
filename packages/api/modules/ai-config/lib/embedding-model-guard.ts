import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import {
	embeddingModelFitsVectorStore,
	VECTOR_STORE_DIMENSIONS,
} from "@repo/rag/lib/embedding/dimensions";

/**
 * Refuses an embeddings model whose vectors the document index cannot hold:
 * every write and search against it would fail (Fizzy #2770).
 */
export function assertEmbeddingModelFitsVectorStore(
	taskType: string,
	model: { canonicalName: string; displayName: string },
): void {
	if (
		taskType !== "EMBEDDING" ||
		embeddingModelFitsVectorStore(model.canonicalName)
	) {
		return;
	}
	throw new ORPCError("BAD_REQUEST", {
		message: `${model.displayName} produces vectors the document index cannot store. Choose a model with ${VECTOR_STORE_DIMENSIONS}-dimension vectors.`,
	});
}

/**
 * The same check for a documents provider about to take over: the embeddings
 * model already chosen for that provider must fit too.
 */
export async function assertEmbeddingPreferenceFitsVectorStore(params: {
	organizationId: string | null | undefined;
	userId: string;
	provider: string;
}): Promise<void> {
	const where = {
		taskType: "EMBEDDING" as const,
		provider: params.provider as never,
	};
	const preference = params.organizationId
		? await db.organizationModelPreference.findFirst({
				where: { ...where, organizationId: params.organizationId },
				select: {
					model: {
						select: { canonicalName: true, displayName: true },
					},
				},
			})
		: await db.userModelPreference.findFirst({
				where: { ...where, userId: params.userId },
				select: {
					model: {
						select: { canonicalName: true, displayName: true },
					},
				},
			});
	if (preference?.model) {
		assertEmbeddingModelFitsVectorStore("EMBEDDING", preference.model);
	}
}
