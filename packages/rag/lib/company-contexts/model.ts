/**
 * The embedding model company context is written and searched with
 * (Fizzy #2719).
 *
 * Every company point records the identity of the model that produced it, and
 * a source counts as ready only while it matches the organization's current
 * model: vectors from another model live in a different embedding space and
 * cannot be searched with this one's queries. Ingestion stamps the identity on
 * the points and the source row; retrieval filters on it.
 *
 * The company collection has the fixed vector size every collection has
 * (`VECTOR_SIZE`). A model producing any other size cannot be written there,
 * so ingestion refuses it up front rather than failing on the upsert, and
 * retrieval skips company search under it.
 */

import {
	AIProviderNotConfiguredError,
	hasProviderCredentials,
	resolveModelWithProvider,
} from "@repo/ai";
import { getEmbeddingDimensions } from "../embedding/generator";
import { VECTOR_SIZE } from "../vector-store/client";
import {
	COMPANY_EMBEDDING_RESOLUTION,
	companyEmbeddingIdentity,
} from "./resolution";

export {
	COMPANY_EMBEDDING_RESOLUTION,
	companyEmbeddingIdentity,
} from "./resolution";

export interface CompanyEmbeddingModel {
	/** `${provider}:${modelString}` of the organization's resolved EMBEDDING model. */
	identity: string;
	/** What the model produces, from the embedding generator's model table. */
	dimensions: number;
	/** Whether `dimensions` matches the collections' fixed `VECTOR_SIZE`. */
	supported: boolean;
}

/**
 * The start of the reason a company source records when the organization's
 * embedding model cannot be written to the company collection. Exported so
 * a surface that shows the reason can recognize it.
 */
export const UNSUPPORTED_EMBEDDING_MODEL_REASON = "Unsupported embedding model";

/**
 * Resolve the organization's current embedding model for company context.
 *
 * Metadata only: it goes through the same resolver the embedding calls use
 * (`resolveModelWithProvider("EMBEDDING")`, which prefers the organization's
 * dedicated embedding provider), but creates no model instance, decrypts no
 * key and consumes no usage allowance.
 *
 * Organization-level only (`organizationOnly`): an acting member's personal
 * provider never decides the model, so every member resolves the same
 * identity and a source one admin embedded is ready, and searchable, for
 * all. Every company embedding call passes the same flag
 * (`COMPANY_EMBEDDING_RESOLUTION`), so the vectors are the identity's model.
 *
 * Throws `AIProviderNotConfiguredError` when no embedding provider resolves:
 * there is then no model to name, and nothing could be embedded either.
 */
export async function resolveCompanyEmbeddingModel(params: {
	organizationId: string;
	/** The acting user, for the resolver's user-then-organization lookup. */
	userId: string;
}): Promise<CompanyEmbeddingModel> {
	const { organizationId, userId } = params;
	if (!organizationId) {
		throw new Error(
			"resolveCompanyEmbeddingModel requires an organizationId",
		);
	}

	const config = await resolveModelWithProvider("EMBEDDING", {
		userId,
		organizationId,
		...COMPANY_EMBEDDING_RESOLUTION,
	});
	if (!config.modelString || !hasProviderCredentials(config)) {
		throw new AIProviderNotConfiguredError(
			config._error ||
				"No embedding provider configured. Please configure an AI provider with embedding support in Settings → AI Providers.",
		);
	}

	const dimensions = getEmbeddingDimensions(config.modelString);
	return {
		identity: companyEmbeddingIdentity(config),
		dimensions,
		supported: dimensions === VECTOR_SIZE,
	};
}

/** The reason recorded on a company source its model cannot index. */
export function unsupportedEmbeddingModelMessage(
	model: CompanyEmbeddingModel,
): string {
	return `${UNSUPPORTED_EMBEDDING_MODEL_REASON}: ${model.identity} produces ${model.dimensions}-dimension vectors, and company context stores ${VECTOR_SIZE}-dimension vectors. Choose a ${VECTOR_SIZE}-dimension embedding model in Settings → AI Models.`;
}
