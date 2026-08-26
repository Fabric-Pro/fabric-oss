import type { AIProvider, AiTaskType } from "@repo/database";
import {
	db,
	getModelForTask,
	getProviderDisplayName,
	isGatewayProvider,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AI Configuration Status API
 *
 * Queries actual configured providers from database.
 * Uses user_cloud_provider_config and cloud_provider_config tables.
 *
 * TENANT ISOLATION:
 * - If organizationId is provided: ONLY query cloud_provider_config (org level)
 * - If organizationId is NOT provided: ONLY query user_cloud_provider_config (user level)
 * - Personal and organization configurations are NEVER mixed
 */

interface ConfiguredProvider {
	provider: AIProvider;
	displayName: string | null;
	isDefault: boolean;
	isEmbeddingProvider: boolean;
	source: "user_config" | "org_config";
}

export const getAiConfigStatusProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ORG_AI_CONFIG_READ))
	.route({
		method: "GET",
		path: "/ai-config/status",
		tags: ["AI Config"],
		summary: "Get AI configuration status",
		description:
			"Check if the user has any AI providers configured and ready to use",
	})
	.input(
		z
			.object({
				// organizationId: null = explicit personal context, undefined = use session fallback
				organizationId: z.string().nullable().optional(),
			})
			.optional(),
	)
	.output(
		z.object({
			isConfigured: z.boolean(),
			hasUserConfig: z.boolean(),
			hasOrgConfig: z.boolean(),
			configuredProviders: z.array(
				z.object({
					provider: z.string(),
					displayName: z.string().nullable(),
					isDefault: z.boolean(),
					isEmbeddingProvider: z.boolean(),
					source: z.string(),
				}),
			),
			defaultProvider: z.string().nullable(),
			embeddingProvider: z.string().nullable(),
			// Embedding model details
			embeddingModel: z
				.object({
					displayName: z.string(), // e.g., "Text Embedding 3 Small"
					modelId: z.string(), // e.g., "text-embedding-3-small" or "openai/text-embedding-3-small"
					subProvider: z.string().nullable(), // e.g., "openai" for gateways, null for direct
				})
				.nullable(),
			message: z.string(),
		}),
	)
	.handler(async ({ input, context: { user, session } }) => {
		const organizationId = resolveOrganizationId(
			input?.organizationId,
			session,
		);
		const configuredProviders: ConfiguredProvider[] = [];
		let hasUserConfig = false;
		let hasOrgConfig = false;
		let defaultProvider: AIProvider | null = null;
		let embeddingProvider: AIProvider | null = null;

		// TENANT ISOLATION: Query ONLY the appropriate config based on context
		// Never mix personal and organization configurations
		if (organizationId) {
			// Organization context: ONLY query cloud_provider_config
			const orgProviders = await db.cloudProviderConfig.findMany({
				where: { organizationId, enabled: true },
				orderBy: [{ isDefault: "desc" }, { priority: "desc" }],
			});

			if (orgProviders.length > 0) {
				hasOrgConfig = true;
				for (const p of orgProviders) {
					configuredProviders.push({
						provider: p.provider,
						displayName: p.displayName,
						isDefault: p.isDefault,
						isEmbeddingProvider: p.isEmbeddingProvider,
						source: "org_config",
					});
					if (p.isDefault && !defaultProvider) {
						defaultProvider = p.provider;
					}
					if (p.isEmbeddingProvider && !embeddingProvider) {
						embeddingProvider = p.provider;
					}
				}
			}
		} else {
			// Personal context: ONLY query user_cloud_provider_config
			const userProviders = await db.userCloudProviderConfig.findMany({
				where: { userId: user.id, enabled: true },
				orderBy: [{ isDefault: "desc" }, { priority: "desc" }],
			});

			if (userProviders.length > 0) {
				hasUserConfig = true;
				for (const p of userProviders) {
					configuredProviders.push({
						provider: p.provider,
						displayName: p.displayName,
						isDefault: p.isDefault,
						isEmbeddingProvider: p.isEmbeddingProvider,
						source: "user_config",
					});
					if (p.isDefault && !defaultProvider) {
						defaultProvider = p.provider;
					}
					if (p.isEmbeddingProvider && !embeddingProvider) {
						embeddingProvider = p.provider;
					}
				}
			}
		}

		// If still no default, use first configured
		if (!defaultProvider && configuredProviders.length > 0) {
			defaultProvider = configuredProviders[0].provider;
			configuredProviders[0].isDefault = true;
		}

		const isConfigured = hasUserConfig || hasOrgConfig;

		// Build status message
		let message: string;
		if (!isConfigured) {
			message =
				"No AI provider configured. Please configure at least one provider in settings.";
		} else if (configuredProviders.length === 1) {
			message = `Using ${configuredProviders[0].displayName || getProviderDisplayName(configuredProviders[0].provider)} as AI provider`;
		} else {
			const defaultName = defaultProvider
				? getProviderDisplayName(defaultProvider)
				: "None";
			message = `${configuredProviders.length} AI providers configured. Default: ${defaultName}`;
		}

		// Get embedding model details if embedding provider is configured
		let embeddingModel: {
			displayName: string;
			modelId: string;
			subProvider: string | null;
		} | null = null;

		if (embeddingProvider) {
			try {
				const modelResult = await getModelForTask(
					user.id,
					embeddingProvider,
					"EMBEDDING" as AiTaskType,
					organizationId,
				);

				if (modelResult?.model) {
					const modelId =
						modelResult.providerModelId ||
						modelResult.model.canonicalName;

					// For gateways, extract sub-provider from model ID (e.g., "openai/text-embedding-3-small" -> "openai")
					let subProvider: string | null = null;
					if (
						isGatewayProvider(embeddingProvider) &&
						modelId.includes("/")
					) {
						subProvider = modelId.split("/")[0];
					}

					embeddingModel = {
						displayName:
							modelResult.model.displayName ||
							modelResult.model.canonicalName,
						modelId,
						subProvider,
					};
				}
			} catch (error) {
				// If model resolution fails, just return null for embeddingModel
				console.warn(
					"[AI Config] Failed to resolve embedding model:",
					error,
				);
			}
		}

		return {
			isConfigured,
			hasUserConfig,
			hasOrgConfig,
			configuredProviders,
			defaultProvider,
			embeddingProvider,
			embeddingModel,
			message,
		};
	});
