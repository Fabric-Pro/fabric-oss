import { getAiProviderApiKey, getUserModelPreferences } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const getUserModelPreferencesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_READ))
	.route({
		method: "GET",
		path: "/ai-config/preferences/user",
		tags: ["AI Config"],
		summary: "Get user model preferences",
		description:
			"Get model overrides for the current user's default provider",
	})
	.input(
		z
			.object({
				organizationId: z.string().nullable().optional(),
			})
			.optional(),
	)
	.output(
		z.array(
			z.object({
				id: z.string(),
				provider: z.string(),
				taskType: z.string(),
				customParameters: z.record(z.string(), z.unknown()).nullable(),
				model: z.object({
					id: z.string(),
					canonicalName: z.string(),
					displayName: z.string(),
					family: z.string(),
					vendor: z.string(),
					contextWindow: z.number(),
					speedTier: z.string(),
					qualityTier: z.string(),
				}),
			}),
		),
	)
	.handler(async ({ input, context: { user, session } }) => {
		const organizationId = resolveOrganizationId(
			input?.organizationId,
			session,
		);

		// Get user's default provider
		const providerConfig = await getAiProviderApiKey({
			userId: user.id,
			organizationId,
		});

		if (!providerConfig.provider) {
			return [];
		}

		// Don't filter by provider - return ALL preferences including those
		// saved with override providers (e.g., OPENAI_DIRECT for IMAGE/AUDIO
		// when default provider is AZURE_AI_FOUNDRY)
		const preferences = await getUserModelPreferences(user.id);

		return preferences.map((pref) => ({
			id: pref.id,
			provider: pref.provider,
			taskType: pref.taskType,
			customParameters: pref.customParameters as Record<
				string,
				unknown
			> | null,
			model: {
				id: pref.model.id,
				canonicalName: pref.model.canonicalName,
				displayName: pref.model.displayName,
				family: pref.model.family,
				vendor: pref.model.vendor,
				contextWindow: pref.model.contextWindow,
				speedTier: pref.model.speedTier,
				qualityTier: pref.model.qualityTier,
			},
		}));
	});
