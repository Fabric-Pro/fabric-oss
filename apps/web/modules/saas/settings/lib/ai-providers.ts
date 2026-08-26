/**
 * AI Provider Configuration for Frontend (Client-Side)
 *
 * This module contains AI provider constants for use in client components.
 * It mirrors the definitions in @repo/database/ai-provider-config but is
 * self-contained to avoid importing server-side code (Prisma, pg, etc.)
 *
 * IMPORTANT: Keep this file in sync with packages/database/prisma/queries/ai-provider-config.ts
 * When adding new providers, update both files.
 */

import {
	BrainCircuitIcon,
	CloudIcon,
	type LucideIcon,
	ServerIcon,
	ZapIcon,
} from "lucide-react";

// ============================================================================
// Provider Types
// ============================================================================

type AIProvider =
	| "VERCEL_GATEWAY"
	| "CLOUDFLARE_AI"
	| "OPENROUTER"
	| "NETLIFY"
	| "AZURE_AI_FOUNDRY"
	| "AZURE_OPENAI"
	| "AWS_BEDROCK"
	| "GOOGLE_VERTEX_AI"
	| "DATABRICKS"
	| "OPENAI_DIRECT"
	| "ANTHROPIC_DIRECT"
	| "GROQ"
	| "TOGETHER_AI"
	| "DEEPSEEK"
	| "COHERE"
	| "MISTRAL_AI"
	| "FIREWORKS"
	| "PERPLEXITY"
	| "XAI"
	| "CEREBRAS"
	| "REPLICATE"
	| "HUGGINGFACE"
	| "HYBRID"
	| "CUSTOM";

export interface ProviderMetadata {
	id: AIProvider;
	name: string;
	displayName: string;
	category: "gateway" | "direct" | "cloud";
	description: string;
	baseUrl: string;
	keyPrefix: string;
	keyPlaceholder: string;
	docsUrl: string;
	requiresBaseUrl: boolean;
	baseUrlPlaceholder?: string;
	baseUrlHelp?: string;
	/**
	 * True when the provider can authenticate with an OAuth M2M service
	 * principal (client ID + client secret) as an alternative to a static API
	 * key. Gates the auth-mode choice in the provider settings forms.
	 */
	supportsServicePrincipal?: boolean;
	clientIdPlaceholder?: string;
	clientSecretPlaceholder?: string;
}

export interface ProviderWithIcon extends ProviderMetadata {
	icon: LucideIcon;
}

export interface GatewaySubProvider {
	id: AIProvider;
	name: string;
	description: string;
}

// ============================================================================
// Embedding Capabilities
// ============================================================================

/**
 * Providers that natively support embedding models.
 */
const EMBEDDING_CAPABLE_PROVIDERS: readonly AIProvider[] = [
	"OPENAI_DIRECT",
	"AZURE_AI_FOUNDRY",
	"GOOGLE_VERTEX_AI",
	"COHERE",
	"TOGETHER_AI",
	"FIREWORKS",
	"MISTRAL_AI",
	"DATABRICKS",
] as const;

/**
 * Gateway providers that can route to embedding-capable sub-providers.
 */
const GATEWAY_EMBEDDING_PROVIDERS: readonly AIProvider[] = [
	"VERCEL_GATEWAY",
	"OPENROUTER",
	"CLOUDFLARE_AI",
] as const;

// ============================================================================
// Provider Metadata (UI-relevant subset)
// ============================================================================

/**
 * Complete metadata for commonly used AI providers.
 * Focused on providers shown in the UI settings page.
 */
const AI_PROVIDER_METADATA: Record<AIProvider, ProviderMetadata> = {
	// AI Gateways
	VERCEL_GATEWAY: {
		id: "VERCEL_GATEWAY",
		name: "Vercel AI Gateway",
		displayName: "Vercel AI Gateway",
		category: "gateway",
		description:
			"Unified access to multiple AI providers with caching and rate limiting",
		baseUrl: "https://ai-gateway.vercel.sh/v1",
		keyPrefix: "vck_",
		keyPlaceholder: "vck_...",
		docsUrl: "https://vercel.com/dashboard/ai/gateway",
		requiresBaseUrl: false,
	},
	OPENROUTER: {
		id: "OPENROUTER",
		name: "OpenRouter",
		displayName: "OpenRouter",
		category: "gateway",
		description:
			"Access to 100+ models from multiple providers with unified API",
		baseUrl: "https://openrouter.ai/api/v1",
		keyPrefix: "sk-or-",
		keyPlaceholder: "sk-or-...",
		docsUrl: "https://openrouter.ai/keys",
		requiresBaseUrl: false,
	},
	CLOUDFLARE_AI: {
		id: "CLOUDFLARE_AI",
		name: "Cloudflare AI Gateway",
		displayName: "Cloudflare AI",
		category: "gateway",
		description:
			"Cloudflare's AI Gateway with caching, rate limiting, and analytics",
		baseUrl: "",
		keyPrefix: "",
		keyPlaceholder: "Cloudflare API Token",
		docsUrl: "https://developers.cloudflare.com/ai-gateway/",
		requiresBaseUrl: true,
		baseUrlPlaceholder:
			"https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai",
		baseUrlHelp:
			"Find your Gateway URL in the Cloudflare dashboard under AI > Gateway",
	},
	HYBRID: {
		id: "HYBRID",
		name: "Hybrid",
		displayName: "Hybrid",
		category: "gateway",
		description: "Hybrid configuration using multiple providers",
		baseUrl: "",
		keyPrefix: "",
		keyPlaceholder: "",
		docsUrl: "",
		requiresBaseUrl: false,
	},
	// Direct Providers
	OPENAI_DIRECT: {
		id: "OPENAI_DIRECT",
		name: "OpenAI",
		displayName: "OpenAI",
		category: "direct",
		description: "Direct access to GPT-4, GPT-4o, and other OpenAI models",
		baseUrl: "https://api.openai.com/v1",
		keyPrefix: "sk-",
		keyPlaceholder: "sk-...",
		docsUrl: "https://platform.openai.com/api-keys",
		requiresBaseUrl: false,
	},
	ANTHROPIC_DIRECT: {
		id: "ANTHROPIC_DIRECT",
		name: "Anthropic",
		displayName: "Anthropic",
		category: "direct",
		description:
			"Direct access to Claude 3.5 Sonnet, Haiku, and Opus models",
		baseUrl: "https://api.anthropic.com/v1",
		keyPrefix: "sk-ant-",
		keyPlaceholder: "sk-ant-...",
		docsUrl: "https://console.anthropic.com/settings/keys",
		requiresBaseUrl: false,
	},
	GROQ: {
		id: "GROQ",
		name: "Groq",
		displayName: "Groq",
		category: "direct",
		description:
			"Ultra-fast inference with Llama, Mixtral, and Gemma models",
		baseUrl: "https://api.groq.com/openai/v1",
		keyPrefix: "gsk_",
		keyPlaceholder: "gsk_...",
		docsUrl: "https://console.groq.com/keys",
		requiresBaseUrl: false,
	},
	CEREBRAS: {
		id: "CEREBRAS",
		name: "Cerebras",
		displayName: "Cerebras",
		category: "direct",
		description: "Ultra-fast inference on Cerebras Wafer-Scale hardware",
		baseUrl: "https://api.cerebras.ai/v1",
		keyPrefix: "csk-",
		keyPlaceholder: "csk-...",
		docsUrl: "https://cloud.cerebras.ai/",
		requiresBaseUrl: false,
	},
	TOGETHER_AI: {
		id: "TOGETHER_AI",
		name: "Together AI",
		displayName: "Together AI",
		category: "direct",
		description: "Open-source models including Llama, Mixtral, and more",
		baseUrl: "https://api.together.xyz/v1",
		keyPrefix: "",
		keyPlaceholder: "API key",
		docsUrl: "https://api.together.ai/settings/api-keys",
		requiresBaseUrl: false,
	},
	DEEPSEEK: {
		id: "DEEPSEEK",
		name: "DeepSeek",
		displayName: "DeepSeek",
		category: "direct",
		description: "DeepSeek Chat and R1 reasoning models",
		baseUrl: "https://api.deepseek.com/v1",
		keyPrefix: "sk-",
		keyPlaceholder: "sk-...",
		docsUrl: "https://platform.deepseek.com/api_keys",
		requiresBaseUrl: false,
	},
	MISTRAL_AI: {
		id: "MISTRAL_AI",
		name: "Mistral AI",
		displayName: "Mistral AI",
		category: "direct",
		description: "Mistral Large, Medium, and Small models",
		baseUrl: "https://api.mistral.ai/v1",
		keyPrefix: "",
		keyPlaceholder: "API key",
		docsUrl: "https://console.mistral.ai/api-keys",
		requiresBaseUrl: false,
	},
	FIREWORKS: {
		id: "FIREWORKS",
		name: "Fireworks AI",
		displayName: "Fireworks",
		category: "direct",
		description: "Fast, cost-effective open-source model hosting",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		keyPrefix: "fw_",
		keyPlaceholder: "fw_...",
		docsUrl: "https://fireworks.ai/api-keys",
		requiresBaseUrl: false,
	},
	PERPLEXITY: {
		id: "PERPLEXITY",
		name: "Perplexity",
		displayName: "Perplexity",
		category: "direct",
		description: "Models optimized for search and research tasks",
		baseUrl: "https://api.perplexity.ai",
		keyPrefix: "pplx-",
		keyPlaceholder: "pplx-...",
		docsUrl: "https://www.perplexity.ai/settings/api",
		requiresBaseUrl: false,
	},
	COHERE: {
		id: "COHERE",
		name: "Cohere",
		displayName: "Cohere",
		category: "direct",
		description: "Command models for enterprise applications",
		baseUrl: "https://api.cohere.ai/v1",
		keyPrefix: "",
		keyPlaceholder: "API key",
		docsUrl: "https://dashboard.cohere.ai/api-keys",
		requiresBaseUrl: false,
	},
	XAI: {
		id: "XAI",
		name: "xAI (Grok)",
		displayName: "xAI",
		category: "direct",
		description: "Grok models from xAI",
		baseUrl: "https://api.x.ai/v1",
		keyPrefix: "",
		keyPlaceholder: "API key",
		docsUrl: "https://console.x.ai/",
		requiresBaseUrl: false,
	},
	REPLICATE: {
		id: "REPLICATE",
		name: "Replicate",
		displayName: "Replicate",
		category: "direct",
		description: "Run open-source machine learning models",
		baseUrl: "https://api.replicate.com/v1",
		keyPrefix: "r8_",
		keyPlaceholder: "r8_...",
		docsUrl: "https://replicate.com/account/api-tokens",
		requiresBaseUrl: false,
	},
	HUGGINGFACE: {
		id: "HUGGINGFACE",
		name: "Hugging Face",
		displayName: "Hugging Face",
		category: "direct",
		description: "Access models from Hugging Face Hub",
		baseUrl: "https://api-inference.huggingface.co",
		keyPrefix: "hf_",
		keyPlaceholder: "hf_...",
		docsUrl: "https://huggingface.co/settings/tokens",
		requiresBaseUrl: false,
	},
	CUSTOM: {
		id: "CUSTOM",
		name: "Custom",
		displayName: "Custom",
		category: "direct",
		description: "Custom AI provider configuration",
		baseUrl: "",
		keyPrefix: "",
		keyPlaceholder: "API key",
		docsUrl: "",
		requiresBaseUrl: true,
		baseUrlPlaceholder: "https://your-api-endpoint.com/v1",
		baseUrlHelp: "Enter your custom API endpoint",
	},
	// Cloud Providers
	AZURE_AI_FOUNDRY: {
		id: "AZURE_AI_FOUNDRY",
		name: "Azure AI Foundry",
		displayName: "Azure AI Foundry",
		category: "cloud",
		description: "Azure OpenAI and other AI models via Azure",
		baseUrl: "",
		keyPrefix: "",
		keyPlaceholder: "Azure API key",
		docsUrl:
			"https://azure.microsoft.com/en-us/products/ai-services/openai-service",
		requiresBaseUrl: true,
		baseUrlPlaceholder: "https://{resource-name}.openai.azure.com",
		baseUrlHelp: "Your Azure OpenAI resource endpoint",
	},
	GOOGLE_VERTEX_AI: {
		id: "GOOGLE_VERTEX_AI",
		name: "Google Vertex AI",
		displayName: "Google Vertex AI",
		category: "cloud",
		description: "Gemini and other Google AI models via Vertex AI",
		baseUrl: "",
		keyPrefix: "",
		keyPlaceholder: "Service account JSON or API key",
		docsUrl: "https://cloud.google.com/vertex-ai/docs",
		requiresBaseUrl: true,
		baseUrlPlaceholder: "https://{region}-aiplatform.googleapis.com",
		baseUrlHelp: "Your Vertex AI regional endpoint",
	},
	AWS_BEDROCK: {
		id: "AWS_BEDROCK",
		name: "AWS Bedrock",
		displayName: "AWS Bedrock",
		category: "cloud",
		description: "Access to multiple AI models via AWS Bedrock",
		baseUrl: "",
		keyPrefix: "",
		keyPlaceholder: "AWS credentials",
		docsUrl: "https://aws.amazon.com/bedrock/",
		requiresBaseUrl: true,
		baseUrlPlaceholder: "https://bedrock-runtime.{region}.amazonaws.com",
		baseUrlHelp: "Configure via AWS credentials",
	},
	DATABRICKS: {
		id: "DATABRICKS",
		name: "Databricks",
		displayName: "Databricks",
		category: "cloud",
		description:
			"Databricks Model Serving (Mosaic AI Gateway) — OpenAI-compatible Foundation Model and custom serving endpoints",
		baseUrl: "",
		keyPrefix: "dapi",
		keyPlaceholder: "dapi...",
		docsUrl:
			"https://docs.databricks.com/en/machine-learning/model-serving/index.html",
		requiresBaseUrl: true,
		baseUrlPlaceholder: "https://{workspace-id}.cloud.databricks.com",
		baseUrlHelp:
			"Your Databricks workspace URL — a bare host defaults to /serving-endpoints. Advanced: enter a full path like /ai-gateway/mlflow/v1 to use the Unity AI Gateway.",
		supportsServicePrincipal: true,
		clientIdPlaceholder: "00000000-0000-0000-0000-000000000000",
		clientSecretPlaceholder: "dose...",
	},
	AZURE_OPENAI: {
		id: "AZURE_OPENAI",
		name: "Azure OpenAI (Legacy)",
		displayName: "Azure OpenAI (Legacy)",
		category: "cloud",
		description:
			"Legacy Azure OpenAI provider - use AZURE_AI_FOUNDRY instead",
		baseUrl: "",
		keyPrefix: "",
		keyPlaceholder: "Azure OpenAI API Key",
		docsUrl: "https://learn.microsoft.com/en-us/azure/ai-services/openai/",
		requiresBaseUrl: true,
		baseUrlPlaceholder: "https://your-resource.openai.azure.com",
		baseUrlHelp: "Your Azure OpenAI endpoint URL",
	},
	NETLIFY: {
		id: "NETLIFY",
		name: "Netlify",
		displayName: "Netlify",
		category: "gateway",
		description: "Netlify AI Gateway for serverless deployments",
		baseUrl: "",
		keyPrefix: "",
		keyPlaceholder: "Netlify API Token",
		docsUrl: "https://docs.netlify.com/",
		requiresBaseUrl: false,
	},
};

// ============================================================================
// Gateway Sub-Providers
// ============================================================================

/**
 * Sub-providers that can be enabled within AI gateways.
 */
export const GATEWAY_SUB_PROVIDERS: readonly GatewaySubProvider[] = [
	{
		id: "OPENAI_DIRECT",
		name: "OpenAI",
		description: "GPT-4o, GPT-4, GPT-3.5",
	},
	{
		id: "ANTHROPIC_DIRECT",
		name: "Anthropic",
		description: "Claude 3.5, Claude 3, Claude 2",
	},
	{
		id: "GROQ",
		name: "Groq",
		description: "Llama, Mixtral, Gemma - Fast inference",
	},
	{
		id: "GOOGLE_VERTEX_AI",
		name: "Google",
		description: "Gemini models",
	},
	{
		id: "MISTRAL_AI",
		name: "Mistral AI",
		description: "Mistral Large, Medium, Small",
	},
	{ id: "DEEPSEEK", name: "DeepSeek", description: "DeepSeek Chat, R1" },
	{ id: "COHERE", name: "Cohere", description: "Command models" },
	{
		id: "PERPLEXITY",
		name: "Perplexity",
		description: "Search-optimized models",
	},
	{ id: "XAI", name: "xAI", description: "Grok models" },
	{
		id: "TOGETHER_AI",
		name: "Together AI",
		description: "Open-source models",
	},
	{
		id: "FIREWORKS",
		name: "Fireworks",
		description: "Fast open-source model hosting",
	},
	{
		id: "CEREBRAS",
		name: "Cerebras",
		description: "Ultra-fast Llama and Qwen models",
	},
] as const;

// ============================================================================
// Icon Mapping
// ============================================================================

/**
 * Map of provider IDs to their icons.
 * Gateways use CloudIcon, fast inference uses ZapIcon, others use BrainCircuitIcon.
 */
const PROVIDER_ICONS: Record<AIProvider, LucideIcon> = {
	// Gateways
	VERCEL_GATEWAY: CloudIcon,
	OPENROUTER: CloudIcon,
	CLOUDFLARE_AI: CloudIcon,
	NETLIFY: CloudIcon,
	HYBRID: CloudIcon,
	// Fast inference providers
	GROQ: ZapIcon,
	CEREBRAS: ZapIcon,
	FIREWORKS: ZapIcon,
	// Cloud providers
	AZURE_AI_FOUNDRY: ServerIcon,
	AZURE_OPENAI: ServerIcon,
	GOOGLE_VERTEX_AI: ServerIcon,
	AWS_BEDROCK: ServerIcon,
	DATABRICKS: ServerIcon,
	// Direct providers (default)
	OPENAI_DIRECT: BrainCircuitIcon,
	ANTHROPIC_DIRECT: BrainCircuitIcon,
	TOGETHER_AI: ServerIcon,
	DEEPSEEK: BrainCircuitIcon,
	MISTRAL_AI: BrainCircuitIcon,
	PERPLEXITY: BrainCircuitIcon,
	COHERE: BrainCircuitIcon,
	XAI: BrainCircuitIcon,
	// Other providers
	REPLICATE: ServerIcon,
	HUGGINGFACE: BrainCircuitIcon,
	CUSTOM: ServerIcon,
};

/**
 * Get the icon for a provider
 */
function getProviderIcon(provider: AIProvider): LucideIcon {
	return PROVIDER_ICONS[provider] || BrainCircuitIcon;
}

// ============================================================================
// Helper Functions
// ============================================================================

// ============================================================================
// Enhanced Provider Lists
// ============================================================================

/**
 * All providers with their icons attached
 */
function getProvidersWithIcons(): ProviderWithIcon[] {
	return Object.values(AI_PROVIDER_METADATA).map((metadata) => ({
		...metadata,
		icon: getProviderIcon(metadata.id),
	}));
}

/**
 * Get gateway providers with icons (commonly shown in UI)
 * Excludes HYBRID as it's not typically configured directly
 */
export function getGatewayProviders(): ProviderWithIcon[] {
	return getProvidersWithIcons().filter(
		(p) => p.category === "gateway" && p.id !== "HYBRID",
	);
}

/**
 * Get direct providers with icons (commonly shown in UI)
 * Excludes REPLICATE, HUGGINGFACE, CUSTOM as they're not commonly used
 */
export function getDirectProviders(): ProviderWithIcon[] {
	const excludedProviders = ["REPLICATE", "HUGGINGFACE", "CUSTOM"];
	return getProvidersWithIcons().filter(
		(p) => p.category === "direct" && !excludedProviders.includes(p.id),
	);
}

/**
 * Get cloud providers with icons
 */
export function getCloudProviders(): ProviderWithIcon[] {
	return getProvidersWithIcons().filter((p) => p.category === "cloud");
}

// ============================================================================
// Embedding Capability Check
// ============================================================================

interface ConfiguredProvider {
	provider: string;
	displayName: string | null;
	isDefault: boolean;
	isEmbeddingProvider: boolean;
	source: string;
}

interface ConfigStatus {
	configuredProviders: ConfiguredProvider[];
	embeddingProvider: string | null;
}

/**
 * Check if a provider can support embeddings.
 *
 * For direct providers: checks if they're in EMBEDDING_CAPABLE_PROVIDERS
 * For gateways: checks if they're configured (gateways can route to embedding providers)
 *
 * @param providerId - The provider ID to check
 * @param configStatus - Optional config status to check if gateway is configured
 */
export function canProviderSupportEmbeddings(
	providerId: string,
	configStatus?: ConfigStatus | null,
): boolean {
	// Direct embedding-capable providers always return true
	if (
		(EMBEDDING_CAPABLE_PROVIDERS as readonly string[]).includes(providerId)
	) {
		return true;
	}

	// For gateways, check if they're configured
	if (
		(GATEWAY_EMBEDDING_PROVIDERS as readonly string[]).includes(providerId)
	) {
		// If we have config status, check if the gateway is configured
		if (configStatus) {
			const isConfigured = configStatus.configuredProviders.some(
				(p) => p.provider === providerId,
			);
			return isConfigured;
		}
		// If no config status but it's a gateway, it can potentially support embeddings
		return true;
	}

	return false;
}

// ============================================================================
// Authentication Modes
// ============================================================================

/**
 * How a provider config authenticates. Providers flagged
 * `supportsServicePrincipal` (currently Databricks) accept either mode; every
 * other provider is API-key only.
 *
 * The two modes are mutually exclusive by design — the upsert procedure
 * rejects a payload carrying both, and stores exactly one, nulling the other.
 */
export type AuthMode = "apiKey" | "servicePrincipal";

/**
 * True when the chosen mode is service-principal AND the provider actually
 * supports it. Guards against a stale `authMode` left over from configuring a
 * different provider in the same dialog session.
 */
export function isServicePrincipalMode(
	provider: Pick<ProviderMetadata, "supportsServicePrincipal"> | null,
	authMode: AuthMode,
): boolean {
	return (
		authMode === "servicePrincipal" && !!provider?.supportsServicePrincipal
	);
}

/**
 * True when the form holds a complete credential for the chosen mode: an API
 * key, or BOTH halves of a service principal. Used to gate the Test and Save
 * buttons so the server-side XOR validation is never the first feedback a user
 * sees.
 */
export function hasCompleteCredentials(args: {
	provider: Pick<ProviderMetadata, "supportsServicePrincipal"> | null;
	authMode: AuthMode;
	apiKey: string;
	clientId: string;
	clientSecret: string;
}): boolean {
	if (isServicePrincipalMode(args.provider, args.authMode)) {
		return (
			args.clientId.trim().length > 0 &&
			args.clientSecret.trim().length > 0
		);
	}
	return args.apiKey.trim().length > 0;
}
