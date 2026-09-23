import { db, readProviderRowCredentials } from "@repo/database";
import { logger } from "@repo/logs";

/**
 * True when an AI model resolves for this organization, so a roadmap
 * recommendation run can generate (Fizzy #2208).
 *
 * Mirrors the organization rung of the generator's tenant resolver
 * (`getAiProviderApiKey` behind `getAIModelWithMetadata`): the organization's
 * default, enabled provider with a credential the resolver can use, judged by
 * the same `readProviderRowCredentials` rule. That resolver's last rung, the
 * caller's own personal key, is left out because this answer describes the
 * organization, not whoever is looking at the page.
 *
 * Runs on every project read, so it is one indexed lookup and never throws: a
 * failure reads as unavailable. A null organization is the fail-closed default
 * (ADR 018), never a personal context.
 */
export async function isRoadmapRecommendationProviderAvailable(args: {
	projectId: string;
	organizationId: string | null;
}): Promise<boolean> {
	if (!args.organizationId) {
		return false;
	}
	try {
		const config = await db.cloudProviderConfig.findFirst({
			where: {
				organizationId: args.organizationId,
				isDefault: true,
				enabled: true,
			},
			select: {
				encryptedApiKey: true,
				clientId: true,
				encryptedClientSecret: true,
				config: true,
			},
		});
		return config
			? readProviderRowCredentials(config).hasCredentials
			: false;
	} catch (error) {
		logger.warn(
			"[RoadmapRecommendation] Provider availability check failed",
			{
				projectId: args.projectId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return false;
	}
}
