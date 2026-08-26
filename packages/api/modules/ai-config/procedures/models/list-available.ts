/**
 * List Available Models for User
 *
 * Returns models available through the user's configured AI providers.
 *
 * Behavior varies by task type:
 * - GENERAL tasks (CHAT, TOOL_CALLING, etc.): Only DEFAULT provider's models
 *   This prevents routing confusion between multiple providers.
 * - SPECIALIZED tasks (IMAGE, AUDIO, EMBEDDING): ALL capable configured providers
 *   This allows users to use OpenAI for images even when default is Azure/Anthropic.
 *
 * Flow:
 * 1. Query configured providers from user_cloud_provider_config or cloud_provider_config
 * 2. Find the DEFAULT provider
 * 3. For specialized tasks: find all configured providers that support the capability
 * 4. Query models from effective providers
 * 5. Return models grouped by vendor (for UI organization)
 */

import type { AiTaskType } from "@repo/database";
import { db, getProviderDisplayName } from "@repo/database";

// Task types that require specialized providers (not all providers support these)
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	getConfiguredProviders,
	PROVIDERS_WITH_SUBPROVIDERS,
} from "../../lib/configured-providers";

// Gateway providers can have sub-providers configured (e.g., Vercel Gateway -> Groq, OpenAI)
// Cloud platforms like Azure/AWS/GCP are treated as direct providers in the database
export const listAvailableModelsProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ORG_AI_CONFIG_READ))
	.route({
		method: "GET",
		path: "/ai-config/models/available",
		tags: ["AI Config"],
		summary: "List available AI models for user",
		description:
			"Get AI models available through the user's configured gateways and their enabled providers",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			taskType: z.string().optional(),
		}),
	)
	.output(
		z.object({
			// Configured gateways with their enabled providers
			configuredProviders: z.array(
				z.object({
					id: z.string(),
					provider: z.string(),
					displayName: z.string().nullable(),
					isDefault: z.boolean(),
					priority: z.number(),
					enabledProviders: z.array(z.string()),
					source: z.string(),
				}),
			),
			// Default gateway/provider
			defaultProvider: z.string().nullable(),
			// All enabled provider IDs (for filtering models)
			providerIds: z.array(z.string()),
			// Models list
			models: z.array(
				z.object({
					id: z.string(),
					canonicalName: z.string(),
					displayName: z.string(),
					description: z.string().nullable(),
					family: z.string(),
					vendor: z.string(),
					contextWindow: z.number(),
					speedTier: z.string(),
					qualityTier: z.string(),
					suitableForTasks: z.array(z.string()),
					providerMappings: z.array(
						z.object({
							provider: z.string(),
							providerModelId: z.string(),
							isAvailable: z.boolean(),
						}),
					),
				}),
			),
			// Grouped by provider for UI
			modelsByProvider: z.record(
				z.string(),
				z.array(
					z.object({
						id: z.string(),
						canonicalName: z.string(),
						displayName: z.string(),
						providerModelId: z.string(),
						speedTier: z.string(),
						qualityTier: z.string(),
						// Extended data for hover submenu
						description: z.string().nullable().optional(),
						family: z.string().optional(),
						vendor: z.string().optional(),
						contextWindow: z.number().optional(),
						capabilities: z.array(z.string()).optional(),
						inputCostPer1M: z.number().nullable().optional(),
						outputCostPer1M: z.number().nullable().optional(),
					}),
				),
			),
			// Hierarchical: Gateway → Provider → Models (for route selection UI)
			modelsByGatewayAndProvider: z.record(
				z.string(), // Gateway provider (e.g., VERCEL_GATEWAY, OPENAI_DIRECT)
				z.object({
					gatewayDisplayName: z.string(),
					isDefault: z.boolean(),
					providers: z.record(
						z.string(), // Sub-provider (e.g., GROQ, OPENAI_DIRECT)
						z.object({
							providerDisplayName: z.string(),
							models: z.array(
								z.object({
									id: z.string(),
									canonicalName: z.string(),
									displayName: z.string(),
									providerModelId: z.string(),
									speedTier: z.string(),
									qualityTier: z.string(),
									capabilities: z
										.array(z.string())
										.optional(),
								}),
							),
						}),
					),
				}),
			),
		}),
	)
	.handler(async ({ context: { user, session }, input }) => {
		console.log(
			"[AI Config] listAvailableModels called for user:",
			user.id,
		);

		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Get the user's configured providers
		// For general tasks: only the DEFAULT provider's models are returned
		// For specialized tasks (IMAGE, AUDIO, EMBEDDING): all capable providers' models are returned
		const {
			allProviders,
			defaultProvider,
			defaultProviderType,
			effectiveProviders,
		} = await getConfiguredProviders(
			user.id,
			organizationId,
			input.taskType,
		);

		console.log(
			"[AI Config] All configured providers:",
			allProviders.map((g) => g.provider),
		);
		console.log("[AI Config] Default provider:", defaultProviderType);
		console.log(
			"[AI Config] Effective providers (for model query):",
			effectiveProviders,
			input.taskType ? `(taskType: ${input.taskType})` : "(general)",
		);

		if (!defaultProvider || effectiveProviders.length === 0) {
			// No default provider configured - return empty
			return {
				configuredProviders: allProviders,
				defaultProvider: null,
				providerIds: [],
				models: [],
				modelsByProvider: {},
				modelsByGatewayAndProvider: {},
			};
		}

		// Get models from effective providers:
		// - For general tasks: only the DEFAULT provider (prevents routing confusion)
		// - For specialized tasks (IMAGE, AUDIO, EMBEDDING): all capable providers
		// biome-ignore lint/suspicious/noImplicitAnyLet: type inferred from Prisma query with include — cannot be statically declared
		let models;
		try {
			models = await db.aiModel.findMany({
				where: {
					isActive: true,
					deprecatedAt: null,
					providerMappings: {
						some: {
							provider: { in: effectiveProviders },
							isAvailable: true,
						},
					},
					// Filter by task type if provided
					...(input.taskType && {
						suitableForTasks: { has: input.taskType as AiTaskType },
					}),
				},
				include: {
					providerMappings: {
						where: {
							provider: { in: effectiveProviders },
							isAvailable: true,
						},
					},
				},
				orderBy: [{ qualityTier: "desc" }, { displayName: "asc" }],
			});
		} catch (error) {
			console.error("[AI Config] Error querying models:", error);
			console.error(
				"[AI Config] Effective providers:",
				effectiveProviders,
			);
			throw error;
		}

		console.log(
			"[AI Config] Found",
			models.length,
			"available models from",
			effectiveProviders.length,
			"provider(s)",
		);

		// Group models by provider with extended data for hover submenu
		const modelsByProvider: Record<
			string,
			Array<{
				id: string;
				canonicalName: string;
				displayName: string;
				providerModelId: string;
				speedTier: string;
				qualityTier: string;
				description: string | null;
				family: string;
				vendor: string;
				contextWindow: number;
				capabilities: string[];
				inputCostPer1M: number | null;
				outputCostPer1M: number | null;
			}>
		> = {};

		// Track seen models per provider to prevent duplicates
		const seenModelsPerProvider: Record<string, Set<string>> = {};

		for (const model of models) {
			for (const mapping of model.providerMappings) {
				if (!modelsByProvider[mapping.provider]) {
					modelsByProvider[mapping.provider] = [];
					seenModelsPerProvider[mapping.provider] = new Set();
				}

				// Skip if we've already added this model for this provider
				if (
					seenModelsPerProvider[mapping.provider].has(
						model.canonicalName,
					)
				) {
					continue;
				}
				seenModelsPerProvider[mapping.provider].add(
					model.canonicalName,
				);

				modelsByProvider[mapping.provider].push({
					id: model.id,
					canonicalName: model.canonicalName,
					displayName: model.displayName,
					providerModelId: mapping.providerModelId,
					speedTier: model.speedTier,
					qualityTier: model.qualityTier,
					// Extended data for hover submenu
					description: model.description,
					family: model.family,
					vendor: model.vendor,
					contextWindow: model.contextWindow,
					capabilities: model.capabilities,
					inputCostPer1M: model.inputCostPer1M
						? Number(model.inputCostPer1M)
						: null,
					outputCostPer1M: model.outputCostPer1M
						? Number(model.outputCostPer1M)
						: null,
				});
			}
		}

		// Build hierarchical structure: Provider → Vendor → Models
		// Build for ALL effective providers so UI can show models from specialized providers
		const modelsByGatewayAndProvider: Record<
			string,
			{
				gatewayDisplayName: string;
				isDefault: boolean;
				providers: Record<
					string,
					{
						providerDisplayName: string;
						models: Array<{
							id: string;
							canonicalName: string;
							displayName: string;
							providerModelId: string;
							speedTier: string;
							qualityTier: string;
							capabilities: string[];
						}>;
					}
				>;
			}
		> = {};

		// Build structure for ALL effective providers (not just default)
		// This allows the UI to display models from specialized providers (e.g., OpenAI for IMAGE)
		for (const providerKey of effectiveProviders) {
			const isDefault = providerKey === defaultProvider.provider;
			const isProviderWithSubProviders =
				PROVIDERS_WITH_SUBPROVIDERS.has(providerKey);

			// Find the configured provider info for display name
			const configuredProvider = allProviders.find(
				(p) => p.provider === providerKey,
			);

			modelsByGatewayAndProvider[providerKey] = {
				gatewayDisplayName:
					configuredProvider?.displayName ||
					getProviderDisplayName(providerKey),
				isDefault,
				providers: {},
			};

			if (isProviderWithSubProviders) {
				// For gateway/cloud providers (Vercel, OpenRouter, Azure, etc.), use the provider's own model mappings
				// and group by vendor (Anthropic, OpenAI, etc.)
				const gatewayModels = modelsByProvider[providerKey] || [];

				// Group by vendor with deduplication
				const modelsByVendor: Record<string, typeof gatewayModels> = {};
				const seenModelsPerVendor: Record<string, Set<string>> = {};

				for (const model of gatewayModels) {
					const vendor = model.vendor || "Other";
					if (!modelsByVendor[vendor]) {
						modelsByVendor[vendor] = [];
						seenModelsPerVendor[vendor] = new Set();
					}

					// Skip if we've already added this model for this vendor
					if (seenModelsPerVendor[vendor].has(model.canonicalName)) {
						continue;
					}
					seenModelsPerVendor[vendor].add(model.canonicalName);

					modelsByVendor[vendor].push(model);
				}

				// Add each vendor as a "provider" under this gateway
				for (const [vendor, vendorModels] of Object.entries(
					modelsByVendor,
				)) {
					if (vendorModels.length > 0) {
						modelsByGatewayAndProvider[providerKey].providers[
							vendor
						] = {
							providerDisplayName: vendor,
							models: vendorModels.map((m) => ({
								id: m.id,
								canonicalName: m.canonicalName,
								displayName: m.displayName,
								providerModelId: m.providerModelId,
								speedTier: m.speedTier,
								qualityTier: m.qualityTier,
								capabilities: m.capabilities,
							})),
						};
					}
				}
			} else {
				// For direct providers (OPENAI_DIRECT, ANTHROPIC_DIRECT, etc.),
				// use the provider's own model mappings
				const providerModels = modelsByProvider[providerKey] || [];
				if (providerModels.length > 0) {
					modelsByGatewayAndProvider[providerKey].providers[
						providerKey
					] = {
						providerDisplayName:
							getProviderDisplayName(providerKey),
						models: providerModels.map((m) => ({
							id: m.id,
							canonicalName: m.canonicalName,
							displayName: m.displayName,
							providerModelId: m.providerModelId,
							speedTier: m.speedTier,
							qualityTier: m.qualityTier,
							capabilities: m.capabilities,
						})),
					};
				}
			}
		}

		return {
			configuredProviders: allProviders,
			defaultProvider: defaultProviderType,
			providerIds: effectiveProviders,
			models: models.map((model) => ({
				id: model.id,
				canonicalName: model.canonicalName,
				displayName: model.displayName,
				description: model.description,
				family: model.family,
				vendor: model.vendor,
				contextWindow: model.contextWindow,
				speedTier: model.speedTier,
				qualityTier: model.qualityTier,
				suitableForTasks: model.suitableForTasks,
				providerMappings: model.providerMappings.map((pm) => ({
					provider: pm.provider,
					providerModelId: pm.providerModelId,
					isAvailable: pm.isAvailable,
				})),
			})),
			modelsByProvider,
			modelsByGatewayAndProvider,
		};
	});
