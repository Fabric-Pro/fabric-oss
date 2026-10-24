import { ORPCError } from "@orpc/server";
import {
	type AIProvider,
	type AiModelCapability,
	type AiTaskType,
	db,
	getAiProviderApiKey,
	getAiProviderApiKeyByProvider,
	getEmbeddingProviderConfig,
	getOrganizationDefaultProvider,
	getSystemAiProviderApiKey,
	getTaskDefaultModel,
	LLM_PROVIDER_PURPOSE_FILTER,
	type Prisma,
	readTaskDefaultsSnapshot,
	TEXT_TASK_TYPES,
} from "@repo/database";
import { AiTaskTypeSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { resolveEmbeddingModel } from "../../lib/embedding-model-resolution";
import { resolveOrganizationEmbedding } from "../../lib/organization-embedding-resolution";

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
	DECISION: {
		requiredCapabilities: ["EVALUATION"],
		preferQualityTier: "STANDARD",
	},
};

interface TaskDefaultRow {
	taskType: string;
	complexity: string;
	priority: number;
	provider: string | null;
	model: {
		id: string;
		canonicalName: string;
		displayName: string;
		family: string;
		vendor: string;
		speedTier: string;
		qualityTier: string;
		inputCostPer1M?: Prisma.Decimal | number | null;
		outputCostPer1M?: Prisma.Decimal | number | null;
		suitableForTasks?: string[];
		capabilities?: string[];
	};
}

function toTaskDefaultOutput(d: TaskDefaultRow) {
	return {
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
			inputCostPer1M:
				d.model.inputCostPer1M != null
					? Number(d.model.inputCostPer1M)
					: null,
			outputCostPer1M:
				d.model.outputCostPer1M != null
					? Number(d.model.outputCostPer1M)
					: null,
			suitableForTasks: d.model.suitableForTasks,
			capabilities: d.model.capabilities,
		},
	};
}

/**
 * The tenant's enabled API providers that may serve LLM work. A ChatGPT plan
 * is never a provider row, and an embeddings-only key is excluded.
 */
async function getConfiguredLlmProviders(
	userId: string,
	organizationId: string | null | undefined,
): Promise<AIProvider[]> {
	const where = { enabled: true, ...LLM_PROVIDER_PURPOSE_FILTER };
	const rows = organizationId
		? await db.cloudProviderConfig.findMany({
				where: { organizationId, ...where },
				select: { provider: true },
			})
		: await db.userCloudProviderConfig.findMany({
				where: { userId, ...where },
				select: { provider: true },
			});
	return rows
		.map((row) => row.provider)
		.filter((provider) => provider !== "OPENAI_CHATGPT_PLAN");
}

/**
 * Get text defaults for the selected API provider and embedding defaults from
 * runtime provider routing, including the documents provider when configured.
 */
export const getTaskDefaultsProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ORG_AI_CONFIG_READ))
	.route({
		method: "GET",
		path: "/ai-config/task-defaults",
		tags: ["AI Config"],
		summary: "Get task-to-model defaults",
		description:
			"Get task defaults using the selected text provider and runtime embedding routing",
	})
	.input(
		z
			.object({
				organizationId: z.string().nullable().optional(),
				provider: z.string().optional(),
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
					inputCostPer1M: z.number().nullable().optional(),
					outputCostPer1M: z.number().nullable().optional(),
					suitableForTasks: z.array(z.string()).optional(),
					capabilities: z.array(z.string()).optional(),
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
			// A preview may request only an enabled API provider in this tenant.
			const requestedProvider = organizationId
				? input?.provider
				: undefined;
			if (requestedProvider !== undefined) {
				const configured = await getConfiguredLlmProviders(
					context.user.id,
					organizationId,
				);
				if (!configured.includes(requestedProvider as AIProvider)) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Choose an enabled API provider configured for this organization.",
					});
				}
			}
			const defaultProvider = (requestedProvider ??
				(organizationId
					? await getOrganizationDefaultProvider(organizationId)
					: (
							await getAiProviderApiKey({
								userId: context.user.id,
								organizationId,
							})
						).provider)) as AIProvider | null;
			const providerConfig = defaultProvider
				? await getAiProviderApiKeyByProvider({
						userId: context.user.id,
						organizationId,
						provider: defaultProvider,
					})
				: null;
			const organizationEmbedding = organizationId
				? await resolveOrganizationEmbedding({
						organizationId,
						userId: context.user.id,
						ignorePreferences: true,
					})
				: null;
			const embeddingProvider = organizationId
				? (organizationEmbedding?.provider ?? null)
				: ((
						await getEmbeddingProviderConfig({
							organizationId,
							userId: context.user.id,
						})
					).provider ??
					(
						await getSystemAiProviderApiKey({
							organizationId,
							userId: context.user.id,
						})
					).provider);
			console.log("[AI Config] Default provider:", defaultProvider);

			// Inference-only providers that don't support EMBEDDING/IMAGE/AUDIO
			const INFERENCE_ONLY_PROVIDERS: AIProvider[] = [
				"CEREBRAS" as AIProvider,
				"GROQ" as AIProvider,
				"DEEPSEEK" as AIProvider,
				"TOGETHER_AI" as AIProvider,
			];

			// Specialized task types that need OpenAI fallback
			const SPECIALIZED_TASK_TYPES: AiTaskType[] = organizationId
				? ["EMBEDDING", "AUDIO"]
				: ["EMBEDDING", "IMAGE", "AUDIO"];

			// Organization text defaults require the explicit organization default.
			// Personal context keeps its existing configured-provider fallback.
			const configuredProviders =
				organizationId && !defaultProvider
					? []
					: defaultProvider
						? null
						: await getConfiguredLlmProviders(
								context.user.id,
								organizationId,
							);

			const defaults = await db.aiTaskModelDefault.findMany({
				where: defaultProvider
					? { provider: defaultProvider }
					: { provider: { in: configuredProviders ?? [] } },
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
			// This happens when the default provider is inference-only (no specialized-task support)
			let allDefaults = [...defaults];
			const snapshot = readTaskDefaultsSnapshot(
				providerConfig?.taskDefaultsSnapshot,
				providerConfig?.configId,
			);
			if (defaultProvider && snapshot) {
				for (const taskType of TEXT_TASK_TYPES) {
					const model = await getTaskDefaultModel(
						taskType,
						"MEDIUM",
						defaultProvider,
						providerConfig ?? undefined,
					);
					const existing = allDefaults.find(
						(row) =>
							row.taskType === taskType &&
							row.complexity === "MEDIUM",
					);
					const existingIndex = allDefaults.findIndex(
						(row) => row.taskType === taskType,
					);
					allDefaults = allDefaults.filter(
						(row) => row.taskType !== taskType,
					);
					if (model) {
						// The base query orders by the Postgres enum, not the task name.
						const enumIndex =
							AiTaskTypeSchema.options.indexOf(taskType);
						const nextIndex = allDefaults.findIndex(
							(row) =>
								AiTaskTypeSchema.options.indexOf(row.taskType) >
								enumIndex,
						);
						const insertAt =
							existingIndex >= 0
								? existingIndex
								: nextIndex >= 0
									? nextIndex
									: allDefaults.length;
						allDefaults.splice(
							insertAt,
							0,
							existing
								? { ...existing, modelId: model.id, model }
								: {
										taskType,
										complexity: "MEDIUM",
										priority: 100,
										provider: defaultProvider,
										id: `snapshot-${taskType}`,
										modelId: model.id,
										requiresToolCalling:
											taskType === "TOOL_CALLING",
										minContextWindow: null,
										createdAt: new Date(),
										updatedAt: new Date(),
										model,
									},
						);
					}
				}
			}

			// Embeddings resolve independently of the provider requested for text defaults.
			allDefaults = allDefaults.filter(
				(row) => row.taskType !== "EMBEDDING",
			);
			if (embeddingProvider) {
				const resolved = organizationId
					? organizationEmbedding?.model
						? { modelId: organizationEmbedding.model.id }
						: null
					: await resolveEmbeddingModel({
							organizationId,
							userId: context.user.id,
							provider: embeddingProvider,
							ignorePreferences: true,
							organizationOnly: !!organizationId,
						});
				const model = resolved
					? await db.aiModel.findUnique({
							where: { id: resolved.modelId },
						})
					: null;
				if (model) {
					allDefaults.push({
						id: "resolved-embedding",
						taskType: "EMBEDDING",
						complexity: "MEDIUM",
						priority: 100,
						provider: embeddingProvider as AIProvider,
						modelId: model.id,
						requiresToolCalling: false,
						minContextWindow: null,
						createdAt: new Date(),
						updatedAt: new Date(),
						model,
					});
				}
			}

			// The gateway image path reads this preference on Vercel AI Gateway;
			// other image paths do not. Decision defaults stay on the gateway;
			// Databricks decisions require an explicit organization choice.
			// Do not present another provider's defaults for these tasks.
			if (organizationId) {
				allDefaults = allDefaults.filter(
					(d) =>
						!["IMAGE", "DECISION"].includes(d.taskType) ||
						d.provider === "VERCEL_GATEWAY",
				);
			}
			if (organizationId && defaultProvider !== "VERCEL_GATEWAY") {
				const gatewayConfig = await getAiProviderApiKeyByProvider({
					userId: context.user.id,
					organizationId,
					provider: "VERCEL_GATEWAY",
				});
				if (
					gatewayConfig.provider === "VERCEL_GATEWAY" &&
					gatewayConfig.source === "organization" &&
					gatewayConfig.apiKey
				) {
					const gatewayDefaults =
						await db.aiTaskModelDefault.findMany({
							where: {
								provider: "VERCEL_GATEWAY",
								taskType: {
									in: ["DECISION", "IMAGE"] as AiTaskType[],
								},
							},
							include: { model: true },
						});
					allDefaults = [...allDefaults, ...gatewayDefaults];
				}
			}

			if (
				defaultProvider &&
				INFERENCE_ONLY_PROVIDERS.includes(defaultProvider)
			) {
				// Check which specialized task types are missing
				const existingTaskTypes = new Set(
					defaults.map((d) => d.taskType),
				);
				const missingSpecializedTasks = SPECIALIZED_TASK_TYPES.filter(
					(task) =>
						!existingTaskTypes.has(task as AiTaskType) &&
						task !== "EMBEDDING",
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

						allDefaults = [...allDefaults, ...openAIDefaults];
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
				"DECISION",
			];

			const existingTaskTypes = new Set(
				allDefaults.map((d) => d.taskType),
			);
			const missingTaskTypes = ALL_TASK_TYPES.filter(
				(task) =>
					!existingTaskTypes.has(task) &&
					task !== "EMBEDDING" &&
					(!organizationId ||
						(task !== "DECISION" &&
							(task !== "IMAGE" ||
								defaultProvider === "VERCEL_GATEWAY"))),
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

			return allDefaults.map(toTaskDefaultOutput);
		} catch (error) {
			console.error("[AI Config] getTaskDefaults error:", error);
			throw error;
		}
	});
