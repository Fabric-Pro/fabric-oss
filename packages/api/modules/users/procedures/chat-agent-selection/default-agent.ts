import {
	type AiTaskType,
	db,
	type PersistedSelectedAgent,
} from "@repo/database";
import { getConfiguredProviders } from "../../../ai-config/lib/configured-providers";

/**
 * The agent a user gets when they have no stored preference (#2040 § Scope,
 * per the 5/8 DSU). Expressed as a canonical model name so it resolves through
 * the same `model:`-prefixed pseudo-agent path the picker already uses.
 */
const DEFAULT_CHAT_AGENT_MODEL = "claude-sonnet-5";

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

		// Match against the DEFAULT provider only, not the wider
		// `effectiveProviders` set.
		//
		// For a general task like CHAT, `effectiveProviders` is the default
		// provider PLUS any configured provider that happens to support image,
		// audio or embedding work — a set assembled so one request can feed
		// several pickers and the client can filter. General chat itself only
		// ever runs on the default provider, so the wider set can pass for a
		// model the picker does not list and the send path would not use.
		//
		// No environment checked is currently configured that way, so this
		// changes no outcome today; it is the check that matches how the model
		// is actually resolved at send time.
		const model = await db.aiModel.findFirst({
			where: {
				canonicalName: DEFAULT_CHAT_AGENT_MODEL,
				isActive: true,
				deprecatedAt: null,
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
