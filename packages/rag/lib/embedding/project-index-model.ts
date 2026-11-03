/**
 * The embedding model a project's index is compared against by the chunking
 * health check (spec 2026-10-28 §8d).
 *
 * Project sources do not record the model each was embedded with, so the
 * project records one name for its whole index
 * (`ProjectRagSettings.indexEmbeddingModel`) and the check compares it with
 * the organization's current model.
 *
 * Metadata only: the same resolver the embedding calls use, organization
 * level (`organizationOnly`), so the answer does not depend on which member
 * is acting and the background sweep resolves the same name a request would.
 * No model instance is created and no key is decrypted.
 */

import { hasProviderCredentials, resolveModelWithProvider } from "@repo/ai";
import { LOCAL_MODEL_SELECTION_SOURCE } from "@repo/ai/local-models";

/**
 * The canonical name of the organization's current embedding model, or null
 * when none resolves (no provider configured, or the lookup failed): the
 * check then cannot say the model changed.
 */
export async function resolveProjectIndexEmbeddingModel(params: {
	organizationId: string;
	/** Any user for the resolver's context; ignored under organizationOnly. */
	userId: string;
}): Promise<string | null> {
	if (!params.organizationId) {
		return null;
	}
	try {
		const config = await resolveModelWithProvider("EMBEDDING", {
			userId: params.userId,
			organizationId: params.organizationId,
			organizationOnly: true,
		});
		if (!config.modelString) {
			return null;
		}
		// A local development server is named by its model; it needs no key.
		if (config.selectionSource === LOCAL_MODEL_SELECTION_SOURCE) {
			return config.canonicalName || config.modelString;
		}
		if (!hasProviderCredentials(config)) {
			return null;
		}
		return config.canonicalName || config.modelString;
	} catch {
		return null;
	}
}
