/**
 * How company context resolves its embedding model (Fizzy #2719).
 *
 * Kept apart from `./model` so the embed path can import it without loading
 * the model resolver.
 */

/**
 * What every company embedding call adds to its tenant context
 * (`generateEmbedding(s)`, `embedCompanyContext`) and what
 * `resolveCompanyEmbeddingModel` resolves with: the organization's own
 * embedding configuration, never an acting member's personal provider. Company
 * vectors are written by one member and searched by all, so the model must not
 * depend on who is acting.
 */
export const COMPANY_EMBEDDING_RESOLUTION = {
	organizationOnly: true,
} as const;

/**
 * The identity company context records for an embedding model:
 * `${provider}:${modelString}`, as resolved for an embedding call.
 *
 * One definition for the identity `resolveCompanyEmbeddingModel` names and
 * the one an embed stamps from the model its call actually used, so the two
 * compare equal whenever they name the same model.
 */
export function companyEmbeddingIdentity(model: {
	provider?: string | null;
	modelString?: string | null;
}): string {
	if (!model.provider || !model.modelString) {
		throw new Error(
			"A company embedding identity requires the model's provider and model string",
		);
	}
	return `${model.provider}:${model.modelString}`;
}
