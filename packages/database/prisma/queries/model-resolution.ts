/**
 * Centralized Model Resolution
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH FOR AI MODEL CONFIGURATION.
 *
 * All model selection should go through this module. It queries the database
 * for model configurations and returns the appropriate model for the given
 * provider and task type.
 *
 * NO HARDCODED FALLBACKS - if the database doesn't have a model configured,
 * this module throws a clear error instead of silently using a wrong model.
 *
 * Usage:
 * ```typescript
 * import { resolveModel, resolveModelString } from "@repo/database";
 *
 * // Get full model config
 * const config = await resolveModel({
 *   userId: "...",
 *   provider: "CEREBRAS",
 *   taskType: "TOOL_CALLING",
 * });
 *
 * // Get just the model string for AI SDK
 * const modelString = await resolveModelString({
 *   userId: "...",
 *   provider: "CEREBRAS",
 *   taskType: "CHAT",
 * });
 * ```
 */

import type {
	AIProvider,
	AiTaskType,
	TaskComplexity,
} from "../generated/client";
import {
	type AiProviderConfig,
	getAiProviderApiKey,
	hasProviderCredentials,
} from "./ai-gateway";
import { getModelForTask } from "./ai-models";

// ============================================================================
// Types
// ============================================================================

/**
 * Reasoning effort levels for reasoning models (e.g., DeepSeek R1, O1, O3).
 * Controls the depth of reasoning the model performs.
 */
export type ReasoningEffort = "none" | "light" | "medium" | "high";

export interface ModelResolutionParams {
	userId: string;
	organizationId?: string | null;
	taskType: AiTaskType;
	/** If not provided, will be fetched from user's default provider */
	provider?: AIProvider;
	complexity?: TaskComplexity;
	/**
	 * Reasoning effort for models that support configurable reasoning depth.
	 * - "none": No reasoning (standard mode)
	 * - "light": Quick reasoning, lower latency
	 * - "medium": Balanced reasoning (default for reasoning models)
	 * - "high": Deep analysis, higher latency and cost
	 *
	 * Only applies to reasoning-capable models (deepseek-r1, o1, o3, etc.)
	 */
	reasoningEffort?: ReasoningEffort;
	/**
	 * Pre-fetched provider config to avoid duplicate DB queries.
	 * If provided, the resolver will use this instead of fetching again.
	 * See: server-cache-react rule from Vercel React Best Practices
	 */
	_providerConfig?: AiProviderConfig;
}

export interface ResolvedModel {
	/** The canonical model name (e.g., "gpt-oss-120b") */
	canonicalName: string;
	/** The provider-specific model ID (e.g., "gpt-oss-120b" for Cerebras, "openai/gpt-oss-120b" for Groq) */
	providerModelId: string;
	/** The provider this model is for */
	provider: AIProvider;
	/** Where this model config came from */
	source: "user_override" | "org_override" | "system_default";
	/** The decrypted API key for this provider */
	apiKey?: string;
	/** The base URL for this provider (if applicable) */
	baseUrl?: string | null;
	/**
	 * Reasoning effort level for this model.
	 * Only present for reasoning-capable models.
	 */
	reasoningEffort?: ReasoningEffort;
	/**
	 * Whether this model supports reasoning mode.
	 */
	supportsReasoning?: boolean;
}

// ============================================================================
// Main Resolution Functions
// ============================================================================

/**
 * Resolve a model for a given task type and provider.
 *
 * This is the PRIMARY function for getting model configuration.
 * It queries the database and returns the appropriate model.
 *
 * @throws Error if no model is configured for the provider/task combination
 */
// Models that support reasoning mode
const REASONING_MODELS = [
	"deepseek-r1",
	"deepseek-reasoner",
	"r1-distill",
	"o1",
	"o1-mini",
	"o1-preview",
	"o3",
	"o3-mini",
	"claude-sonnet-4-thinking",
];

/**
 * Check if a model supports reasoning mode.
 */
function isReasoningModel(modelId: string): boolean {
	const lowerModelId = modelId.toLowerCase();
	return REASONING_MODELS.some(
		(rm) =>
			lowerModelId.includes(rm) ||
			lowerModelId.includes("thinking") ||
			lowerModelId.includes("reason"),
	);
}

export async function resolveModel(
	params: ModelResolutionParams,
): Promise<ResolvedModel> {
	const {
		userId,
		organizationId,
		taskType,
		complexity = "MEDIUM",
		reasoningEffort,
		_providerConfig,
	} = params;

	// Get provider - either from params, pre-fetched config, or fetch from user's default
	let provider = params.provider;
	let apiKey: string | undefined;
	let baseUrl: string | null | undefined;

	if (!provider) {
		// Use pre-fetched config if available to avoid duplicate DB queries
		// See: server-cache-react rule from Vercel React Best Practices
		const providerConfig =
			_providerConfig ??
			(await getAiProviderApiKey({
				userId,
				organizationId: organizationId ?? undefined,
			}));
		if (!providerConfig.provider) {
			throw new Error(
				`[ModelResolution] No AI provider configured for user ${userId}. ` +
					"Please configure an AI provider in Settings → AI Providers.",
			);
		}
		provider = providerConfig.provider as AIProvider;
		apiKey = providerConfig.apiKey ?? undefined;
		baseUrl = providerConfig.baseUrl;
	}

	// Query database for model
	const result = await getModelForTask(
		userId,
		provider,
		taskType,
		organizationId,
		complexity,
	);

	if (!result || !result.providerModelId) {
		throw new Error(
			`[ModelResolution] No model configured for provider "${provider}" and task type "${taskType}". ` +
				"Please ensure the AI model catalog is seeded with: pnpm --filter @repo/database seed:ai-models",
		);
	}

	// Check if model supports reasoning
	const supportsReasoning = isReasoningModel(result.providerModelId);

	// Determine reasoning effort:
	// 1. Use explicitly provided reasoning effort
	// 2. Default to "medium" for reasoning models
	// 3. Undefined for non-reasoning models
	const effectiveReasoningEffort = supportsReasoning
		? (reasoningEffort ?? "medium")
		: undefined;

	return {
		canonicalName: result.model?.canonicalName ?? result.providerModelId,
		providerModelId: result.providerModelId,
		provider,
		source: result.source,
		apiKey,
		baseUrl,
		reasoningEffort: effectiveReasoningEffort,
		supportsReasoning,
	};
}

/**
 * Resolve a model string for use with AI SDK's getModel() function.
 *
 * This handles the model string format based on provider type:
 * - Gateway providers: Model ID as-is (already has prefix like "openai/gpt-4o")
 * - Direct providers: Model ID as-is (e.g., "llama-3.3-70b", "gpt-oss-120b")
 *
 * The database stores the correct format for each provider in AiModelProviderMapping.
 *
 * @throws Error if no model is configured
 */
export async function resolveModelString(
	params: ModelResolutionParams,
): Promise<string> {
	const resolved = await resolveModel(params);
	return resolved.providerModelId;
}

/**
 * Resolve model with full provider configuration (credentials, base URL).
 *
 * Use this when you need both the model string AND the API credentials.
 *
 * IMPORTANT — `apiKey` is the ENCRYPTED stored key and is **null for a
 * Databricks service-principal config**, which authenticates by minting a
 * short-lived token instead. Callers that need a usable bearer token must pass
 * this result to `resolveProviderApiKey` from `@repo/ai` (Temporal activities
 * may import it) rather than reading `apiKey` directly. `@repo/database` cannot
 * mint the token itself without depending on `@repo/ai`, which would invert the
 * package dependency direction.
 *
 * @throws Error if no model or no credentials are configured
 */
export async function resolveModelWithCredentials(
	params: Omit<ModelResolutionParams, "provider">,
): Promise<
	// `apiKey` is omitted from the base type and re-declared: `ResolvedModel`
	// types it `string | undefined`, and intersecting that with `string | null`
	// silently collapses back to `string`, hiding the null case from callers.
	Omit<ResolvedModel, "apiKey"> & {
		apiKey: string | null;
		clientId: string | null;
		encryptedClientSecret: string | null;
	}
> {
	const {
		userId,
		organizationId,
		taskType,
		complexity = "MEDIUM",
		_providerConfig,
	} = params;

	// Use pre-fetched config if available to avoid duplicate DB queries
	// See: server-cache-react rule from Vercel React Best Practices
	const providerConfig =
		_providerConfig ??
		(await getAiProviderApiKey({
			userId,
			organizationId: organizationId ?? undefined,
		}));

	if (!providerConfig.provider) {
		throw new Error(
			`[ModelResolution] No AI provider configured for user ${userId}. ` +
				"Please configure an AI provider in Settings → AI Providers.",
		);
	}

	// Use the shared predicate, not `!apiKey`: a Databricks service-principal
	// config stores no API key (it mints short-lived tokens) and would otherwise
	// be rejected here despite being correctly configured.
	if (!hasProviderCredentials(providerConfig)) {
		throw new Error(
			`[ModelResolution] No credentials configured for provider "${providerConfig.provider}". ` +
				"Please add an API key or a service principal in Settings → AI Providers.",
		);
	}

	const provider = providerConfig.provider as AIProvider;

	// Pass pre-fetched config to resolveModel to avoid another fetch
	const resolved = await resolveModel({
		userId,
		organizationId,
		taskType,
		complexity,
		provider,
		_providerConfig: providerConfig,
	});

	return {
		...resolved,
		apiKey: providerConfig.apiKey,
		// Carried so a consumer can mint a token for a service-principal config
		// via `resolveProviderApiKey` from `@repo/ai`.
		clientId: providerConfig.clientId,
		encryptedClientSecret: providerConfig.encryptedClientSecret,
		baseUrl: providerConfig.baseUrl,
	};
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Get the model for chat/conversation tasks.
 */
export async function resolveChatModel(
	params: Omit<ModelResolutionParams, "taskType">,
) {
	return resolveModel({ ...params, taskType: "CHAT" });
}

/**
 * Get the model for tool calling tasks.
 */
export async function resolveToolCallingModel(
	params: Omit<ModelResolutionParams, "taskType">,
) {
	return resolveModel({ ...params, taskType: "TOOL_CALLING" });
}

/**
 * Get the model for embedding tasks.
 */
export async function resolveEmbeddingModel(
	params: Omit<ModelResolutionParams, "taskType">,
) {
	return resolveModel({ ...params, taskType: "EMBEDDING" });
}

/**
 * Get the model for complex/reasoning tasks.
 */
export async function resolveComplexModel(
	params: Omit<ModelResolutionParams, "taskType">,
) {
	return resolveModel({ ...params, taskType: "COMPLEX" });
}

/**
 * Get the model for simple/fast tasks.
 */
export async function resolveSimpleModel(
	params: Omit<ModelResolutionParams, "taskType">,
) {
	return resolveModel({ ...params, taskType: "SIMPLE" });
}

/**
 * Get the model for reasoning tasks with configurable effort.
 */
export async function resolveReasoningModel(
	params: Omit<ModelResolutionParams, "taskType"> & {
		reasoningEffort?: ReasoningEffort;
	},
) {
	return resolveModel({
		...params,
		taskType: "REASONING",
		reasoningEffort: params.reasoningEffort ?? "medium",
	});
}

/**
 * Check if a resolved model supports reasoning mode.
 */
export function modelSupportsReasoning(resolved: ResolvedModel): boolean {
	return resolved.supportsReasoning ?? false;
}
