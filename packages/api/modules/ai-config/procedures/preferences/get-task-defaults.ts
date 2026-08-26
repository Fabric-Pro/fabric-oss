import {
	type AIProvider,
	type AiModelCapability,
	type AiTaskType,
	db,
	getAiProviderApiKey,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

// Task type to required capabilities mapping for computing defaults from available models
const TASK_CAPABILITY_MAP: Record<
	AiTaskType,
	{
		requiredCapabilities?: AiModelCapability[];
		preferredCapabilities?: AiModelCapability[];
		excludeCapabilities?: AiModelCapability[];
		preferSpeedTier?: "FAST" | "BALANCED" | "QUALITY";
		preferQualityTier?: "BASIC" | "STANDARD" | "PREMIUM";
	}
> = {
	SIMPLE: {
		excludeCapabilities: ["EMBEDDING", "IMAGE", "AUDIO"],
		preferSpeedTier: "FAST",
	},
	COMPLEX: {
		excludeCapabilities: ["EMBEDDING", "IMAGE", "AUDIO"],
		preferQualityTier: "PREMIUM",
	},
	REASONING: {
		requiredCapabilities: ["REASONING"],
		preferQualityTier: "PREMIUM",
	},
	CHAT: {
		excludeCapabilities: ["EMBEDDING", "IMAGE", "AUDIO"],
		preferredCapabilities: ["TEXT"],
	},
	TOOL_CALLING: {
		requiredCapabilities: ["TOOL_CALLING"],
	},
	EMBEDDING: {
		requiredCapabilities: ["EMBEDDING"],
	},
	IMAGE: {
		requiredCapabilities: ["IMAGE"],
	},
	AUDIO: {
		requiredCapabilities: ["AUDIO"],
	},
	EVAL: {
		requiredCapabilities: ["REASONING"],
		preferQualityTier: "STANDARD",
	},
};

/**
 * Get system default models for each task type, filtered by the user's default provider.
 *
 * Each provider has its own default models for each task type. When the user's default
 * provider is e.g. OPENAI_DIRECT, this returns OpenAI's default models for each task.
 * When the default is ANTHROPIC_DIRECT, it returns Anthropic's defaults, etc.
 */
export const getTaskDefaultsProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ORG_AI_CONFIG_READ))
	.route({
		method: "GET",
		path: "/ai-config/task-defaults",
		tags: ["AI Config"],
		summary: "Get task-to-model defaults",
		description:
			"Get the system default model for each task type based on user's default provider",
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
				taskType: z.string(),
				complexity: z.string(),
				priority: z.number(),
				provider: z.string().nullable(),
				model: z.object({
					id: z.string(),
					canonicalName: z.string(),
					displayName: z.string(),
					family: z.string(),
					vendor: z.string(),
					speedTier: z.string(),
					qualityTier: z.string(),
				}),
			}),
		),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input?.organizationId,
			context.session,
		);

		console.log("[AI Config] getTaskDefaults called for", {
			userId: context.user.id,
			organizationId,
		});

		try {
			// Get the user's/org's default provider
			const providerConfig = await getAiProviderApiKey({
				userId: context.user.id,
				organizationId,
			});

			const defaultProvider =
				providerConfig.provider as AIProvider | null;
			console.log("[AI Config] Default provider:", defaultProvider);

			// Inference-only providers that don't support EMBEDDING/IMAGE/AUDIO
			const INFERENCE_ONLY_PROVIDERS: AIProvider[] = [
				"CEREBRAS" as AIProvider,
				"GROQ" as AIProvider,
				"DEEPSEEK" as AIProvider,
				"TOGETHER_AI" as AIProvider,
			];

			// Specialized task types that need OpenAI fallback
			const SPECIALIZED_TASK_TYPES: AiTaskType[] = [
				"EMBEDDING",
				"IMAGE",
				"AUDIO",
			];

			// Query defaults filtered by the default provider
			// If no default provider, return all defaults (fallback)
			const defaults = await db.aiTaskModelDefault.findMany({
				where: defaultProvider ? { provider: defaultProvider } : {},
				include: {
					model: true,
				},
				orderBy: [
					{ taskType: "asc" },
					{ complexity: "asc" },
					{ priority: "desc" },
				],
			});

			console.log(
				"[AI Config] Found",
				defaults.length,
				"task defaults for provider:",
				defaultProvider,
			);

			// Check if we need to add OpenAI defaults for specialized tasks
			// This happens when the default provider is inference-only (no EMBEDDING/IMAGE/AUDIO support)
			let allDefaults = [...defaults];

			if (
				defaultProvider &&
				INFERENCE_ONLY_PROVIDERS.includes(defaultProvider)
			) {
				// Check which specialized task types are missing
				const existingTaskTypes = new Set(
					defaults.map((d) => d.taskType),
				);
				const missingSpecializedTasks = SPECIALIZED_TASK_TYPES.filter(
					(task) => !existingTaskTypes.has(task as AiTaskType),
				);

				if (missingSpecializedTasks.length > 0) {
					// TENANT ISOLATION: Check OpenAI in the appropriate context
					let hasOpenAI = false;
					if (organizationId) {
						// Organization context: Check cloud_provider_config
						const orgHasOpenAI =
							await db.cloudProviderConfig.findFirst({
								where: {
									organizationId,
									provider: "OPENAI_DIRECT",
									enabled: true,
								},
							});
						hasOpenAI = !!orgHasOpenAI;
					} else {
						// Personal context: Check user_cloud_provider_config
						const userHasOpenAI =
							await db.userCloudProviderConfig.findFirst({
								where: {
									userId: context.user.id,
									provider: "OPENAI_DIRECT",
									enabled: true,
								},
							});
						hasOpenAI = !!userHasOpenAI;
					}

					if (hasOpenAI) {
						// Fetch OpenAI defaults for missing specialized tasks
						const openAIDefaults =
							await db.aiTaskModelDefault.findMany({
								where: {
									provider: "OPENAI_DIRECT",
									taskType: {
										in: missingSpecializedTasks as AiTaskType[],
									},
								},
								include: {
									model: true,
								},
							});

						allDefaults = [...defaults, ...openAIDefaults];
						console.log(
							"[AI Config] Added",
							openAIDefaults.length,
							"OpenAI defaults for specialized tasks:",
							missingSpecializedTasks,
						);
					}
				}
			}

			// If no defaults exist for the provider in the database, compute them from available models
			// This ensures users see sensible defaults even when the seed hasn't been run for a provider
			const ALL_TASK_TYPES: AiTaskType[] = [
				"SIMPLE",
				"COMPLEX",
				"REASONING",
				"CHAT",
				"TOOL_CALLING",
				"EMBEDDING",
				"IMAGE",
				"AUDIO",
				"EVAL",
			];

			const existingTaskTypes = new Set(
				allDefaults.map((d) => d.taskType),
			);
			const missingTaskTypes = ALL_TASK_TYPES.filter(
				(task) => !existingTaskTypes.has(task),
			);

			if (missingTaskTypes.length > 0 && defaultProvider) {
				console.log(
					"[AI Config] Computing defaults for missing task types:",
					missingTaskTypes,
				);

				// Get available models for this provider
				const availableModels = await db.aiModel.findMany({
					where: {
						isActive: true,
						deprecatedAt: null,
						providerMappings: {
							some: {
								provider: defaultProvider,
								isAvailable: true,
							},
						},
					},
					include: {
						providerMappings: {
							where: {
								provider: defaultProvider,
								isAvailable: true,
							},
						},
					},
				});

				// Compute a default for each missing task type
				for (const taskType of missingTaskTypes) {
					const requirements = TASK_CAPABILITY_MAP[taskType];

					// Filter models by capabilities
					const suitableModels = availableModels.filter((model) => {
						// Check required capabilities
						if (requirements.requiredCapabilities) {
							const hasAll =
								requirements.requiredCapabilities.every((cap) =>
									model.capabilities.includes(cap),
								);
							if (!hasAll) {
								return false;
							}
						}

						// Check excluded capabilities
						if (requirements.excludeCapabilities) {
							const hasExcluded =
								requirements.excludeCapabilities.some((cap) =>
									model.capabilities.includes(cap),
								);
							if (hasExcluded) {
								return false;
							}
						}

						return true;
					});

					if (suitableModels.length === 0) {
						console.log(
							`[AI Config] No suitable models for ${taskType} with provider ${defaultProvider}`,
						);
						continue;
					}

					// Sort by preference (speed tier for SIMPLE, quality tier for others)
					const sortedModels = suitableModels.sort((a, b) => {
						const _speedOrder = {
							FAST: 0,
							BALANCED: 1,
							QUALITY: 2,
						};
						const qualityOrder = {
							PREMIUM: 0,
							STANDARD: 1,
							BASIC: 2,
						};

						if (requirements.preferSpeedTier) {
							const aSpeed =
								a.speedTier === requirements.preferSpeedTier
									? 0
									: 1;
							const bSpeed =
								b.speedTier === requirements.preferSpeedTier
									? 0
									: 1;
							if (aSpeed !== bSpeed) {
								return aSpeed - bSpeed;
							}
						}

						if (requirements.preferQualityTier) {
							const aQuality =
								a.qualityTier === requirements.preferQualityTier
									? 0
									: 1;
							const bQuality =
								b.qualityTier === requirements.preferQualityTier
									? 0
									: 1;
							if (aQuality !== bQuality) {
								return aQuality - bQuality;
							}
						}

						// Default: prefer higher quality
						return (
							(qualityOrder[
								a.qualityTier as keyof typeof qualityOrder
							] ?? 2) -
							(qualityOrder[
								b.qualityTier as keyof typeof qualityOrder
							] ?? 2)
						);
					});

					const bestModel = sortedModels[0];
					console.log(
						`[AI Config] Computed default for ${taskType}: ${bestModel.displayName}`,
					);

					// Add computed default (using a mock structure that matches the DB result)
					allDefaults.push({
						id: `computed-${taskType}-${defaultProvider}`,
						taskType: taskType,
						complexity: "MEDIUM" as const,
						priority: 50,
						provider: defaultProvider,
						modelId: bestModel.id,
						requiresToolCalling: taskType === "TOOL_CALLING",
						minContextWindow: null,
						createdAt: new Date(),
						updatedAt: new Date(),
						model: bestModel,
					});
				}
			}

			return allDefaults.map((d) => ({
				taskType: d.taskType,
				complexity: d.complexity,
				priority: d.priority,
				provider: d.provider,
				model: {
					id: d.model.id,
					canonicalName: d.model.canonicalName,
					displayName: d.model.displayName,
					family: d.model.family,
					vendor: d.model.vendor,
					speedTier: d.model.speedTier,
					qualityTier: d.model.qualityTier,
				},
			}));
		} catch (error) {
			console.error("[AI Config] getTaskDefaults error:", error);
			throw error;
		}
	});
