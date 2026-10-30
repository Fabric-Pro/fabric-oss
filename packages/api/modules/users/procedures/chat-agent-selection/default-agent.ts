import {
	type AiTaskType,
	db,
	type PersistedSelectedAgent,
	SELECTABLE_CATALOG_MODEL_FILTER,
} from "@repo/database";
import { DEFAULT_FABRIC_AI_MODEL } from "@repo/database/prisma/ai-model-catalog";
import { getConfiguredProviders } from "../../../ai-config/lib/configured-providers";

/**
 * The agent a user gets when they have no stored preference (#2040 § Scope,
 * per the 5/8 DSU): the platform's default Fabric AI model. Expressed as a
 * canonical model name so it resolves through the same `model:`-prefixed
 * pseudo-agent path the picker already uses.
 */
const DEFAULT_CHAT_AGENT_MODEL = DEFAULT_FABRIC_AI_MODEL;

/**
 * Resolve the default agent for a tenant, or null if they cannot run it.
 *
 * Resolved on the server rather than in the picker for two reasons. The picker
 * fetches no catalog data until the user opens it, so a client-side check
 * would force a model-catalog request on every chat mount — including the
 * floating launcher, which mounts on every page. And availability is a
 * tenant-provider question, which is already answered here.
 *
 * Returning null is the important case, not an edge case: the default names an
 * Anthropic model, and an organization with only (say) OpenAI credentials
 * cannot run it. Preselecting it there would hand every such user a chip that
 * immediately fails the availability check — a "default" nobody can use. Null
 * means "no chip", and the backend resolves the organization's own configured
 * chat model exactly as it does today.
 */
export async function resolveDefaultChatAgent(
	userId: string,
	organizationId: string | null,
): Promise<PersistedSelectedAgent | null> {
	try {
		const { defaultProviderType } = await getConfiguredProviders(
			userId,
			organizationId ?? undefined,
			"CHAT",
		);

		if (!defaultProviderType) {
			return null;
		}

		// Match against the DEFAULT provider, the one general chat runs on at
		// send time. For an explicit general task like CHAT,
		// `effectiveProviders` is that provider alone too (Fizzy #3400).
		const model = await db.aiModel.findFirst({
			where: {
				canonicalName: DEFAULT_CHAT_AGENT_MODEL,
				...SELECTABLE_CATALOG_MODEL_FILTER,
				suitableForTasks: { has: "CHAT" as AiTaskType },
				providerMappings: {
					some: {
						provider: defaultProviderType,
						isAvailable: true,
					},
				},
			},
			select: { canonicalName: true, displayName: true, vendor: true },
		});

		if (!model) {
			return null;
		}

		return {
			agentId: `model:${model.canonicalName}`,
			name: model.displayName,
			vendor: model.vendor,
			modelOverride: model.canonicalName,
		};
	} catch (error) {
		// A default is a convenience, never a reason to fail the read that
		// carries the user's actual saved selection.
		console.error(
			"[ChatAgentSelection] Failed to resolve the default agent:",
			error,
		);
		return null;
	}
}
