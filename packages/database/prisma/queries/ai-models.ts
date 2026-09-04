/**
 * Database queries for AI Model Catalog and Preferences
 * NOTE: Static catalog queries use TTL caching (1 hour) to reduce DB load.
 * See: server-cache-lru rule from Vercel React Best Practices
 */

import { db } from "../client";
import type {
	AIProvider,
	AiModelCapability,
	AiTaskType,
	AiUsageBillingCategory,
	QualityTier,
	SpeedTier,
	TaskComplexity,
} from "../generated/client";
import { estimateAiUsageCostUsd } from "./ai-credits";
import { aiModelCatalogCache, aiTaskDefaultsCache } from "./cache";

// ============================================================================
// Model Catalog Queries
// ============================================================================

/**
 * Get all active models from the catalog
 * CACHED: Results are cached for 1 hour to reduce DB load.
 * The AI model catalog rarely changes (only after seeding).
 */
export async function getActiveModels(options?: {
	family?: string;
	capabilities?: AiModelCapability[];
	speedTier?: SpeedTier;
	qualityTier?: QualityTier;
	limit?: number;
}) {
	// Build cache key from options
	const cacheKey = `active-models:${JSON.stringify(options ?? {})}`;

	return await aiModelCatalogCache.getOrSet(cacheKey, async () => {
		return await db.aiModel.findMany({
			where: {
				isActive: true,
				deprecatedAt: null,
				...(options?.family && { family: options.family }),
				...(options?.capabilities && {
					capabilities: { hasSome: options.capabilities },
				}),
				...(options?.speedTier && { speedTier: options.speedTier }),
				...(options?.qualityTier && {
					qualityTier: options.qualityTier,
				}),
			},
			include: {
				providerMappings: {
					where: { isAvailable: true },
				},
			},
			orderBy: [{ qualityTier: "desc" }, { displayName: "asc" }],
			take: options?.limit,
		});
	});
}

/**
 * Get a model by its canonical name
 */
export async function getModelByCanonicalName(canonicalName: string) {
	return await db.aiModel.findUnique({
		where: { canonicalName },
		include: {
			providerMappings: {
				where: { isAvailable: true },
			},
		},
	});
}

/**
 * Get models available for a specific provider
 */
export async function getModelsForProvider(provider: AIProvider) {
	return await db.aiModel.findMany({
		where: {
			isActive: true,
			providerMappings: {
				some: {
					provider,
					isAvailable: true,
				},
			},
		},
		include: {
			providerMappings: {
				where: { provider, isAvailable: true },
			},
		},
		orderBy: { displayName: "asc" },
	});
}

/**
 * Get models suitable for a specific task type
 */
export async function getModelsForTask(taskType: AiTaskType) {
	return await db.aiModel.findMany({
		where: {
			isActive: true,
			suitableForTasks: { has: taskType },
		},
		include: {
			providerMappings: {
				where: { isAvailable: true },
			},
		},
		orderBy: [{ qualityTier: "desc" }, { displayName: "asc" }],
	});
}

/**
 * Get the system default model for a task type, complexity, and provider.
 * Each provider can have its own default model for each task type.
 * CACHED: Results are cached for 1 hour to reduce DB load.
 * Task defaults rarely change (only after seeding).
 * @param taskType - The task type (SIMPLE, COMPLEX, REASONING, etc.)
 * @param complexity - The complexity level (default: MEDIUM)
 * @param provider - The AI provider (optional - if not provided, returns first available)
 */
export async function getTaskDefaultModel(
	taskType: AiTaskType,
	complexity: TaskComplexity = "MEDIUM",
	provider?: AIProvider,
) {
	// Build cache key from parameters
	const cacheKey = `task-default:${taskType}:${complexity}:${provider ?? "any"}`;

	return await aiTaskDefaultsCache.getOrSet(cacheKey, async () => {
		const defaults = await db.aiTaskModelDefault.findMany({
			where: {
				taskType,
				complexity,
				...(provider && { provider }),
			},
			include: {
				model: {
					include: {
						providerMappings: {
							where: { isAvailable: true },
						},
					},
				},
			},
			orderBy: { priority: "desc" },
			take: 1,
		});

		if (defaults[0]?.model) {
			return defaults[0].model;
		}

		// Defensive complexity fallback (PR 1102 post-merge regression).
		// The catalog seed in `prisma/ai-model-catalog.ts` does not
		// uniformly populate all (taskType, complexity) tiers. The
		// concrete gap that motivated this fallback: `TOOL_CALLING` only
		// has `MEDIUM` entries, but reasoningMode="pro" routes a
		// tool-bound request through complexity="COMPLEX". Without this
		// fallback, every "pro" mode call from the Fabric Loom launcher
		// threw `executeDirectChatActivity` failure before reaching
		// streamText — surfaced to users as the generic "Workflow
		// execution failed".
		//
		// Retry with MEDIUM whenever the requested complexity has no
		// rows. MEDIUM is the only universally-seeded tier across all
		// task types (see catalog), so it's a safe default. If the
		// requested complexity already IS "MEDIUM", skip — there's
		// nothing to fall back to and we should return null so the
		// caller can surface a clear "no model configured" error
		// instead of looping.
		if (complexity !== "MEDIUM") {
			const mediumDefaults = await db.aiTaskModelDefault.findMany({
				where: {
					taskType,
					complexity: "MEDIUM",
					...(provider && { provider }),
				},
				include: {
					model: {
						include: {
							providerMappings: {
								where: { isAvailable: true },
							},
						},
					},
				},
				orderBy: { priority: "desc" },
				take: 1,
			});
			if (mediumDefaults[0]?.model) {
				console.warn(
					"[getTaskDefaultModel] complexity fallback engaged: " +
						`requested ${taskType}+${complexity}+${provider ?? "any"} ` +
						`has no rows; using MEDIUM (${mediumDefaults[0].model.canonicalName}). ` +
						"Add a catalog entry for this tier if the resolution is intended.",
				);
				return mediumDefaults[0].model;
			}
		}

		return null;
	});
}

// ============================================================================
// Model Admin Queries (for seeding and management)
// ============================================================================

/**
 * Upsert a model in the catalog (for seeding)
 */
export async function upsertModel(data: {
	canonicalName: string;
	displayName: string;
	description?: string;
	family: string;
	vendor: string;
	capabilities: AiModelCapability[];
	contextWindow: number;
	maxOutputTokens?: number;
	speedTier?: SpeedTier;
	qualityTier?: QualityTier;
	inputCostPer1M?: number;
	outputCostPer1M?: number;
	suitableForTasks?: AiTaskType[];
	releaseDate?: Date;
	metadata?: any;
}) {
	return await db.aiModel.upsert({
		where: { canonicalName: data.canonicalName },
		create: {
			canonicalName: data.canonicalName,
			displayName: data.displayName,
			description: data.description,
			family: data.family,
			vendor: data.vendor,
			capabilities: data.capabilities,
			contextWindow: data.contextWindow,
			maxOutputTokens: data.maxOutputTokens,
			speedTier: data.speedTier ?? "BALANCED",
			qualityTier: data.qualityTier ?? "STANDARD",
			inputCostPer1M: data.inputCostPer1M,
			outputCostPer1M: data.outputCostPer1M,
			suitableForTasks: data.suitableForTasks ?? [],
			releaseDate: data.releaseDate,
			metadata: data.metadata,
		},
		update: {
			displayName: data.displayName,
			description: data.description,
			family: data.family,
			vendor: data.vendor,
			capabilities: data.capabilities,
			contextWindow: data.contextWindow,
			maxOutputTokens: data.maxOutputTokens,
			speedTier: data.speedTier ?? "BALANCED",
			qualityTier: data.qualityTier ?? "STANDARD",
			inputCostPer1M: data.inputCostPer1M,
			outputCostPer1M: data.outputCostPer1M,
			suitableForTasks: data.suitableForTasks ?? [],
			releaseDate: data.releaseDate,
			metadata: data.metadata,
		},
	});
}

/**
 * Upsert a provider mapping for a model
 */
export async function upsertProviderMapping(data: {
	modelId: string;
	provider: AIProvider;
	providerModelId: string;
	maxContextWindow?: number;
	supportedFeatures?: string[];
	isAvailable?: boolean;
	availabilityNote?: string;
	inputCostPer1M?: number;
	outputCostPer1M?: number;
}) {
	return await db.aiModelProviderMapping.upsert({
		where: {
			modelId_provider: {
				modelId: data.modelId,
				provider: data.provider,
			},
		},
		create: {
			modelId: data.modelId,
			provider: data.provider,
			providerModelId: data.providerModelId,
			maxContextWindow: data.maxContextWindow,
			supportedFeatures: data.supportedFeatures ?? [],
			isAvailable: data.isAvailable ?? true,
			availabilityNote: data.availabilityNote,
			inputCostPer1M: data.inputCostPer1M,
			outputCostPer1M: data.outputCostPer1M,
		},
		update: {
			providerModelId: data.providerModelId,
			maxContextWindow: data.maxContextWindow,
			supportedFeatures: data.supportedFeatures ?? [],
			isAvailable: data.isAvailable ?? true,
			availabilityNote: data.availabilityNote,
			inputCostPer1M: data.inputCostPer1M,
			outputCostPer1M: data.outputCostPer1M,
		},
	});
}

/**
 * Upsert a task-to-model default mapping (provider-specific)
 */
export async function upsertTaskModelDefault(data: {
	taskType: AiTaskType;
	complexity: TaskComplexity;
	modelId: string;
	provider: AIProvider;
	priority?: number;
	requiresToolCalling?: boolean;
	minContextWindow?: number;
}) {
	return await db.aiTaskModelDefault.upsert({
		where: {
			taskType_complexity_provider: {
				taskType: data.taskType,
				complexity: data.complexity,
				provider: data.provider,
			},
		},
		create: {
			taskType: data.taskType,
			complexity: data.complexity,
			modelId: data.modelId,
			provider: data.provider,
			priority: data.priority ?? 0,
			requiresToolCalling: data.requiresToolCalling ?? false,
			minContextWindow: data.minContextWindow,
		},
		update: {
			modelId: data.modelId,
			priority: data.priority ?? 0,
			requiresToolCalling: data.requiresToolCalling ?? false,
			minContextWindow: data.minContextWindow,
		},
	});
}

// ============================================================================
// User Model Preferences (per provider)
// ============================================================================

/**
 * Get all of user's model overrides for a specific provider
 */
export async function getUserModelPreferences(
	userId: string,
	provider?: AIProvider,
) {
	return await db.userModelPreference.findMany({
		where: {
			userId,
			...(provider && { provider }),
		},
		include: {
			model: {
				include: {
					providerMappings: {
						where: { isAvailable: true },
					},
				},
			},
		},
		orderBy: { taskType: "asc" },
	});
}

/**
 * Get user's model override for a specific task type and provider.
 * Includes deprecation fields for automatic model replacement handling.
 */
export async function getUserModelPreference(
	userId: string,
	taskType: AiTaskType,
	provider: AIProvider,
) {
	return await db.userModelPreference.findUnique({
		where: {
			userId_taskType_provider: {
				userId,
				taskType,
				provider,
			},
		},
		include: {
			model: {
				include: {
					providerMappings: {
						where: { provider, isAvailable: true },
					},
				},
			},
		},
	});
}

/**
 * Set or update user's model override for a task type and provider
 */
export async function setUserModelPreference(data: {
	userId: string;
	provider: AIProvider;
	taskType: AiTaskType;
	modelId: string;
	customParameters?: any;
}) {
	return await db.userModelPreference.upsert({
		where: {
			userId_taskType_provider: {
				userId: data.userId,
				taskType: data.taskType,
				provider: data.provider,
			},
		},
		create: {
			userId: data.userId,
			provider: data.provider,
			taskType: data.taskType,
			modelId: data.modelId,
			customParameters: data.customParameters,
		},
		update: {
			modelId: data.modelId,
			customParameters: data.customParameters,
		},
		include: {
			model: true,
		},
	});
}

/**
 * Delete user's model override for a task type and provider
 */
export async function deleteUserModelPreference(
	userId: string,
	taskType: AiTaskType,
	provider: AIProvider,
) {
	return await db.userModelPreference.delete({
		where: {
			userId_taskType_provider: {
				userId,
				taskType,
				provider,
			},
		},
	});
}

/**
 * Delete ALL user's model overrides for a task type (any provider).
 * Used when setting a new preference to avoid duplicates across providers.
 */
export async function deleteUserModelPreferencesByTaskType(
	userId: string,
	taskType: AiTaskType,
) {
	return await db.userModelPreference.deleteMany({
		where: {
			userId,
			taskType,
		},
	});
}

// ============================================================================
// Organization Model Preferences (per provider)
// ============================================================================

/**
 * Get all of organization's model overrides for a specific provider
 */
export async function getOrgModelPreferences(
	organizationId: string,
	provider?: AIProvider,
) {
	return await db.organizationModelPreference.findMany({
		where: {
			organizationId,
			...(provider && { provider }),
		},
		include: {
			model: {
				include: {
					providerMappings: {
						where: { isAvailable: true },
					},
				},
			},
		},
		orderBy: { taskType: "asc" },
	});
}

/**
 * Get organization's model override for a specific task type and provider
 */
export async function getOrgModelPreference(
	organizationId: string,
	taskType: AiTaskType,
	provider: AIProvider,
) {
	return await db.organizationModelPreference.findUnique({
		where: {
			organizationId_taskType_provider: {
				organizationId,
				taskType,
				provider,
			},
		},
		include: {
			model: {
				include: {
					providerMappings: {
						where: { provider, isAvailable: true },
					},
				},
			},
		},
	});
}

/**
 * Set or update organization's model override for a task type and provider
 */
export async function setOrgModelPreference(data: {
	organizationId: string;
	provider: AIProvider;
	taskType: AiTaskType;
	modelId: string;
	customParameters?: any;
}) {
	return await db.organizationModelPreference.upsert({
		where: {
			organizationId_taskType_provider: {
				organizationId: data.organizationId,
				taskType: data.taskType,
				provider: data.provider,
			},
		},
		create: {
			organizationId: data.organizationId,
			provider: data.provider,
			taskType: data.taskType,
			modelId: data.modelId,
			customParameters: data.customParameters,
		},
		update: {
			modelId: data.modelId,
			customParameters: data.customParameters,
		},
		include: {
			model: true,
		},
	});
}

/**
 * Delete organization's model override for a task type and provider
 */
export async function deleteOrgModelPreference(
	organizationId: string,
	taskType: AiTaskType,
	provider: AIProvider,
) {
	return await db.organizationModelPreference.delete({
		where: {
			organizationId_taskType_provider: {
				organizationId,
				taskType,
				provider,
			},
		},
	});
}

/**
 * Delete ALL organization's model overrides for a task type (any provider).
 * Used when setting a new preference to avoid duplicates across providers.
 */
export async function deleteOrgModelPreferencesByTaskType(
	organizationId: string,
	taskType: AiTaskType,
) {
	return await db.organizationModelPreference.deleteMany({
		where: {
			organizationId,
			taskType,
		},
	});
}

// ============================================================================
// Model Deprecation Handling
// ============================================================================

/**
 * Model resolution result with deprecation info
 */
export interface ModelResolutionResult {
	model: Awaited<ReturnType<typeof getModelByCanonicalName>>;
	providerModelId: string | undefined;
	source: "user_override" | "org_override" | "system_default";
	/** If the originally selected model was deprecated and replaced */
	wasDeprecated?: boolean;
	/** The original deprecated model's canonical name (for logging) */
	deprecatedModelName?: string;
}

/**
 * Check if a model is deprecated and resolve to its replacement if available.
 * Follows the replacement chain up to 3 levels deep to prevent infinite loops.
 * @param model - The model to check
 * @param provider - The provider to get the provider-specific model ID
 * @param maxDepth - Maximum replacement chain depth (default: 3)
 * @returns The resolved model (original if not deprecated, replacement if deprecated)
 */
async function resolveDeprecatedModel(
	model: NonNullable<Awaited<ReturnType<typeof getModelByCanonicalName>>>,
	provider: AIProvider,
	maxDepth = 3,
): Promise<{
	model: NonNullable<Awaited<ReturnType<typeof getModelByCanonicalName>>>;
	wasDeprecated: boolean;
	originalModelName?: string;
}> {
	// If model is not deprecated, return as-is
	if (!model.deprecatedAt) {
		return { model, wasDeprecated: false };
	}

	// Model is deprecated - try to find replacement
	const originalModelName = model.canonicalName;
	let currentModel = model;
	let depth = 0;

	while (currentModel.deprecatedAt && depth < maxDepth) {
		// Check if there's a replacement model configured
		if (!currentModel.replacementModelId) {
			// No replacement configured - log warning and return deprecated model
			console.warn(
				`[AI Model Deprecation] Model "${currentModel.canonicalName}" is deprecated but has no replacement configured. ` +
					"Consider configuring a replacement or removing the model from preferences.",
			);
			return {
				model: currentModel,
				wasDeprecated: true,
				originalModelName,
			};
		}

		// Fetch the replacement model
		const replacement = await db.aiModel.findUnique({
			where: { id: currentModel.replacementModelId },
			include: {
				providerMappings: {
					where: { provider, isAvailable: true },
				},
			},
		});

		if (!replacement) {
			console.warn(
				`[AI Model Deprecation] Replacement model for "${currentModel.canonicalName}" not found. ` +
					"Using deprecated model.",
			);
			return {
				model: currentModel,
				wasDeprecated: true,
				originalModelName,
			};
		}

		// Check if replacement is available for this provider
		if (replacement.providerMappings.length === 0) {
			console.warn(
				`[AI Model Deprecation] Replacement model "${replacement.canonicalName}" is not available for provider "${provider}". ` +
					"Using deprecated model.",
			);
			return {
				model: currentModel,
				wasDeprecated: true,
				originalModelName,
			};
		}

		console.info(
			`[AI Model Deprecation] Model "${currentModel.canonicalName}" is deprecated. ` +
				`Using replacement: "${replacement.canonicalName}"`,
		);

		currentModel = replacement;
		depth++;
	}

	if (depth >= maxDepth && currentModel.deprecatedAt) {
		console.warn(
			`[AI Model Deprecation] Replacement chain too deep (>${maxDepth}) for "${originalModelName}". ` +
				"Using last model in chain.",
		);
	}

	return { model: currentModel, wasDeprecated: true, originalModelName };
}

// ============================================================================
// Effective Model Resolution (XOR Tenant Isolation)
// ============================================================================

/**
 * Get the effective model for a task type and provider.
 * IMPORTANT: Uses XOR pattern for strict tenant isolation.
 * Personal and organization contexts are MUTUALLY EXCLUSIVE.
 * Priority by context:
 * - PERSONAL CONTEXT (organizationId is null/undefined):
 * 1. User override for this task type + provider
 * 2. System default for this task type + provider
 * - ORGANIZATION CONTEXT (organizationId is provided):
 * 1. Organization override for this task type + provider
 * 2. System default for this task type + provider
 * (User personal preferences are NOT checked - strict isolation)
 * DEPRECATION HANDLING:
 * If a selected model is deprecated and has a replacement configured,
 * the replacement model will be returned instead. A warning is logged
 * for observability.
 * @param userId - The user ID
 * @param provider - The current default provider
 * @param taskType - The task type
 * @param organizationId - Optional organization ID (for org context)
 * @param complexity - Task complexity (default: MEDIUM)
 */
export async function getModelForTask(
	userId: string,
	provider: AIProvider,
	taskType: AiTaskType,
	organizationId?: string | null,
	complexity: TaskComplexity = "MEDIUM",
): Promise<ModelResolutionResult | null> {
	// XOR PATTERN: Check context-specific overrides ONLY
	// Personal preferences NEVER leak into org context and vice versa
	if (organizationId) {
		// ORGANIZATION CONTEXT: Only check org overrides
		const orgOverride = await getOrgModelPreference(
			organizationId,
			taskType,
			provider,
		);
		if (orgOverride) {
			// Handle deprecation
			const { model, wasDeprecated, originalModelName } =
				await resolveDeprecatedModel(orgOverride.model, provider);
			const providerMapping = model.providerMappings?.find(
				(m) => m.provider === provider,
			);
			// Defense-in-depth (PR 1090 review I-1).
			// When the org preference points at a (modelId, provider) pair
			// the catalog no longer carries — e.g., after Fallback A removed
			// `(o3-mini, VERCEL_GATEWAY)` while keeping the model otherwise
			// — `providerMapping` is undefined. Historically we returned
			// `providerModelId: undefined`, which `resolveModel` then turned
			// into a hard throw ("No model configured…"). That denied users
			// any output. Now we log and fall through to the system default
			// for the same task type — soft degrade rather than hard fail.
			if (providerMapping?.providerModelId) {
				return {
					model,
					providerModelId: providerMapping.providerModelId,
					source: "org_override" as const,
					wasDeprecated,
					deprecatedModelName: originalModelName,
				};
			}
			console.warn(
				"[getModelForTask] org override mapping no longer in catalog — falling through to system default",
				{
					organizationId,
					taskType,
					provider,
					canonicalName: model.canonicalName,
				},
			);
		}
	} else {
		// PERSONAL CONTEXT: Only check user overrides
		const userOverride = await getUserModelPreference(
			userId,
			taskType,
			provider,
		);
		if (userOverride) {
			// Handle deprecation
			const { model, wasDeprecated, originalModelName } =
				await resolveDeprecatedModel(userOverride.model, provider);
			const providerMapping = model.providerMappings?.find(
				(m) => m.provider === provider,
			);
			// Defense-in-depth (PR 1090 review I-1) — same rationale as the
			// organization branch above. Soft degrade to system default
			// instead of throwing at `resolveModel`.
			if (providerMapping?.providerModelId) {
				return {
					model,
					providerModelId: providerMapping.providerModelId,
					source: "user_override" as const,
					wasDeprecated,
					deprecatedModelName: originalModelName,
				};
			}
			console.warn(
				"[getModelForTask] user override mapping no longer in catalog — falling through to system default",
				{
					userId,
					taskType,
					provider,
					canonicalName: model.canonicalName,
				},
			);
		}
	}

	// Both contexts fall back to system default for this provider + task type
	const systemDefault = await getTaskDefaultModel(
		taskType,
		complexity,
		provider,
	);
	if (systemDefault) {
		// Handle deprecation (unlikely for system defaults, but handle for completeness)
		const { model, wasDeprecated, originalModelName } =
			await resolveDeprecatedModel(systemDefault, provider);
		const providerMapping = model.providerMappings?.find(
			(m) => m.provider === provider,
		);
		return {
			model,
			providerModelId:
				providerMapping?.providerModelId ?? model.canonicalName,
			source: "system_default" as const,
			wasDeprecated,
			deprecatedModelName: originalModelName,
		};
	}

	return null;
}

/**
 * Resolve a catalog canonical name to a specific provider's model ID.
 *
 * Used to map a user-selected model override (which is a canonical name, e.g.
 * "claude-sonnet-5") to the model string the provider actually expects (e.g. the
 * Databricks Unity AI Gateway service "system.ai.claude-sonnet-5"). Returns null
 * when the canonical has no available mapping for the provider, so the caller can
 * fall back to using the override string as-is.
 */
export async function getProviderModelIdForCanonical(
	canonicalName: string,
	provider: AIProvider,
): Promise<string | null> {
	const model = await db.aiModel.findUnique({
		where: { canonicalName },
		include: {
			providerMappings: {
				where: { provider, isAvailable: true },
				take: 1,
			},
		},
	});
	return model?.providerMappings?.[0]?.providerModelId ?? null;
}

// ============================================================================
// Usage Logging
// ============================================================================

/** Type for AI usage log data */
export interface AiUsageLogData {
	userId?: string;
	organizationId?: string;
	projectId?: string;
	providerConfigId?: string;
	provider: AIProvider;
	modelCanonicalName?: string;
	providerModelId: string;
	taskType?: AiTaskType;
	agentId?: string;
	conversationId?: string;
	/** User-facing AI feature this call belongs to (Fizzy #2230). */
	featureKey?: string;
	/** Resolved PromptVersion id the call ran with, when known. */
	promptVersionId?: string;
	/**
	 * Scheduled/background pipeline that issued this call (Fizzy #1894), e.g.
	 * "scheduled-report". Null = user-initiated.
	 */
	jobType?: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedInputTokens?: number;
	cacheCreationInputTokens?: number;
	reasoningTokens?: number;
	costUsd?: number;
	costCents?: number;
	/** Vercel-gateway generation id, for later actual-cost reconciliation. */
	gatewayGenerationId?: string;
	latencyMs: number;
	billingCategory?: AiUsageBillingCategory | null;
	billingCustomerId?: string | null;
	success?: boolean;
	errorMessage?: string;
}

/**
 * Log AI usage for analytics
 */
export async function logAiUsage(data: AiUsageLogData) {
	const costUsd =
		data.costUsd ??
		(data.costCents !== undefined
			? Number((data.costCents / 100).toFixed(6))
			: await estimateAiUsageCostUsd({
					userId: data.userId,
					organizationId: data.organizationId,
					provider: data.provider,
					providerModelId: data.providerModelId,
					modelCanonicalName: data.modelCanonicalName,
					taskType: data.taskType,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cachedInputTokens: data.cachedInputTokens,
					cacheCreationInputTokens: data.cacheCreationInputTokens,
				}));

	const costCents =
		data.costCents ?? Math.round(Number((costUsd * 100).toFixed(6)));
	// Precise micro-USD for dashboards; costCents loses sub-cent precision and
	// zeroes out small calls, which breaks per-project totals when summed.
	const costMicroUsd = Math.round(
		Number((Math.max(costUsd, 0) * 1_000_000).toFixed(0)),
	);

	const logEntry = await db.aiUsageLog.create({
		data: {
			userId: data.userId,
			organizationId: data.organizationId,
			projectId: data.projectId,
			providerConfigId: data.providerConfigId,
			provider: data.provider,
			modelCanonicalName: data.modelCanonicalName,
			providerModelId: data.providerModelId,
			taskType: data.taskType,
			agentId: data.agentId,
			conversationId: data.conversationId,
			featureKey: data.featureKey,
			promptVersionId: data.promptVersionId,
			jobType: data.jobType,
			inputTokens: data.inputTokens,
			outputTokens: data.outputTokens,
			totalTokens: data.totalTokens,
			cachedInputTokens: data.cachedInputTokens ?? 0,
			cacheCreationInputTokens: data.cacheCreationInputTokens ?? 0,
			reasoningTokens: data.reasoningTokens ?? 0,
			costCents,
			costMicroUsd,
			gatewayGenerationId: data.gatewayGenerationId ?? null,
			// A gateway row starts as an estimate awaiting reconciliation; every
			// other row's cost is already final.
			costIsActual: !data.gatewayGenerationId,
			latencyMs: data.latencyMs,
			billingCategory: data.billingCategory ?? null,
			billingCustomerId: data.billingCustomerId ?? null,
			success: data.success ?? true,
			// Provider/gateway failures can surface response bodies or stack
			// traces of arbitrary size, and some upstream validation errors echo
			// submitted credentials back. Bound the text and scrub key-shaped
			// tokens before anything lands in the ledger (Fizzy #1894 review).
			errorMessage: data.errorMessage
				?.replace(
					/\b(?:sk|wfk|rk)-[A-Za-z0-9]{16,}\b|Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
					"[redacted]",
				)
				.slice(0, 500),
		},
	});

	// NOTE: this used to increment a per-tenant credit ledger here, after every
	// usage record and without regard to who paid for the call. That was the
	// bug as much as the feature: spend on a tenant's OWN provider key accrued
	// against a platform allowance it was never funded by, so the ledger
	// counted money the platform never spent. The allowance no longer grants
	// anything (Fizzy #1875), so nothing accrues. The ledger table and the rows
	// already in it are left untouched; nothing reads them.

	// Post-record AI usage-limit accounting — fire-and-forget. Invoked via
	// the registry hook installed by `@repo/payments` (see
	// {@link setAiUsageRecorder} below). Keeps `@repo/database` free of a
	// runtime dep on `@repo/payments` (which would form a workspace cycle:
	// database → payments → api → database). The registered recorder
	// increments per-limit counters and fans out 80% / 100% threshold
	// notifications. Wrapped in `.catch` so failures in the limits subsystem
	// can never break the `AiUsageLog` row insert.
	// Zero-token rows (image/transcription invocation markers, failure
	// markers) can never move a limit counter — skip the recorder chain
	// instead of paying its timezone + limits queries for a BigInt(0) delta.
	if (
		data.userId &&
		aiUsageRecorder &&
		(data.totalTokens > 0 || costMicroUsd > 0)
	) {
		aiUsageRecorder({
			userId: data.userId,
			organizationId: data.organizationId ?? null,
			projectId: data.projectId ?? null,
			providerConfigId: data.providerConfigId ?? null,
			modelCanonicalName: data.modelCanonicalName ?? null,
			taskType: data.taskType ?? null,
			totalTokens: data.totalTokens,
			costMicroUsd,
		}).catch(() => {
			// Swallow — the recorder itself logs failures.
		});
	}

	return logEntry;
}

// ---------------------------------------------------------------------------
// AI usage-limits recorder registry
// ---------------------------------------------------------------------------

/**
 * Shape of the post-record AI usage-limit recorder hook. The real
 * implementation lives in `@repo/payments`. Defined here (not imported)
 * so this package stays free of an `@repo/payments` runtime dep — that
 * direction would form a workspace cycle.
 */
export interface AiUsageRecorderInput {
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
	providerConfigId?: string | null;
	modelCanonicalName?: string | null;
	taskType?: AiTaskType | null;
	totalTokens: number;
	costMicroUsd: number;
}

export type AiUsageRecorder = (input: AiUsageRecorderInput) => Promise<void>;

let aiUsageRecorder: AiUsageRecorder | null = null;

/**
 * Register the post-record hook that {@link logAiUsage} invokes after a
 * successful AiUsageLog insert. `@repo/payments` registers its
 * `recordAiUsageAndCheckOverage` here at module load. If no recorder is
 * registered (e.g., test environments mocking only `@repo/database`), the
 * AI call still succeeds and the row still lands — only the per-limit
 * counter update and threshold fan-out are skipped.
 */
export function setAiUsageRecorder(recorder: AiUsageRecorder | null): void {
	aiUsageRecorder = recorder;
}

/**
 * Log AI usage asynchronously without blocking the response.
 * This is the fire-and-forget version of logAiUsage for use in performance-critical paths.
 * Errors are silently logged to console instead of propagating.
 * See: server-after-nonblocking rule from Vercel React Best Practices
 * For Next.js route handlers, you can also use:
 * ```typescript
 * import { after } from "next/server";
 * after(=> logAiUsage(data));
 * ```
 */
export function logAiUsageAsync(data: AiUsageLogData): void {
	// Fire-and-forget: don't await, just schedule the work
	logAiUsage(data).catch((error) => {
		// Silent failure - logging should never break the main flow
		console.error("[AI Usage Logging] Failed to log usage:", error);
	});
}

/**
 * Get usage statistics for a user or organization
 */
export async function getUsageStats(options: {
	userId?: string;
	organizationId?: string;
	provider?: AIProvider;
	modelCanonicalName?: string;
	startDate?: Date;
	endDate?: Date;
	groupBy?: "provider" | "model" | "day" | "agent";
}) {
	const where = {
		...(options.userId && { userId: options.userId }),
		...(options.organizationId && {
			organizationId: options.organizationId,
		}),
		...(options.provider && { provider: options.provider }),
		...(options.modelCanonicalName && {
			modelCanonicalName: options.modelCanonicalName,
		}),
		...(options.startDate &&
			options.endDate && {
				createdAt: {
					gte: options.startDate,
					lte: options.endDate,
				},
			}),
	};

	// Get aggregated stats
	const stats = await db.aiUsageLog.aggregate({
		where,
		_sum: {
			inputTokens: true,
			outputTokens: true,
			totalTokens: true,
			costCents: true,
			latencyMs: true,
		},
		_avg: {
			latencyMs: true,
		},
		_count: {
			id: true,
		},
	});

	// Get grouped stats if requested
	let grouped = null;
	if (options.groupBy === "provider") {
		grouped = await db.aiUsageLog.groupBy({
			by: ["provider"],
			where,
			_sum: {
				totalTokens: true,
				costCents: true,
			},
			_count: {
				id: true,
			},
		});
	} else if (options.groupBy === "model") {
		grouped = await db.aiUsageLog.groupBy({
			by: ["modelCanonicalName"],
			where,
			_sum: {
				totalTokens: true,
				costCents: true,
			},
			_count: {
				id: true,
			},
		});
	} else if (options.groupBy === "agent") {
		grouped = await db.aiUsageLog.groupBy({
			by: ["agentId"],
			where,
			_sum: {
				totalTokens: true,
				costCents: true,
			},
			_count: {
				id: true,
			},
		});
	}

	return {
		totalRequests: stats._count.id,
		totalInputTokens: stats._sum.inputTokens ?? 0,
		totalOutputTokens: stats._sum.outputTokens ?? 0,
		totalTokens: stats._sum.totalTokens ?? 0,
		totalCostCents: stats._sum.costCents ?? 0,
		avgLatencyMs: stats._avg.latencyMs ?? 0,
		grouped,
	};
}

// ============================================================================
// Provider Fallback Chains
// ============================================================================

/**
 * Error types that can trigger provider fallbacks
 */
export type FallbackTriggerError =
	| "rate_limit"
	| "timeout"
	| "model_unavailable"
	| "api_error"
	| "quota_exceeded"
	| "server_error";

/**
 * Get fallback providers for a given primary provider.
 * Uses XOR pattern for tenant isolation:
 * - In org context: Only org-specific and system fallbacks
 * - In personal context: Only user-specific and system fallbacks
 * @param primaryProvider - The provider that failed
 * @param options - Filter options
 * @returns Ordered list of fallback providers
 */
export async function getProviderFallbacks(
	primaryProvider: AIProvider,
	options?: {
		userId?: string;
		organizationId?: string | null;
		taskType?: AiTaskType;
		errorType?: FallbackTriggerError;
	},
) {
	const { userId, organizationId, taskType, errorType } = options ?? {};

	// Build scope filter based on XOR tenant isolation
	const scopeFilter = organizationId
		? // ORG CONTEXT: Only org-specific and system fallbacks
			{
				OR: [{ scope: "SYSTEM" }, { scope: "ORG", organizationId }],
			}
		: userId
			? // PERSONAL CONTEXT: Only user-specific and system fallbacks
				{
					OR: [{ scope: "SYSTEM" }, { scope: "USER", userId }],
				}
			: // NO CONTEXT: Only system fallbacks
				{ scope: "SYSTEM" };

	const fallbacks = await db.aiProviderFallback.findMany({
		where: {
			primaryProvider,
			isActive: true,
			...scopeFilter,
			// Filter by task type if specified
			...(taskType && {
				OR: [
					{ taskTypes: { isEmpty: true } }, // Applies to all task types
					{ taskTypes: { has: taskType } },
				],
			}),
			// Filter by error type if specified
			...(errorType && {
				OR: [
					{ triggerOnErrors: { isEmpty: true } }, // Applies to all errors
					{ triggerOnErrors: { has: errorType } },
				],
			}),
		},
		orderBy: { priority: "asc" },
	});

	return fallbacks;
}

/**
 * Record that a fallback was triggered (for analytics and cooldown tracking)
 */
export async function recordFallbackTriggered(fallbackId: string) {
	return await db.aiProviderFallback.update({
		where: { id: fallbackId },
		data: {
			lastTriggeredAt: new Date(),
			triggerCount: { increment: 1 },
		},
	});
}

/**
 * Check if a fallback is in cooldown period
 */
export async function isFallbackInCooldown(
	fallbackId: string,
): Promise<boolean> {
	const fallback = await db.aiProviderFallback.findUnique({
		where: { id: fallbackId },
		select: { lastTriggeredAt: true, cooldownSeconds: true },
	});

	if (!fallback?.lastTriggeredAt) {
		return false;
	}

	const cooldownEnd = new Date(
		fallback.lastTriggeredAt.getTime() + fallback.cooldownSeconds * 1000,
	);
	return new Date() < cooldownEnd;
}

/**
 * Create or update a provider fallback configuration
 */
export async function upsertProviderFallback(data: {
	primaryProvider: AIProvider;
	fallbackProvider: AIProvider;
	priority?: number;
	taskTypes?: AiTaskType[];
	triggerOnErrors?: FallbackTriggerError[];
	cooldownSeconds?: number;
	isActive?: boolean;
	scope?: "SYSTEM" | "USER" | "ORG";
	userId?: string;
	organizationId?: string;
}) {
	const {
		primaryProvider,
		fallbackProvider,
		priority = 0,
		taskTypes = [],
		triggerOnErrors = [],
		cooldownSeconds = 60,
		isActive = true,
		scope = "SYSTEM",
		userId = null,
		organizationId = null,
	} = data;

	// Prisma's upsert with composite unique constraints containing nullable fields
	// requires a workaround: use findFirst + create/update pattern instead
	const existing = await db.aiProviderFallback.findFirst({
		where: {
			primaryProvider,
			fallbackProvider,
			scope,
			userId: userId ?? null,
			organizationId: organizationId ?? null,
		},
	});

	if (existing) {
		return await db.aiProviderFallback.update({
			where: { id: existing.id },
			data: {
				priority,
				taskTypes,
				triggerOnErrors,
				cooldownSeconds,
				isActive,
			},
		});
	}

	return await db.aiProviderFallback.create({
		data: {
			primaryProvider,
			fallbackProvider,
			priority,
			taskTypes,
			triggerOnErrors,
			cooldownSeconds,
			isActive,
			scope,
			userId: userId ?? null,
			organizationId: organizationId ?? null,
		},
	});
}

/**
 * Get default system fallback chains.
 * These are recommended fallbacks based on model compatibility.
 */
export function getDefaultFallbackChains(): Array<{
	primaryProvider: AIProvider;
	fallbackProvider: AIProvider;
	priority: number;
	description: string;
}> {
	return [
		// Groq fallbacks - fast inference providers
		{
			primaryProvider: "GROQ",
			fallbackProvider: "CEREBRAS",
			priority: 0,
			description: "Both support Llama models with fast inference",
		},
		{
			primaryProvider: "GROQ",
			fallbackProvider: "TOGETHER_AI",
			priority: 1,
			description: "Together AI has similar open-source model support",
		},
		// Cerebras fallbacks
		{
			primaryProvider: "CEREBRAS",
			fallbackProvider: "GROQ",
			priority: 0,
			description: "Both support Llama models with fast inference",
		},
		// OpenAI fallbacks
		{
			primaryProvider: "OPENAI_DIRECT",
			fallbackProvider: "AZURE_AI_FOUNDRY",
			priority: 0,
			description: "Azure hosts OpenAI models",
		},
		{
			primaryProvider: "OPENAI_DIRECT",
			fallbackProvider: "VERCEL_GATEWAY",
			priority: 1,
			description: "Gateway can route to OpenAI",
		},
		// Anthropic fallbacks
		{
			primaryProvider: "ANTHROPIC_DIRECT",
			fallbackProvider: "AWS_BEDROCK",
			priority: 0,
			description: "Bedrock hosts Claude models",
		},
		{
			primaryProvider: "ANTHROPIC_DIRECT",
			fallbackProvider: "VERCEL_GATEWAY",
			priority: 1,
			description: "Gateway can route to Anthropic",
		},
		// DeepSeek fallbacks
		{
			primaryProvider: "DEEPSEEK",
			fallbackProvider: "TOGETHER_AI",
			priority: 0,
			description: "Together AI hosts DeepSeek models",
		},
		{
			primaryProvider: "DEEPSEEK",
			fallbackProvider: "FIREWORKS",
			priority: 1,
			description: "Fireworks hosts DeepSeek models",
		},
		// Gateway fallbacks
		{
			primaryProvider: "VERCEL_GATEWAY",
			fallbackProvider: "OPENROUTER",
			priority: 0,
			description: "Both are unified API gateways",
		},
	];
}
