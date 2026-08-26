/**
 * AI Provider Configuration - Single Source of Truth
 *
 * This module contains all AI provider definitions, capabilities, and helper functions.
 * It is the ONLY place where provider metadata should be defined.
 *
 * Import from @repo/database to use these in any part of the application.
 */

import type { AIProvider } from "../generated/client";

// ============================================================================
// Provider Categories
// ============================================================================

/**
 * Gateway providers route requests to other providers.
 * They support multiple sub-providers and model prefixes.
 */
export const GATEWAY_PROVIDERS: readonly AIProvider[] = [
	"VERCEL_GATEWAY",
	"OPENROUTER",
	"CLOUDFLARE_AI",
] as const;

/**
 * Direct providers have their own APIs and model IDs.
 */
export const DIRECT_PROVIDERS: readonly AIProvider[] = [
	"OPENAI_DIRECT",
	"ANTHROPIC_DIRECT",
	"GROQ",
	"CEREBRAS",
	"DEEPSEEK",
	"MISTRAL_AI",
	"TOGETHER_AI",
	"COHERE",
	"PERPLEXITY",
	"XAI",
	"FIREWORKS",
	"AZURE_AI_FOUNDRY",
	"GOOGLE_VERTEX_AI",
	"AWS_BEDROCK",
	"DATABRICKS",
] as const;

// ============================================================================
// Specialized Capabilities (Embedding, Image, Audio)
// ============================================================================

/**
 * Providers that natively support embedding models.
 * These providers have dedicated embedding endpoints.
 */
export const EMBEDDING_CAPABLE_PROVIDERS: readonly AIProvider[] = [
	"OPENAI_DIRECT", // text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002
	"AZURE_AI_FOUNDRY", // Azure OpenAI embeddings (text-embedding-ada-002, text-embedding-3-*)
	"GOOGLE_VERTEX_AI", // Vertex AI embeddings (textembedding-gecko, text-embedding-004)
	"COHERE", // embed-english-v3.0, embed-multilingual-v3.0
	"TOGETHER_AI", // Various embedding models
	"FIREWORKS", // nomic-embed-text, etc.
	"MISTRAL_AI", // mistral-embed
	"DATABRICKS", // databricks-gte-large-en, databricks-bge-large-en
] as const;

/**
 * Gateway providers that can route to embedding-capable sub-providers.
 */
export const GATEWAY_EMBEDDING_PROVIDERS: readonly AIProvider[] = [
	"VERCEL_GATEWAY",
	"OPENROUTER",
	"CLOUDFLARE_AI",
] as const;

/**
 * All providers that can potentially support embeddings
 * (either natively or through gateway routing)
 */
export const ALL_EMBEDDING_CAPABLE_PROVIDERS: readonly AIProvider[] = [
	...EMBEDDING_CAPABLE_PROVIDERS,
	...GATEWAY_EMBEDDING_PROVIDERS,
] as const;

/**
 * Providers that support image generation models (e.g., DALL-E, Stable Diffusion).
 */
export const IMAGE_CAPABLE_PROVIDERS: readonly AIProvider[] = [
	"OPENAI_DIRECT", // dall-e-3, dall-e-2
	"REPLICATE", // Stable Diffusion, SDXL, etc.
] as const;

/**
 * Gateway providers that can route to image generation models.
 */
export const GATEWAY_IMAGE_PROVIDERS: readonly AIProvider[] = [
	"VERCEL_GATEWAY", // Routes to OpenAI
	"OPENROUTER", // Routes to various image models
] as const;

/**
 * All providers that can potentially support image generation.
 */
export const ALL_IMAGE_CAPABLE_PROVIDERS: readonly AIProvider[] = [
	...IMAGE_CAPABLE_PROVIDERS,
	...GATEWAY_IMAGE_PROVIDERS,
] as const;

/**
 * Providers that support audio transcription models (e.g., Whisper).
 */
export const AUDIO_CAPABLE_PROVIDERS: readonly AIProvider[] = [
	"OPENAI_DIRECT", // whisper-1
	"GROQ", // whisper-large-v3
] as const;

/**
 * Gateway providers that can route to audio transcription models.
 */
export const GATEWAY_AUDIO_PROVIDERS: readonly AIProvider[] = [
	"VERCEL_GATEWAY", // Routes to OpenAI Whisper
	"OPENROUTER", // May support audio models
] as const;

/**
 * All providers that can potentially support audio transcription.
 */
export const ALL_AUDIO_CAPABLE_PROVIDERS: readonly AIProvider[] = [
	...AUDIO_CAPABLE_PROVIDERS,
	...GATEWAY_AUDIO_PROVIDERS,
] as const;

// ============================================================================
// Provider Metadata
// ============================================================================

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
	 * key. Gates the auth-mode choice in the provider settings forms and the
	 * XOR validation in the upsert procedure.
	 */
	supportsServicePrincipal?: boolean;
	clientIdPlaceholder?: string;
	clientSecretPlaceholder?: string;
}

/**
 * Complete metadata for all AI providers.
 * This is the single source of truth for provider information.
 */
export const AI_PROVIDER_METADATA: Record<AIProvider, ProviderMetadata> = {
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
	// Other providers (not commonly shown in UI but part of the enum)
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
	// Legacy providers (exist in database enum but not actively used)
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

export interface GatewaySubProvider {
	id: AIProvider;
	name: string;
	description: string;
}

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
	{
		id: "DEEPSEEK",
		name: "DeepSeek",
		description: "DeepSeek Chat, R1",
	},
	{
		id: "COHERE",
		name: "Cohere",
		description: "Command models",
	},
	{
		id: "PERPLEXITY",
		name: "Perplexity",
		description: "Search-optimized models",
	},
	{
		id: "XAI",
		name: "xAI",
		description: "Grok models",
	},
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
// Helper Functions
// ============================================================================

/**
 * Check if a provider is a gateway provider
 */
export function isGatewayProvider(provider: AIProvider): boolean {
	return (GATEWAY_PROVIDERS as readonly AIProvider[]).includes(provider);
}

/**
 * Check if a provider is a direct provider
 */
export function isDirectProvider(provider: AIProvider): boolean {
	return (DIRECT_PROVIDERS as readonly AIProvider[]).includes(provider);
}

/**
 * Check if a provider natively supports embeddings
 */
export function isEmbeddingCapableProvider(provider: AIProvider): boolean {
	return (EMBEDDING_CAPABLE_PROVIDERS as readonly AIProvider[]).includes(
		provider,
	);
}

/**
 * Check if a provider can support embeddings (native or via gateway)
 */
export function canProviderSupportEmbeddings(provider: AIProvider): boolean {
	return (ALL_EMBEDDING_CAPABLE_PROVIDERS as readonly AIProvider[]).includes(
		provider,
	);
}

/**
 * Check if a provider natively supports image generation
 */
export function isImageCapableProvider(provider: AIProvider): boolean {
	return (IMAGE_CAPABLE_PROVIDERS as readonly AIProvider[]).includes(
		provider,
	);
}

/**
 * Check if a provider can support image generation (native or via gateway)
 */
export function canProviderSupportImages(provider: AIProvider): boolean {
	return (ALL_IMAGE_CAPABLE_PROVIDERS as readonly AIProvider[]).includes(
		provider,
	);
}

/**
 * Check if a provider natively supports audio transcription
 */
export function isAudioCapableProvider(provider: AIProvider): boolean {
	return (AUDIO_CAPABLE_PROVIDERS as readonly AIProvider[]).includes(
		provider,
	);
}

/**
 * Check if a provider can support audio transcription (native or via gateway)
 */
export function canProviderSupportAudio(provider: AIProvider): boolean {
	return (ALL_AUDIO_CAPABLE_PROVIDERS as readonly AIProvider[]).includes(
		provider,
	);
}

/**
 * Get the display name for a provider
 */
export function getProviderDisplayName(provider: AIProvider): string {
	return (
		AI_PROVIDER_METADATA[provider]?.displayName ??
		provider.replace(/_/g, " ")
	);
}

/**
 * Get the full metadata for a provider
 */
export function getProviderMetadata(
	provider: AIProvider,
): ProviderMetadata | undefined {
	return AI_PROVIDER_METADATA[provider];
}

/**
 * Get all providers by category
 */
export function getProvidersByCategory(
	category: "gateway" | "direct" | "cloud",
): ProviderMetadata[] {
	return Object.values(AI_PROVIDER_METADATA).filter(
		(p) => p.category === category,
	);
}

/**
 * Extract sub-provider from a gateway model ID
 * e.g., "openai/gpt-4o" -> "openai"
 */
export function extractSubProviderFromModelId(modelId: string): string | null {
	if (modelId.includes("/")) {
		return modelId.split("/")[0];
	}
	return null;
}

/**
 * Get the list of providers for UI display
 * Returns providers sorted by category (gateways first, then direct, then cloud)
 */
export function getProvidersForDisplay(): ProviderMetadata[] {
	const categoryOrder = { gateway: 0, direct: 1, cloud: 2 };
	return Object.values(AI_PROVIDER_METADATA).sort(
		(a, b) => categoryOrder[a.category] - categoryOrder[b.category],
	);
}
