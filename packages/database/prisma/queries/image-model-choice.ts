import { db } from "../client";
import {
	IMAGE_RUNTIME_PROVIDERS,
	LATEST_IMAGE_MODEL_PREFERENCE_ORDER_BY,
} from "./image-model-preference-selection";
import { resolveModel } from "./model-resolution";

export interface ImageModelChoice {
	provider: (typeof IMAGE_RUNTIME_PROVIDERS)[number];
	providerModelId: string;
}

/**
 * Resolve the organization's one runnable IMAGE choice, or the Vercel task
 * default when the organization has no saved choice.
 */
export async function resolveImageModelChoice(input: {
	userId: string;
	organizationId?: string;
}): Promise<ImageModelChoice> {
	const preference = input.organizationId
		? await db.organizationModelPreference.findFirst({
				where: {
					organizationId: input.organizationId,
					taskType: "IMAGE",
					provider: { in: [...IMAGE_RUNTIME_PROVIDERS] },
					modelId: { not: null },
				},
				orderBy: [...LATEST_IMAGE_MODEL_PREFERENCE_ORDER_BY],
				select: { provider: true },
			})
		: null;
	const provider = IMAGE_RUNTIME_PROVIDERS.some(
		(candidate) => candidate === preference?.provider,
	)
		? (preference?.provider as ImageModelChoice["provider"])
		: "VERCEL_GATEWAY";
	const resolved = await resolveModel({
		userId: input.userId,
		organizationId: input.organizationId,
		taskType: "IMAGE",
		provider,
	});

	return { provider, providerModelId: resolved.providerModelId };
}
