/**
 * Tenant Context Types
 *
 * Multi-tenant context types for agent runtime. These types define the
 * tenant context that agents receive with each request, enabling
 * per-tenant model configuration and isolation.
 */

/**
 * Tenant context passed to agents with every request
 */
export interface TenantContext {
	/** User ID making the request */
	userId: string;

	/** Organization ID (optional - null for personal context) */
	organizationId: string | null;

	/** API key used to authenticate (for logging/auditing) */
	apiKeyId?: string;

	/** Scopes granted to the API key */
	scopes?: string[];
}

/**
 * Model configuration resolved for a specific tenant
 */
export interface TenantModelConfig {
	/** Provider name (e.g., "GROQ_DIRECT", "VERCEL_GATEWAY") */
	provider: string;

	/** Provider-specific model ID (e.g., "llama-3.3-70b-versatile") */
	providerModelId: string;

	/** Full model string for AI SDK (e.g., "groq/llama-3.3-70b-versatile") */
	modelString: string;

	/** Decrypted API key for the provider */
	apiKey: string;

	/** Optional temperature override */
	temperature?: number;

	/** Optional max tokens override */
	maxTokens?: number;

	/** Source of the configuration for auditing */
	source:
		| "user_preference"
		| "org_preference"
		| "org_enforced"
		| "system_default";

	/** Gateway base URL (if using a gateway) */
	gatewayBaseUrl?: string;
}

/**
 * Full request context including tenant and model configuration
 */
export interface AgentRequestContext {
	/** Tenant context */
	tenant: TenantContext;

	/** Resolved model configuration for the request */
	modelConfig: TenantModelConfig;

	/** Request metadata for observability */
	requestMetadata: {
		/** Unique request ID */
		requestId: string;

		/** Timestamp when request was received */
		timestamp: Date;

		/** Agent ID that is processing the request */
		agentId: string;

		/** Task type being performed */
		taskType?: string;
	};
}

/**
 * Input for agent model resolution
 */
export interface ModelResolutionInput {
	/** API key for authentication */
	apiKey: string;

	/** Task type for model selection */
	taskType:
		| "SIMPLE"
		| "COMPLEX"
		| "REASONING"
		| "CHAT"
		| "TOOL_CALLING"
		| "EMBEDDING"
		| "IMAGE"
		| "AUDIO";

	/** Optional agent ID for agent-specific overrides */
	agentId?: string;
}

/**
 * Result from model resolution
 */
export interface ModelResolutionResult {
	/** Provider identifier */
	provider: string;

	/** Provider-specific model ID */
	providerModelId: string;

	/** Full model string for AI SDK */
	modelString: string;

	/** User ID from API key */
	userId: string;

	/** Organization ID from API key (if org key) */
	organizationId: string | null;

	/** How the model was selected */
	selectionSource: "user_preference" | "org_preference" | "system_default";

	/** Cache TTL hint in seconds */
	cacheTtlSeconds: number;
}
