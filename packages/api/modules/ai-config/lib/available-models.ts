import { interactivePlanModel } from "@repo/ai/lib/chatgpt-plan/pool";
import {
	type AiTaskType,
	db,
	getProviderDisplayName,
	SELECTABLE_CATALOG_MODEL_FILTER,
} from "@repo/database";
import {
	getConfiguredProviders,
	PROVIDERS_WITH_SUBPROVIDERS,
} from "./configured-providers";

const PLAN_TEXT_TASKS = new Set([
	"SIMPLE",
	"COMPLEX",
	"REASONING",
	"CHAT",
	"TOOL_CALLING",
	"EVAL",
]);

/** Provider/model discovery after the caller has authorized the target organization. */
export async function listAvailableModels(input: {
	userId: string;
	organizationId?: string;
	sessionOrganizationId?: string;
	taskType?: AiTaskType;
	planTaskType?: AiTaskType;
}) {
	const { organizationId } = input;
	// Only for the session's own organization: the input's organizationId
	// is unverified here, and a plan lookup must never be pointed at an
	// organization the caller does not work in.
	const planTaskType = input.planTaskType ?? input.taskType;
	const chatgptPlan =
		input.sessionOrganizationId &&
		input.sessionOrganizationId === organizationId &&
		(planTaskType === undefined || PLAN_TEXT_TASKS.has(planTaskType))
			? await interactivePlanModel({
					userId: input.userId,
					organizationId: input.sessionOrganizationId,
					taskType: planTaskType ?? "CHAT",
				})
			: null;

	// Get the user's configured providers
	// For explicit general tasks: only the DEFAULT provider's models are returned
	// For specialized tasks (IMAGE, AUDIO, EMBEDDING, DECISION): all capable providers' models are returned
	const {
		allProviders,
		defaultProvider,
		defaultProviderType,
		effectiveProviders,
	} = await getConfiguredProviders(
		input.userId,
		organizationId,
		input.taskType,
	);

	const organizationDefaultProvider = organizationId
		? defaultProviderType
		: null;

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

	// An embeddings-only key (Fizzy #2770 F11) is never the default, yet
	// its embedding models must still list; it serves nothing else.
	const embeddingsOnlyProviders = new Set(
		allProviders
			.filter((provider) => provider.purpose === "EMBEDDINGS_ONLY")
			.map((provider) => provider.provider),
	);
	if (effectiveProviders.length === 0) {
		// No provider configured - return empty
		return {
			configuredProviders: allProviders,
			organizationDefaultProvider,
			defaultProvider: null,
			providerIds: [],
			models: [],
			chatgptPlan,
			modelsByProvider: {},
			modelsByGatewayAndProvider: {},
		};
	}

	// Without a task, include default and specialized providers for settings.
	// Get models from effective providers:
	// - For explicit general tasks: only the DEFAULT provider (prevents routing confusion)
	// - For specialized tasks (IMAGE, AUDIO, EMBEDDING, DECISION): all capable providers
	// biome-ignore lint/suspicious/noImplicitAnyLet: type inferred from Prisma query with include — cannot be statically declared
	let models;
	try {
		models = await db.aiModel.findMany({
			where: {
				...SELECTABLE_CATALOG_MODEL_FILTER,
				providerMappings: {
					some: {
						provider: { in: effectiveProviders },
						isAvailable: true,
					},
				},
				// Filter by task type if provided
				...(input.taskType && {
					suitableForTasks: { has: input.taskType },
				}),
				...(input.taskType === "DECISION" && {
					capabilities: { has: "EVALUATION" as const },
				}),
				// Evaluation models must only be listed on their typed decision
				// surface. The settings UI obtains them in a separate DECISION query.
				...(!input.taskType && {
					NOT: {
						suitableForTasks: { has: "DECISION" },
					},
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
		console.error("[AI Config] Effective providers:", effectiveProviders);
		throw error;
	}

	// What an embeddings-only key may list is its embedding models; an
	// LLM listing must never offer a model only that key would serve.
	models = models
		.map((model) => ({
			...model,
			providerMappings: model.providerMappings.filter(
				(mapping) =>
					!embeddingsOnlyProviders.has(mapping.provider) ||
					model.suitableForTasks.includes("EMBEDDING"),
			),
		}))
		.filter((model) => model.providerMappings.length > 0);

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
			suitableForTasks: string[];
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
				seenModelsPerProvider[mapping.provider].has(model.canonicalName)
			) {
				continue;
			}
			seenModelsPerProvider[mapping.provider].add(model.canonicalName);

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
				suitableForTasks: model.suitableForTasks,
				inputCostPer1M:
					model.inputCostPer1M != null
						? Number(model.inputCostPer1M)
						: null,
				outputCostPer1M:
					model.outputCostPer1M != null
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
						inputCostPer1M: number | null;
						outputCostPer1M: number | null;
						capabilities: string[];
						suitableForTasks: string[];
					}>;
				}
			>;
		}
	> = {};

	// Build structure for ALL effective providers (not just default)
	// This allows the UI to display models from specialized providers (e.g., OpenAI for IMAGE)
	for (const providerKey of effectiveProviders) {
		const isDefault = providerKey === defaultProvider?.provider;
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
					modelsByGatewayAndProvider[providerKey].providers[vendor] =
						{
							providerDisplayName: vendor,
							models: vendorModels.map((m) => ({
								id: m.id,
								canonicalName: m.canonicalName,
								displayName: m.displayName,
								providerModelId: m.providerModelId,
								speedTier: m.speedTier,
								qualityTier: m.qualityTier,
								inputCostPer1M: m.inputCostPer1M,
								outputCostPer1M: m.outputCostPer1M,
								capabilities: m.capabilities,
								suitableForTasks: m.suitableForTasks,
							})),
						};
				}
			}
		} else {
			// For direct providers (OPENAI_DIRECT, ANTHROPIC_DIRECT, etc.),
			// use the provider's own model mappings
			const providerModels = modelsByProvider[providerKey] || [];
			if (providerModels.length > 0) {
				modelsByGatewayAndProvider[providerKey].providers[providerKey] =
					{
						providerDisplayName:
							getProviderDisplayName(providerKey),
						models: providerModels.map((m) => ({
							id: m.id,
							canonicalName: m.canonicalName,
							displayName: m.displayName,
							providerModelId: m.providerModelId,
							speedTier: m.speedTier,
							qualityTier: m.qualityTier,
							inputCostPer1M: m.inputCostPer1M,
							outputCostPer1M: m.outputCostPer1M,
							capabilities: m.capabilities,
							suitableForTasks: m.suitableForTasks,
						})),
					};
			}
		}
	}

	return {
		configuredProviders: allProviders,
		organizationDefaultProvider,
		defaultProvider: defaultProviderType,
		providerIds: effectiveProviders,
		chatgptPlan,
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
			inputCostPer1M:
				model.inputCostPer1M != null
					? Number(model.inputCostPer1M)
					: null,
			outputCostPer1M:
				model.outputCostPer1M != null
					? Number(model.outputCostPer1M)
					: null,
			suitableForTasks: model.suitableForTasks,
			capabilities: model.capabilities,
			providerMappings: model.providerMappings.map((pm) => ({
				provider: pm.provider,
				providerModelId: pm.providerModelId,
				isAvailable: pm.isAvailable,
			})),
		})),
		modelsByProvider,
		modelsByGatewayAndProvider,
	};
}
