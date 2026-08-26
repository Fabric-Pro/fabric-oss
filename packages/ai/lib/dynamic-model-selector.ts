/**
 * Dynamic Model Selection from Database
 * This module provides model selection that reads from the database,
 * supporting user/org preferences, enforced policies, and system defaults.
 * The resolution priority is:
 * 1. Organization enforced preference (if enforceForMembers = true)
 * 2. User preference for specific agent
 * 3. Organization preference for specific agent
 * 4. User preference for task type
 * 5. Organization preference for task type
 * 6. System default for task type
 * 7. Hardcoded fallback (if database is empty)
 */

import {
	GATEWAY_PROVIDERS as DB_GATEWAY_PROVIDERS,
	getActiveModels,
	getAiProviderApiKey,
	getAiProviderApiKeyByProvider,
	getEmbeddingProviderConfig,
	getModelForTask,
	getProviderModelIdForCanonical,
	getTaskDefaultModel,
} from "@repo/database";
import {
	assertTenantCanUseAi,
	assertWithinAiUsageLimits,
} from "@repo/payments";
import type { AiFeatureKey } from "./feature-keys";
import type { AiJobKey } from "./job-keys";

// Use inline type imports to avoid export conflicts with models.ts
// The database uses different naming conventions (GROQ vs groq, etc.)
type DbAIProvider = import("@repo/database").AIProvider;
type DbAiTaskType = import("@repo/database").AiTaskType;

/** Task complexity levels for dynamic selection */
export type DynamicTaskComplexity = "simple" | "medium" | "complex";

/** Context for model resolution */
export interface ModelResolutionContext {
	userId: string;
	organizationId?: string;
	agentId?: string;
}

/** Options for model selection */
export interface DynamicModelSelectionOptions {
	taskType: DbAiTaskType;
	complexity?: DynamicTaskComplexity;
	requiresToolCalling?: boolean;
	preferredProvider?: DbAIProvider;
	maxTokensNeeded?: number;
}

/** Result of dynamic model selection */
export interface DynamicModelSelectionResult {
	modelId: string;
	canonicalName: string;
	displayName: string;
	provider: DbAIProvider;
	providerModelId: string;
	selectionSource: string;
	maxTokens?: number;
	/** Max output (completion) tokens from the catalog model, when known */
	maxOutputTokens?: number;
}

// Import the database TaskComplexity type
type DbTaskComplexity = import("@repo/database").TaskComplexity;

/** Map complexity string to database enum */
function mapComplexityToDb(
	complexity: DynamicTaskComplexity,
): DbTaskComplexity {
	switch (complexity) {
		case "simple":
			return "SIMPLE";
		case "medium":
			return "MEDIUM";
		case "complex":
			return "COMPLEX";
		default:
			return "MEDIUM";
	}
}

/** Map lowercase task type to database enum */
function mapTaskTypeToDb(taskType: string): DbAiTaskType {
	return taskType.toUpperCase() as DbAiTaskType;
}

/**
 * Gateway providers that can route to other underlying providers.
 * Using centralized definition from @repo/database.
 */
const GATEWAY_PROVIDERS = new Set<DbAIProvider>(DB_GATEWAY_PROVIDERS);

/**
 * Map of underlying providers that each gateway can route to.
 * The key is the gateway provider, value is an array of supported direct providers.
 */
const GATEWAY_SUPPORTED_PROVIDERS: Partial<
	Record<DbAIProvider, DbAIProvider[]>
> = {
	VERCEL_GATEWAY: [
		"GROQ",
		"OPENAI_DIRECT",
		"ANTHROPIC_DIRECT",
		"MISTRAL_AI",
		"COHERE",
		"DEEPSEEK",
	],
	OPENROUTER: [
		"OPENAI_DIRECT",
		"ANTHROPIC_DIRECT",
		"GROQ",
		"MISTRAL_AI",
		"DEEPSEEK",
		"TOGETHER_AI",
	],
	CLOUDFLARE_AI: ["OPENAI_DIRECT", "ANTHROPIC_DIRECT"],
	// Direct providers don't route to others - empty arrays
};

/**
 * Map of provider names to their gateway prefix.
 * When using a gateway, models from these providers are accessed via prefix.
 */
const PROVIDER_TO_GATEWAY_PREFIX: Partial<Record<DbAIProvider, string>> = {
	GROQ: "groq",
	OPENAI_DIRECT: "openai",
	ANTHROPIC_DIRECT: "anthropic",
	MISTRAL_AI: "mistral",
	DEEPSEEK: "deepseek",
	TOGETHER_AI: "together",
	COHERE: "cohere",
	PERPLEXITY: "perplexity",
	XAI: "xai",
	FIREWORKS: "fireworks",
	// Gateways and cloud providers don't need prefixes
};

/**
 * Checks if a gateway can route to a specific provider.
 */
function canGatewayRouteToProvider(
	gateway: DbAIProvider,
	provider: DbAIProvider,
): boolean {
	if (!GATEWAY_PROVIDERS.has(gateway)) {
		return false;
	}
	const supported = GATEWAY_SUPPORTED_PROVIDERS[gateway];
	if (!supported) {
		return false;
	}
	return supported.includes(provider);
}

/**
 * Transforms a provider model ID for use through a gateway.
 * Example: GROQ model "llama-3.3-70b-versatile" becomes "groq/llama-3.3-70b-versatile" for VERCEL_GATEWAY.
 */
export function transformModelIdForGateway(
	providerModelId: string,
	sourceProvider: DbAIProvider,
	_gateway: DbAIProvider,
): string {
	const prefix = PROVIDER_TO_GATEWAY_PREFIX[sourceProvider];
	if (!prefix) {
		return providerModelId;
	}

	// If model already has the prefix, return as-is
	if (providerModelId.startsWith(`${prefix}/`)) {
		return providerModelId;
	}

	return `${prefix}/${providerModelId}`;
}

// NOTE: Hardcoded fallback functions have been REMOVED.
// All model configuration MUST come from the database.
// If models are not configured, the system throws a clear error.
// To seed the database: pnpm --filter @repo/database seed:ai-models

/**
 * Dynamically select a model based on context and preferences.
 * SIMPLIFIED: Uses the new getModelForTask which queries:
 * 1. User override for this task type + provider
 * 2. Org override for this task type + provider (if in org context)
 * 3. System default for this task type + provider
 */
export async function selectModelDynamic(
	options: DynamicModelSelectionOptions,
	context: ModelResolutionContext,
): Promise<DynamicModelSelectionResult> {
	const {
		taskType,
		complexity = "medium",
		requiresToolCalling = false,
		preferredProvider,
	} = options;

	// Determine effective task type
	const effectiveTaskType = requiresToolCalling
		? ("TOOL_CALLING" as DbAiTaskType)
		: mapTaskTypeToDb(taskType as string);

	// Must have a preferred provider to select a model
	if (!preferredProvider) {
		throw new Error(
			"[ModelSelector] preferredProvider is required. Please configure a default AI provider.",
		);
	}

	const dbComplexity = mapComplexityToDb(complexity);

	// Use simplified getModelForTask which handles user override, org override, and system default
	const result = await getModelForTask(
		context.userId,
		preferredProvider,
		effectiveTaskType,
		context.organizationId ?? null,
		dbComplexity,
	);

	if (result?.model) {
		return {
			modelId: result.model.id,
			canonicalName: result.model.canonicalName,
			displayName: result.model.displayName,
			provider: preferredProvider,
			providerModelId:
				result.providerModelId ?? result.model.canonicalName,
			selectionSource: result.source,
			maxTokens: result.model.contextWindow ?? undefined,
			maxOutputTokens: result.model.maxOutputTokens ?? undefined,
		};
	}

	// Fallback: try to get any system default for this task type (without provider filter)
	const defaultModel = await getTaskDefaultModel(
		effectiveTaskType,
		dbComplexity,
	);

	if (defaultModel) {
		// Find the mapping for the preferred provider
		const providerMapping = defaultModel.providerMappings?.find(
			(m) => m.provider === preferredProvider,
		);

		if (providerMapping) {
			// Preferred provider has a mapping for this model - use it
			return {
				modelId: defaultModel.id,
				canonicalName: defaultModel.canonicalName,
				displayName: defaultModel.displayName,
				provider: preferredProvider,
				providerModelId: providerMapping.providerModelId,
				selectionSource: "system_default",
				maxTokens: defaultModel.contextWindow ?? undefined,
				maxOutputTokens: defaultModel.maxOutputTokens ?? undefined,
			};
		}

		// Preferred provider doesn't have this model - find an available provider
		// This handles cases like Cerebras (no embeddings) falling back to OpenAI
		// IMPORTANT: For embedding tasks, we should NOT fall back to a different provider
		// because that would cause credential mismatch (using Azure key against OpenAI endpoint)
		if (effectiveTaskType === "EMBEDDING") {
			throw new Error(
				`[ModelSelector] Embedding provider "${preferredProvider}" does not have a model mapping for embeddings. ` +
					"Please ensure the AI model catalog is seeded with: pnpm --filter @repo/database seed:ai-models " +
					"or configure a different embedding provider that supports embeddings.",
			);
		}

		const availableMapping = defaultModel.providerMappings?.[0];
		if (availableMapping) {
			console.log(
				`[ModelSelector] Provider "${preferredProvider}" doesn't support ${effectiveTaskType}. ` +
					`Falling back to "${availableMapping.provider}" which has "${availableMapping.providerModelId}".`,
			);
			return {
				modelId: defaultModel.id,
				canonicalName: defaultModel.canonicalName,
				displayName: defaultModel.displayName,
				provider: availableMapping.provider as DbAIProvider,
				providerModelId: availableMapping.providerModelId,
				selectionSource: "system_default",
				maxTokens: defaultModel.contextWindow ?? undefined,
				maxOutputTokens: defaultModel.maxOutputTokens ?? undefined,
			};
		}

		// Model exists but has no available provider mappings
		return {
			modelId: defaultModel.id,
			canonicalName: defaultModel.canonicalName,
			displayName: defaultModel.displayName,
			provider: preferredProvider,
			providerModelId: defaultModel.canonicalName,
			selectionSource: "system_default",
			maxTokens: defaultModel.contextWindow ?? undefined,
			maxOutputTokens: defaultModel.maxOutputTokens ?? undefined,
		};
	}

	// NO HARDCODED FALLBACKS - throw a clear error instead
	// This ensures configuration issues are caught early rather than silently using wrong models
	throw new Error(
		`[ModelSelector] No model configured for provider "${preferredProvider}" and task type "${effectiveTaskType}". ` +
			"Please ensure the AI model catalog is seeded: pnpm --filter @repo/database seed:ai-models",
	);
}

/**
 * Get the model ID for a task type with context
 */
export async function getModelForTaskDynamic(
	taskType: DbAiTaskType | string,
	context: ModelResolutionContext,
	options?: {
		complexity?: DynamicTaskComplexity;
		requiresToolCalling?: boolean;
		preferredProvider?: DbAIProvider;
	},
): Promise<string> {
	const result = await selectModelDynamic(
		{
			taskType: mapTaskTypeToDb(taskType as string),
			complexity: options?.complexity,
			requiresToolCalling: options?.requiresToolCalling,
			preferredProvider: options?.preferredProvider,
		},
		context,
	);
	return result.providerModelId;
}

/**
 * Get all available models from the database catalog
 */
export async function getAvailableModels(options?: {
	family?: string;
	forTask?: DbAiTaskType;
}) {
	const models = await getActiveModels({
		family: options?.family,
	});

	if (options?.forTask) {
		return models.filter((m: { suitableForTasks: DbAiTaskType[] }) =>
			// biome-ignore lint/style/noNonNullAssertion: forTask is defined because of the truthy check above
			m.suitableForTasks.includes(options.forTask!),
		);
	}

	return models;
}

/**
 * Resolve full model configuration for AI calls
 * Returns everything needed to make an AI API call
 */
export async function resolveModelConfiguration(
	taskType: DbAiTaskType,
	context: ModelResolutionContext,
	options?: {
		complexity?: DynamicTaskComplexity;
		requiresToolCalling?: boolean;
		preferredProvider?: DbAIProvider;
	},
): Promise<{
	modelId: string;
	provider: DbAIProvider;
	providerModelId: string;
	selectionSource: string;
	contextWindow: number;
}> {
	const result = await selectModelDynamic(
		{
			taskType,
			complexity: options?.complexity,
			requiresToolCalling: options?.requiresToolCalling,
			preferredProvider: options?.preferredProvider,
		},
		context,
	);

	return {
		modelId: result.modelId,
		provider: result.provider,
		providerModelId: result.providerModelId,
		selectionSource: result.selectionSource,
		contextWindow: result.maxTokens ?? 32768,
	};
}

/**
 * Get the full model string (provider/model) for use with AI SDK
 * This is the main entry point for getting dynamically configured models
 * @example
 * // In an API route or server action:
 * const modelStr = await getConfiguredModelString("CHAT", { userId, organizationId });
 * const model = getModel(modelStr, { apiKey });
 * // With preferred provider (uses that provider's model ID if available):
 * const modelStr = await getConfiguredModelString("TOOL_CALLING", { userId }, { preferredProvider: "OPENAI_DIRECT" });
 */
export async function getConfiguredModelString(
	taskType: DbAiTaskType | string,
	context: ModelResolutionContext,
	options?: {
		complexity?: DynamicTaskComplexity;
		requiresToolCalling?: boolean;
		preferredProvider?: DbAIProvider;
	},
): Promise<string> {
	const dbTaskType = mapTaskTypeToDb(taskType as string);
	const result = await selectModelDynamic(
		{
			taskType: dbTaskType,
			complexity: options?.complexity,
			requiresToolCalling: options?.requiresToolCalling,
			preferredProvider: options?.preferredProvider,
		},
		context,
	);

	// If providerModelId already has a provider prefix (contains "/"), return as-is
	// This handles special cases like "openai/gpt-oss-120b" which already include the prefix
	if (result.providerModelId.includes("/")) {
		return result.providerModelId;
	}

	// Map database provider to AI SDK provider prefix
	const providerPrefix = mapProviderToPrefix(result.provider);

	// Return in format "provider/model" for AI SDK
	return `${providerPrefix}/${result.providerModelId}`;
}

/**
 * Map database AIProvider enum to AI SDK provider prefix.
 * IMPORTANT: This should only be called for direct providers, not gateways.
 * Gateway model IDs should already include the correct prefix (e.g., "openai/gpt-4o").
 * If a gateway provider reaches this function, it indicates a bug in the model selection logic.
 */
function mapProviderToPrefix(provider: DbAIProvider): string {
	switch (provider) {
		case "GROQ":
			return "groq";
		case "OPENAI_DIRECT":
			return "openai";
		case "ANTHROPIC_DIRECT":
			return "anthropic";
		case "DEEPSEEK":
			return "deepseek";
		case "MISTRAL_AI":
			return "mistral";
		case "TOGETHER_AI":
			return "together";
		case "COHERE":
			return "cohere";
		case "PERPLEXITY":
			return "perplexity";
		case "XAI":
			return "xai";
		case "FIREWORKS":
			return "fireworks";
		case "CEREBRAS":
			return "cerebras";
		// Gateways should never reach this point - their model IDs should already have prefixes
		// If we get here, it's a bug in the model selection logic
		case "VERCEL_GATEWAY":
		case "CLOUDFLARE_AI":
		case "OPENROUTER":
			console.error(
				`[ModelSelector] BUG: Gateway provider "${provider}" reached mapProviderToPrefix. ` +
					"Gateway model IDs should already include provider prefix. " +
					"This indicates a missing or invalid provider mapping in the database.",
			);
			// Return "openai" as a safer default than "groq" since most gateway models are OpenAI-compatible
			return "openai";
		// Cloud platforms - these typically use their own model naming
		case "AZURE_AI_FOUNDRY":
			return "azure";
		case "AWS_BEDROCK":
			return "bedrock";
		case "GOOGLE_VERTEX_AI":
			return "vertex";
		case "DATABRICKS":
			return "databricks";
		default:
			console.error(
				`[ModelSelector] Unknown provider "${provider}" in mapProviderToPrefix. ` +
					"Please add this provider to the switch statement.",
			);
			return "openai";
	}
}

/**
 * Build the provider-specific model string from a resolved `providerModelId`,
 * applying the same prefix rules used by task-default resolution:
 * - Gateway providers get a routing prefix (e.g. "openai/gpt-4o") unless present.
 * - Inference providers (Groq/Cerebras) keep the id as-is.
 * - Direct providers strip any prefix.
 *
 * Shared by the normal task-default path and the model-override path so both
 * produce identical strings.
 */
export function buildProviderModelString(
	providerModelId: string,
	provider: DbAIProvider,
): string {
	const isGateway = GATEWAY_PROVIDERS.has(provider);
	const isInferenceProvider = provider === "GROQ" || provider === "CEREBRAS";

	if (isGateway) {
		return providerModelId.includes("/")
			? providerModelId
			: `${mapProviderToPrefix(provider)}/${providerModelId}`;
	}
	if (isInferenceProvider) {
		return providerModelId;
	}
	// Direct providers: strip any prefix. `.split("/").pop()` already returns the
	// input unchanged when there is no slash, so no guard is needed.
	return providerModelId.split("/").pop() ?? providerModelId;
}

// ============================================================================
// High-Level Helper Functions
// ============================================================================

/**
 * Result from resolveModelWithProvider - contains everything needed for AI calls
 */
export interface ResolvedModelConfig {
	/** The model string to pass to getModel - already includes provider prefix if needed */
	modelString: string;
	/** The provider type (e.g., "VERCEL_GATEWAY", "OPENAI_DIRECT") */
	provider: DbAIProvider;
	/** The ENCRYPTED API key (if available) — decrypt via `resolveProviderApiKey` */
	apiKey: string | null;
	/**
	 * Service-principal client id (Databricks OAuth M2M). Set instead of
	 * `apiKey` when the tenant configured a service principal; callers must go
	 * through `resolveProviderApiKey` to mint the bearer token.
	 */
	clientId: string | null;
	/** Encrypted service-principal secret (Databricks OAuth M2M). */
	encryptedClientSecret: string | null;
	/** The base URL for providers that require it (e.g., Azure AI Foundry) */
	baseUrl: string | null;
	/** The config ID for updating last used timestamp */
	configId: string | null;
	/** Source of the provider config ("user" or "organization") */
	configSource: "user" | "organization" | null;
	/** How the model was selected */
	selectionSource: string;
	/** The canonical model name (for logging/display) */
	canonicalName: string;
	/** For Azure AI Foundry - the user-defined deployment name */
	deploymentName: string | null;
	/** Max output (completion) tokens from the catalog model, when known */
	maxOutputTokens?: number;
	/** Context-window size (total tokens) from the catalog model, when known */
	contextWindow?: number;
	/** Internal error hint (only set when resolution fails) */
	_error?: string;
}

/**
 * Resolves the model string AND provider configuration in one call.
 * This is the recommended way to get model configuration for AI calls.
 * It ensures the model is compatible with the user's configured provider.
 * @example
 * ```typescript
 * const config = await resolveModelWithProvider("SIMPLE", { userId, organizationId });
 * if (!hasProviderCredentials(config)) {
 * throw new Error("No AI provider configured");
 * }
 * const model = getModel(config.modelString, {
 * // Resolves a decrypted PAT, or mints a Databricks service-principal token
 * apiKey: await resolveProviderApiKey(config),
 * provider: config.provider
 * });
 * ```
 * @param taskType - The task type (SIMPLE, COMPLEX, CHAT, etc.)
 * @param context - User/org context for preference lookup
 * @param options - Additional options (complexity, requiresToolCalling)
 */
export async function resolveModelWithProvider(
	taskType: DbAiTaskType | string,
	context: ModelResolutionContext,
	options?: {
		complexity?: DynamicTaskComplexity;
		requiresToolCalling?: boolean;
	},
): Promise<ResolvedModelConfig> {
	const dbTaskType = mapTaskTypeToDb(taskType as string);
	const isEmbeddingTask = dbTaskType === "EMBEDDING";

	// Step 1: Get the appropriate provider configuration
	// For EMBEDDING tasks, use the dedicated embedding provider (if configured)
	// This ensures embeddings always use the same model, preventing vector incompatibility
	let providerConfig:
		| Awaited<ReturnType<typeof getEmbeddingProviderConfig>>
		| undefined;

	if (isEmbeddingTask) {
		// First try to get the dedicated embedding provider
		const embeddingProvider = await getEmbeddingProviderConfig({
			userId: context.userId,
			organizationId: context.organizationId || undefined,
		});

		if (embeddingProvider.provider) {
			providerConfig = embeddingProvider;
		} else {
			// Fall back to default provider if no embedding provider is configured
			providerConfig = await getAiProviderApiKey({
				userId: context.userId,
				organizationId: context.organizationId || undefined,
			});
		}
	} else {
		// For all other tasks, use the default provider
		providerConfig = await getAiProviderApiKey({
			userId: context.userId,
			organizationId: context.organizationId || undefined,
		});
	}

	// Step 2: Determine the preferred provider
	// Only use configured provider - no automatic fallback to gateway
	// If no provider is configured, return early with null apiKey so caller can handle appropriately
	if (!providerConfig.provider) {
		const errorMessage = isEmbeddingTask
			? "No embedding provider configured. Please set an embedding provider in Settings → AI Providers."
			: "No AI provider configured.";
		return {
			modelString: "",
			provider: "VERCEL_GATEWAY" as DbAIProvider, // Placeholder, won't be used since apiKey is null
			apiKey: null,
			clientId: null,
			encryptedClientSecret: null,
			baseUrl: null,
			configId: null,
			configSource: null,
			selectionSource: "none",
			canonicalName: "",
			deploymentName: null,
			_error: errorMessage, // Internal hint for callers
		};
	}

	// Capture deployment name early (for Azure AI Foundry)
	const finalDeploymentName = providerConfig.deploymentName ?? null;

	const preferredProvider = providerConfig.provider as DbAIProvider;

	// Step 3: Get the model string with the preferred provider
	const result = await selectModelDynamic(
		{
			taskType: dbTaskType,
			complexity: options?.complexity,
			requiresToolCalling: options?.requiresToolCalling,
			preferredProvider,
		},
		context,
	);

	// Step 4: Build the final model string
	// IMPORTANT: Model string format depends on the provider type:
	// - Gateway providers (VERCEL_GATEWAY, OPENROUTER): Need prefixes for routing (e.g., "openai/gpt-4o-mini")
	// - Inference providers (GROQ): Keep prefixes as-is - they use them to identify model families (e.g., "openai/gpt-oss-120b")
	// - Direct model providers (OPENAI_DIRECT, ANTHROPIC_DIRECT, DEEPSEEK): No prefixes (e.g., just "gpt-4o-mini")
	const isGateway = GATEWAY_PROVIDERS.has(result.provider);
	const modelString = buildProviderModelString(
		result.providerModelId,
		result.provider,
	);

	// Step 5: Validate the result
	// If we got a gateway provider but no "/" in model string, something is wrong
	if (isGateway && !modelString.includes("/")) {
		console.error(
			`[ModelSelector] Invalid model string "${modelString}" for gateway provider "${result.provider}". ` +
				`Gateway models must include provider prefix (e.g., "openai/gpt-4o"). ` +
				`This may indicate missing provider mappings in the database for model "${result.canonicalName}".`,
		);
	}

	// Step 6: Handle provider mismatch for specialized task types
	// If the selected model requires a different provider than the user's default,
	// we need to get the API key for that specific provider.
	// This happens when:
	// - User's default is CEREBRAS/GROQ/DEEPSEEK (inference providers)
	// - Task is EMBEDDING/IMAGE/AUDIO which requires OPENAI_DIRECT
	let finalApiKey = providerConfig.apiKey ?? null;
	let finalClientId = providerConfig.clientId ?? null;
	let finalEncryptedClientSecret =
		providerConfig.encryptedClientSecret ?? null;
	let finalConfigId = providerConfig.configId ?? null;
	let finalConfigSource = providerConfig.source ?? null;

	// Check if the selected model's provider differs from user's default provider
	// This can happen when:
	// 1. hardcoded_fallback: Task type (EMBEDDING/IMAGE/AUDIO) requires OpenAI but user has Cerebras default
	// 2. system_default: User selected a model (e.g., gpt-4o-mini) that only works with OpenAI
	// 3. user_preference: User selected a model from a non-default provider
	const providerMismatch = result.provider !== preferredProvider;

	// CRITICAL: For embedding tasks, provider mismatch is a fatal error
	// We cannot use Azure API key against OpenAI endpoint (or vice versa)
	// This prevents silent credential mismatch bugs
	if (isEmbeddingTask && providerMismatch) {
		console.error(
			"[ModelSelector] CRITICAL: Provider mismatch for EMBEDDING task. " +
				`Configured embedding provider: "${preferredProvider}", but model requires: "${result.provider}". ` +
				"This would cause credential mismatch. Please run: pnpm --filter @repo/database seed:ai-models",
		);
		return {
			modelString: "",
			provider: preferredProvider,
			apiKey: null,
			clientId: null,
			encryptedClientSecret: null,
			baseUrl: null,
			configId: null,
			configSource: null,
			selectionSource: "error",
			canonicalName: "",
			deploymentName: null,
			_error:
				`Embedding provider "${preferredProvider}" does not have model mappings. ` +
				"Please run: pnpm --filter @repo/database seed:ai-models",
		};
	}

	const needsFallbackKey =
		providerMismatch &&
		(result.selectionSource === "hardcoded_fallback" ||
			result.selectionSource === "system_default" ||
			result.selectionSource === "user_preference");

	// Track base URL for providers that need it (e.g., Azure AI Foundry)
	let finalBaseUrl = providerConfig.baseUrl ?? null;

	if (needsFallbackKey) {
		// Model selection requires a different provider than user's default
		// Try to get the API key for the actual provider needed
		console.log(
			`[ModelSelector] Model for ${dbTaskType} requires provider "${result.provider}" ` +
				`but user's default is "${preferredProvider}". Checking for ${result.provider} API key...`,
		);

		try {
			const fallbackProviderConfig = await getAiProviderApiKeyByProvider({
				userId: context.userId,
				organizationId: context.organizationId || undefined,
				provider: result.provider,
			});

			// A Databricks service-principal config has no apiKey, so check for
			// EITHER credential shape — an apiKey-only check would report the
			// fallback provider as unconfigured and null out a valid config.
			if (hasProviderCredentials(fallbackProviderConfig)) {
				finalApiKey = fallbackProviderConfig.apiKey;
				finalClientId = fallbackProviderConfig.clientId ?? null;
				finalEncryptedClientSecret =
					fallbackProviderConfig.encryptedClientSecret ?? null;
				finalConfigId = fallbackProviderConfig.configId ?? null;
				finalConfigSource = fallbackProviderConfig.source ?? null;
				finalBaseUrl = fallbackProviderConfig.baseUrl ?? null;
				console.log(
					`[ModelSelector] Found ${result.provider} credentials for ${dbTaskType} task`,
				);
			} else {
				console.warn(
					`[ModelSelector] No ${result.provider} credentials configured. ` +
						`${dbTaskType} tasks require ${result.provider}. ` +
						`Please configure ${result.provider} in AI Providers settings.`,
				);
				// Return null credentials so caller knows to show an error
				finalApiKey = null;
				finalClientId = null;
				finalEncryptedClientSecret = null;
				finalConfigId = null;
				finalConfigSource = null;
				finalBaseUrl = null;
			}
		} catch (error) {
			console.warn(
				`[ModelSelector] Failed to get ${result.provider} credentials:`,
				error,
			);
			finalApiKey = null;
			finalClientId = null;
			finalEncryptedClientSecret = null;
			finalBaseUrl = null;
		}
	}

	return {
		modelString,
		provider: result.provider,
		apiKey: finalApiKey,
		clientId: finalClientId,
		encryptedClientSecret: finalEncryptedClientSecret,
		baseUrl: finalBaseUrl,
		configId: finalConfigId,
		configSource: finalConfigSource,
		selectionSource: result.selectionSource,
		canonicalName: result.canonicalName,
		deploymentName: finalDeploymentName,
		maxOutputTokens: result.maxOutputTokens,
		// `DynamicModelSelectionResult.maxTokens` carries the catalog model's
		// contextWindow (see selectModelDynamic); surface it under the
		// unambiguous `contextWindow` name for output-budget clamping.
		contextWindow: result.maxTokens,
	};
}

/**
 * Validates that a model is available for a given provider.
 * Use this to check if a user's model preference is compatible with their provider
 * before attempting to use it.
 * @param canonicalName - The canonical model name (e.g., "gpt-4o-mini")
 * @param provider - The provider to check (e.g., "GROQ", "VERCEL_GATEWAY")
 * @returns true if the model has a mapping for this provider (or can be routed through it)
 */
export async function isModelAvailableForProvider(
	canonicalName: string,
	provider: DbAIProvider,
): Promise<boolean> {
	try {
		const models = await getActiveModels();
		const model = models.find(
			(m: { canonicalName: string }) => m.canonicalName === canonicalName,
		);

		if (!model) {
			return false;
		}

		// Check for direct provider mapping
		const hasDirectMapping = model.providerMappings?.some(
			(m: { provider: DbAIProvider }) => m.provider === provider,
		);
		if (hasDirectMapping) {
			return true;
		}

		// Check if provider is a gateway that can route to any of the model's providers
		if (GATEWAY_PROVIDERS.has(provider)) {
			return (
				model.providerMappings?.some((m: { provider: DbAIProvider }) =>
					canGatewayRouteToProvider(
						provider,
						m.provider as DbAIProvider,
					),
				) ?? false
			);
		}

		return false;
	} catch {
		return false;
	}
}

/**
 * Gets the list of providers that support a given model.
 * Useful for UI to show which providers a user can select for a model.
 * @param canonicalName - The canonical model name
 * @returns Array of providers that support this model
 */
export async function getProvidersForModel(
	canonicalName: string,
): Promise<DbAIProvider[]> {
	try {
		const models = await getActiveModels();
		const model = models.find(
			(m: { canonicalName: string }) => m.canonicalName === canonicalName,
		);

		if (!model || !model.providerMappings) {
			return [];
		}

		const providers: DbAIProvider[] = model.providerMappings.map(
			(m: { provider: DbAIProvider }) => m.provider,
		);

		// Also add gateways that can route to these providers
		for (const gateway of GATEWAY_PROVIDERS) {
			if (!providers.includes(gateway)) {
				const canRoute = providers.some((p) =>
					canGatewayRouteToProvider(gateway, p),
				);
				if (canRoute) {
					providers.push(gateway);
				}
			}
		}

		return providers;
	} catch {
		return [];
	}
}

// ============================================================================
// CENTRALIZED AI MODEL ACCESS - Single Entry Point
// ============================================================================

import { updateProviderLastUsed } from "@repo/database";
import { getTenantAiGatewayBillingState } from "@repo/payments";
import type { LanguageModel } from "ai";
// Import from model-factory to avoid circular dependency with index.ts
import { getEmbeddingModel, getModel } from "../model-factory";
import { isReasoningModelName } from "./databricks-compat";
import {
	hasProviderCredentials,
	hasServicePrincipalCredentials,
	resolveProviderApiKey,
} from "./databricks-oauth";
import { getAiBillingCategory } from "./usage-logging";
import {
	wrapEmbeddingModelWithUsageLogging,
	wrapModelWithUsageLogging,
} from "./usage-logging-middleware";

/**
 * Error thrown when AI provider is not configured
 */
export class AIProviderNotConfiguredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AIProviderNotConfiguredError";
	}
}

/**
 * Context for AI operations - user, organization, and optional project info.
 * `projectId` is the optional project scope: when set, the AI usage limits
 * chokepoint also evaluates project-scoped limits for this project (alongside
 * workspace-global limits). Callers operating inside a project (story AI,
 * document AI, project-scoped sidekick, etc.) should pass it through;
 * tenant-wide AI surfaces (generic chat, settings forms) leave it undefined
 * so only workspace-global limits apply.
 */
export interface AIOperationContext {
	userId: string;
	organizationId?: string;
	projectId?: string;
	/**
	 * Which user-facing AI feature this call belongs to (Fizzy #2230). Recorded
	 * on the AiUsageLog row by the usage interceptor. Optional — untagged
	 * callers write null; use a key from AI_FEATURE_KEYS.
	 */
	featureKey?: AiFeatureKey;
	/**
	 * The resolved PromptVersion id this call runs with, when the caller went
	 * through prompt resolution. Lets adoption dashboards segment outcomes by
	 * prompt version. Optional.
	 */
	promptVersionId?: string;
	/**
	 * Scheduled/background pipeline issuing this call (Fizzy #1894). Recorded
	 * on the AiUsageLog row by the usage interceptor; undefined = user-initiated.
	 * Use a key from AI_JOB_TYPES.
	 */
	jobType?: AiJobKey;
}

/**
 * Options for getting an AI model
 */
export interface GetAIModelOptions {
	/** Task type determines which model to use (SIMPLE, COMPLEX, CHAT, TOOL_CALLING, REASONING) */
	taskType: DbAiTaskType | string;
	/** Task complexity (optional, defaults to "medium") */
	complexity?: DynamicTaskComplexity;
	/** Whether the task requires tool calling capability */
	requiresToolCalling?: boolean;
	/**
	 * Override the dynamically selected model with a specific model string.
	 * When provided, uses this model instead of the task-based selection.
	 * The provider and API key are still resolved from user's configuration.
	 */
	modelOverride?: string;
}

/**
 * Metadata about the resolved AI model configuration.
 * Useful for logging, tracking usage, and debugging.
 */
export interface AIModelMetadata {
	/** The model string used (e.g., "llama-3.3-70b", "openai/gpt-4o") */
	modelString: string;
	/** The provider type (e.g., "GROQ", "VERCEL_GATEWAY", "AZURE_AI_FOUNDRY") */
	provider: DbAIProvider;
	/** Config ID for updating last used timestamp */
	configId: string | null;
	/** Source of the config ("user" or "organization") */
	configSource: "user" | "organization" | null;
	/** How the model was selected (e.g., "user_preference", "system_default", "override") */
	selectionSource: string;
	/** The canonical model name for display */
	canonicalName: string;
	/**
	 * The catalog output-token cap of the config-resolved model. Intentionally
	 * left undefined when a `modelOverride` is used — the override model's cap
	 * may differ from the config-resolved model's.
	 */
	maxOutputTokens?: number;
	/**
	 * The catalog context-window size (total tokens) of the config-resolved
	 * model. Used to clamp requested output budgets so a large input plus a
	 * large output budget can't over-ask the model's context. Intentionally
	 * left undefined when a `modelOverride` is used — same rationale as
	 * `maxOutputTokens`: the override model's context window may differ.
	 */
	contextWindow?: number;
	/** How this request is treated for platform billing */
	billingMode:
		| "included_credit"
		| "metered_stripe"
		| "platform_unbilled"
		| "external_provider";
	billingCustomerId: string | null;
}

/**
 * Result from getAIModelWithMetadata - includes both model and metadata
 */
export interface AIModelResult {
	/** Ready-to-use LanguageModel instance */
	model: LanguageModel;
	/** Metadata about the configuration (for logging, tracking, etc.) */
	metadata: AIModelMetadata;
	/**
	 * Update the provider's last used timestamp.
	 * Call this after successful AI operations to track usage.
	 * This is fire-and-forget - errors are silently ignored.
	 */
	trackUsage: () => void;
}

/**
 * Result from getAIEmbeddingModelWithMetadata
 */
export interface AIEmbeddingModelResult {
	/** Ready-to-use EmbeddingModel instance */
	model: ReturnType<typeof getEmbeddingModel>;
	/** Metadata about the configuration */
	metadata: AIModelMetadata;
	/** Update the provider's last used timestamp */
	trackUsage: () => void;
}

/**
 * GET A READY-TO-USE AI MODEL - The Single Entry Point
 * This is the RECOMMENDED way to get an AI model. It handles:
 * 1. Model resolution based on task type and user/org preferences
 * 2. API key retrieval and decryption
 * 3. Provider configuration (including baseUrl for Azure, etc.)
 * 4. Error handling with clear messages
 * @example
 * ```typescript
 * import { getAIModel } from "@repo/ai";
 * // Simple usage - just pass task type and user context
 * const model = await getAIModel(
 * { taskType: "CHAT" },
 * { userId: session.user.id, organizationId: session.session.activeOrganizationId }
 *);
 * // Use with AI SDK
 * const result = await generateText({ model, prompt: "Hello!" });
 * // For tool calling
 * const toolModel = await getAIModel(
 * { taskType: "TOOL_CALLING" },
 * { userId, organizationId }
 *);
 * // With model override (user selected from dropdown)
 * const model = await getAIModel(
 * { taskType: "CHAT", modelOverride: "claude-3-sonnet" },
 * { userId, organizationId }
 *);
 * ```
 * @param options - What kind of model you need
 * @param context - User/org context for preference lookup
 * @returns Ready-to-use LanguageModel instance
 * @throws AIProviderNotConfiguredError if no AI provider is configured
 */
export async function getAIModel(
	options: GetAIModelOptions,
	context: AIOperationContext,
): Promise<LanguageModel> {
	const result = await getAIModelWithMetadata(options, context);
	return result.model;
}

/**
 * GET AI MODEL WITH METADATA - For cases that need tracking or logging
 * Returns the model instance along with metadata about the configuration.
 * Use this when you need to:
 * - Log which model/provider was used
 * - Track usage (call trackUsage after successful operations)
 * - Debug model selection issues
 * @example
 * ```typescript
 * import { getAIModelWithMetadata } from "@repo/ai";
 * const { model, metadata, trackUsage } = await getAIModelWithMetadata(
 * { taskType: "CHAT" },
 * { userId, organizationId }
 *);
 * console.log(`Using model: ${metadata.modelString} via ${metadata.provider}`);
 * const result = await generateText({ model, prompt: "Hello!" });
 * // Track successful usage (fire-and-forget)
 * trackUsage;
 * ```
 */
export async function getAIModelWithMetadata(
	options: GetAIModelOptions,
	context: AIOperationContext,
): Promise<AIModelResult> {
	const { taskType, complexity, requiresToolCalling, modelOverride } =
		options;

	const access = await assertTenantCanUseAi({
		userId: context.userId,
		organizationId: context.organizationId,
	});

	// Step 1: Resolve model configuration (model string, API key, provider, baseUrl)
	const config = await resolveModelWithProvider(
		taskType,
		{ userId: context.userId, organizationId: context.organizationId },
		{ complexity, requiresToolCalling },
	);

	// Step 2: Validate configuration. A Databricks service-principal config has
	// no apiKey — check for either credential shape.
	if (!hasProviderCredentials(config)) {
		const errorMessage =
			config._error ||
			"No AI provider configured. Please configure an AI provider in Settings → AI Providers.";
		throw new AIProviderNotConfiguredError(errorMessage);
	}

	// Step 3: Resolve the bearer token — a decrypted PAT/API key, or a
	// workspace access token minted from a Databricks service principal.
	// Downstream sees a plain string either way.
	const decryptedApiKey = await resolveProviderApiKey(config);
	const billingState = getTenantAiGatewayBillingState({
		access,
		provider: config.provider,
		configSource: config.configSource,
	});

	// Step 4: Determine final model string (override takes precedence).
	// A modelOverride is a catalog canonical name (from the model picker), so it
	// MUST be mapped to the resolved provider's model string via the catalog —
	// otherwise a provider whose id differs from the canonical (Databricks Unity
	// AI Gateway "system.ai.claude-sonnet-5", Azure, Bedrock) receives the raw
	// canonical and rejects it. Falls back to the override as-is when it isn't a
	// catalog canonical for this provider (e.g. an already provider-specific id).
	let finalModelString = config.modelString;
	if (modelOverride) {
		const overrideProviderModelId = config.provider
			? await getProviderModelIdForCanonical(
					modelOverride,
					config.provider,
				)
			: null;
		finalModelString =
			overrideProviderModelId && config.provider
				? buildProviderModelString(
						overrideProviderModelId,
						config.provider as DbAIProvider,
					)
				: modelOverride;
	}
	const selectionSource = modelOverride ? "override" : config.selectionSource;

	// AI usage limits chokepoint (see [ai/llm-integration.md]).
	// Throws AiUsageLimitExceededError on a HARD breach so the request fails
	// BEFORE the model is constructed and the upstream provider is hit. SOFT
	// limits are evaluated post-record (see logAiUsage → recordAiUsageAndCheckOverage).
	// Do not strip — every AI invocation must route through this gate.
	await assertWithinAiUsageLimits({
		userId: context.userId,
		organizationId: context.organizationId ?? null,
		projectId: context.projectId ?? null,
		providerConfigId: config.configId,
		modelCanonicalName: modelOverride || config.canonicalName,
		taskType: mapTaskTypeToDb(taskType as string),
	});

	// Step 5: Create the model instance.
	// Resolve the "emits <think> tags" signal from the CANONICAL model identity
	// (not the provider model string, which for Databricks is an opaque serving-
	// endpoint alias like `prod-chat` that evades the R1 name patterns; Bug #1942
	// review). getModel prefers this over its own name heuristic.
	const model = getModel(finalModelString, {
		userId: context.userId,
		organizationId: context.organizationId,
		apiKey: decryptedApiKey,
		provider: config.provider,
		baseUrl: config.baseUrl,
		headers: billingState.headers ?? undefined,
		deploymentName: config.deploymentName,
		isReasoningModel: isReasoningModelName(
			modelOverride || config.canonicalName,
		),
	});

	// Step 6: Build metadata
	const metadata: AIModelMetadata = {
		modelString: finalModelString,
		provider: config.provider,
		configId: config.configId,
		configSource: config.configSource,
		selectionSource,
		canonicalName: modelOverride || config.canonicalName,
		maxOutputTokens: modelOverride ? undefined : config.maxOutputTokens,
		contextWindow: modelOverride ? undefined : config.contextWindow,
		billingMode: billingState.mode,
		billingCustomerId:
			billingState.mode === "metered_stripe"
				? (access.customerId ?? null)
				: null,
	};

	// Step 7: Create trackUsage helper
	const trackUsage = () => {
		if (config.configId && config.configSource) {
			updateProviderLastUsed({
				configId: config.configId,
				source: config.configSource,
			}).catch(() => {
				// Silently ignore - tracking is best-effort
			});
		}
	};

	// Global usage interceptor: wrap the resolved model so EVERY call it makes
	// (generate or stream, any caller) records an AiUsageLog row by construction.
	// This is the single source of truth for language-model usage — manual
	// logModelUsageAsync calls are now no-ops (see usage-logging.ts).
	const trackedModel = wrapModelWithUsageLogging(model, {
		userId: context.userId,
		organizationId: context.organizationId,
		projectId: context.projectId,
		provider: metadata.provider,
		providerModelId: metadata.modelString,
		modelCanonicalName: metadata.canonicalName ?? undefined,
		providerConfigId: metadata.configId ?? undefined,
		taskType: mapTaskTypeToDb(taskType as string),
		billingCategory: getAiBillingCategory(metadata),
		billingCustomerId: metadata.billingCustomerId,
		featureKey: context.featureKey,
		promptVersionId: context.promptVersionId,
		jobType: context.jobType,
	});

	return { model: trackedModel, metadata, trackUsage };
}

/**
 * GET A READY-TO-USE EMBEDDING MODEL - Single Entry Point for Embeddings
 * Similar to getAIModel but returns an embedding model for vector operations.
 * @example
 * ```typescript
 * import { getAIEmbeddingModel } from "@repo/ai";
 * const embeddingModel = await getAIEmbeddingModel({
 * userId: session.user.id,
 * organizationId: session.session.activeOrganizationId
 * });
 * const { embedding } = await embed({ model: embeddingModel, value: "Hello world" });
 * ```
 */
export async function getAIEmbeddingModel(
	context: AIOperationContext,
): Promise<ReturnType<typeof getEmbeddingModel>> {
	const result = await getAIEmbeddingModelWithMetadata(context);
	return result.model;
}

/**
 * GET EMBEDDING MODEL WITH METADATA - For cases that need tracking or logging
 * Returns the embedding model instance along with metadata about the configuration.
 * @example
 * ```typescript
 * import { getAIEmbeddingModelWithMetadata } from "@repo/ai";
 * const { model, metadata, trackUsage } = await getAIEmbeddingModelWithMetadata({
 * userId, organizationId
 * });
 * console.log(`Using embedding model: ${metadata.modelString}`);
 * const { embedding } = await embed({ model, value: "Hello" });
 * trackUsage;
 * ```
 */
export async function getAIEmbeddingModelWithMetadata(
	context: AIOperationContext,
): Promise<AIEmbeddingModelResult> {
	const access = await assertTenantCanUseAi({
		userId: context.userId,
		organizationId: context.organizationId,
	});

	// Use EMBEDDING task type
	const config = await resolveModelWithProvider("EMBEDDING", {
		userId: context.userId,
		organizationId: context.organizationId,
	});

	// Log embedding model selection for debugging
	console.log("[AI:Embedding] Model resolution:", {
		provider: config.provider,
		modelString: config.modelString,
		canonicalName: config.canonicalName,
		selectionSource: config.selectionSource,
		hasApiKey: !!config.apiKey,
		hasServicePrincipal: hasServicePrincipalCredentials(config),
	});

	// Validate configuration. A Databricks service-principal config has no
	// apiKey — check for either credential shape.
	if (!hasProviderCredentials(config)) {
		const errorMessage =
			config._error ||
			"No embedding provider configured. Please configure an AI provider with embedding support in Settings → AI Providers.";
		throw new AIProviderNotConfiguredError(errorMessage);
	}

	// AI usage limits chokepoint for the embedding entry point (;
	// [ai/llm-integration.md]). Embeddings don't thread `providerConfigId` /
	// `modelCanonicalName` through the public surface, so the gate matches
	// only "all providers / all models" limits — consistent with how the
	// provider is resolved downstream. Project context is forwarded when
	// the caller supplied it. Do not strip — embeddings count too.
	await assertWithinAiUsageLimits({
		userId: context.userId,
		organizationId: context.organizationId ?? null,
		projectId: context.projectId ?? null,
		taskType: "EMBEDDING",
	});

	// Resolve the bearer token (decrypted PAT, or a Databricks service-principal
	// access token) and create the model.
	const decryptedApiKey = await resolveProviderApiKey(config);
	const billingState = getTenantAiGatewayBillingState({
		access,
		provider: config.provider,
		configSource: config.configSource,
	});

	const model = getEmbeddingModel(config.modelString, {
		apiKey: decryptedApiKey,
		provider: config.provider,
		baseUrl: config.baseUrl,
		headers: billingState.headers ?? undefined,
	});

	// Build metadata
	const metadata: AIModelMetadata = {
		modelString: config.modelString,
		provider: config.provider,
		configId: config.configId,
		configSource: config.configSource,
		selectionSource: config.selectionSource,
		canonicalName: config.canonicalName,
		billingMode: billingState.mode,
		billingCustomerId:
			billingState.mode === "metered_stripe"
				? (access.customerId ?? null)
				: null,
	};

	// Create trackUsage helper
	const trackUsage = () => {
		if (config.configId && config.configSource) {
			updateProviderLastUsed({
				configId: config.configId,
				source: config.configSource,
			}).catch(() => {
				// Silently ignore - tracking is best-effort
			});
		}
	};

	// Global embedding usage interceptor — same single-source-of-truth guarantee
	// as language models. logEmbeddingUsageAsync is now a no-op (see usage-logging.ts).
	const trackedModel = wrapEmbeddingModelWithUsageLogging(model, {
		userId: context.userId,
		organizationId: context.organizationId,
		projectId: context.projectId,
		provider: metadata.provider,
		providerModelId: metadata.modelString,
		modelCanonicalName: metadata.canonicalName ?? undefined,
		providerConfigId: metadata.configId ?? undefined,
		taskType: "EMBEDDING",
		billingCategory: getAiBillingCategory(metadata),
		billingCustomerId: metadata.billingCustomerId,
		jobType: context.jobType,
	});

	return { model: trackedModel, metadata, trackUsage };
}

/**
 * Provider configuration for RAG/embedding operations
 */
export interface RAGProviderConfig {
	apiKey: string;
	provider: string | null;
	baseUrl: string | null;
	/** Enabled sub-providers (for gateway providers like Vercel AI Gateway) */
	enabledProviders: string[];
	/** Source of the configuration (user, organization, or environment) */
	source: "organization" | "user" | "environment";
	/** For Azure AI Foundry - the user-defined deployment name */
	deploymentName: string | null;
}

/**
 * GET PROVIDER CONFIG FOR RAG OPERATIONS - Single Entry Point for generateEmbeddings
 * Returns the decrypted provider configuration ready for use with generateEmbeddings
 * and other RAG functions that need apiKey/provider/baseUrl parameters.
 * This centralizes the boilerplate:
 * - Fetching provider config from database
 * - Checking for null API key
 * - Decrypting the API key
 * - Error handling with clear messages
 * @example
 * ```typescript
 * import { getRAGProviderConfig } from "@repo/ai";
 * import { generateEmbeddings } from "@repo/rag";
 * // Before (repeated in every file):
 * // const providerConfig = await getAiProviderApiKey({ userId, organizationId });
 * // if (!providerConfig?.apiKey) throw new Error("..");
 * // const apiKey = decryptApiKey(providerConfig.apiKey);
 * // await generateEmbeddings(texts, context, { apiKey, provider: providerConfig.provider,.. });
 * // After (clean and centralized):
 * const config = await getRAGProviderConfig({ userId, organizationId });
 * await generateEmbeddings(texts, { userId, organizationId }, config);
 * ```
 * @param context - User/org context for preference lookup
 * @returns Provider config with decrypted API key ready for RAG operations
 * @throws AIProviderNotConfiguredError if no AI provider is configured
 */
export async function getRAGProviderConfig(
	context: AIOperationContext,
): Promise<RAGProviderConfig> {
	// Get the full provider config directly (includes enabledProviders)
	const providerConfig = await getAiProviderApiKey({
		userId: context.userId,
		organizationId: context.organizationId || undefined,
	});

	// Validate configuration. A Databricks service-principal config has no
	// apiKey — check for either credential shape.
	if (!hasProviderCredentials(providerConfig)) {
		throw new AIProviderNotConfiguredError(
			"No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
		);
	}

	// Resolve the bearer token and return config with all fields. Consumers of
	// this config (the LangGraph agent relay route, CopilotKit's OpenAI client,
	// the AI key-exchange route) receive a ready-to-use token and need no
	// knowledge of which auth mode produced it.
	return {
		apiKey: await resolveProviderApiKey(providerConfig),
		provider: providerConfig.provider,
		baseUrl: providerConfig.baseUrl,
		enabledProviders: providerConfig.enabledProviders,
		source: providerConfig.source || "user",
		deploymentName: providerConfig.deploymentName || null,
	};
}
