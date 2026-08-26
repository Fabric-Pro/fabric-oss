import { getActiveModels } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const listModelCatalogProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_READ))
	.route({
		method: "GET",
		path: "/ai-config/models",
		tags: ["AI Config"],
		summary: "List AI models from catalog",
		description: "Get all available AI models with their provider mappings",
	})
	.input(
		z.object({
			family: z.string().optional(),
			capabilities: z
				.array(
					z.enum([
						"TEXT",
						"IMAGE",
						"AUDIO",
						"EMBEDDING",
						"TOOL_CALLING",
						"VISION",
						"CODE",
						"REASONING",
					]),
				)
				.optional(),
			speedTier: z.enum(["FAST", "BALANCED", "QUALITY"]).optional(),
			qualityTier: z.enum(["BASIC", "STANDARD", "PREMIUM"]).optional(),
			limit: z.number().min(1).max(100).optional(),
		}),
	)
	.output(
		z.array(
			z.object({
				id: z.string(),
				canonicalName: z.string(),
				displayName: z.string(),
				description: z.string().nullable(),
				family: z.string(),
				vendor: z.string(),
				capabilities: z.array(z.string()),
				contextWindow: z.number(),
				maxOutputTokens: z.number().nullable(),
				speedTier: z.string(),
				qualityTier: z.string(),
				inputCostPer1M: z.number().nullable(),
				outputCostPer1M: z.number().nullable(),
				suitableForTasks: z.array(z.string()),
				providerMappings: z.array(
					z.object({
						id: z.string(),
						provider: z.string(),
						providerModelId: z.string(),
						isAvailable: z.boolean(),
						inputCostPer1M: z.number().nullable(),
						outputCostPer1M: z.number().nullable(),
					}),
				),
			}),
		),
	)
	.handler(async ({ input }) => {
		console.log("[AI Config] listModelCatalog called with input:", input);
		try {
			const models = await getActiveModels({
				family: input?.family,
				capabilities: input?.capabilities as
					| (
							| "TEXT"
							| "IMAGE"
							| "AUDIO"
							| "EMBEDDING"
							| "TOOL_CALLING"
							| "VISION"
							| "CODE"
							| "REASONING"
					  )[]
					| undefined,
				speedTier: input?.speedTier,
				qualityTier: input?.qualityTier,
				limit: input?.limit,
			});
			console.log("[AI Config] Found", models.length, "models");

			return models.map((model) => ({
				id: model.id,
				canonicalName: model.canonicalName,
				displayName: model.displayName,
				description: model.description,
				family: model.family,
				vendor: model.vendor,
				capabilities: model.capabilities,
				contextWindow: model.contextWindow,
				maxOutputTokens: model.maxOutputTokens,
				speedTier: model.speedTier,
				qualityTier: model.qualityTier,
				inputCostPer1M: model.inputCostPer1M,
				outputCostPer1M: model.outputCostPer1M,
				suitableForTasks: model.suitableForTasks,
				providerMappings: model.providerMappings.map((pm) => ({
					id: pm.id,
					provider: pm.provider,
					providerModelId: pm.providerModelId,
					isAvailable: pm.isAvailable,
					inputCostPer1M: pm.inputCostPer1M,
					outputCostPer1M: pm.outputCostPer1M,
				})),
			}));
		} catch (error) {
			console.error("[AI Config] listModelCatalog error:", error);
			throw error;
		}
	});
