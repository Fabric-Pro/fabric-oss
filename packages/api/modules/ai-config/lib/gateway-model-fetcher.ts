/**
 * Gateway Model Fetcher
 *
 * Fetches available models from AI gateways dynamically via their APIs.
 * This ensures the model list is always current with what's configured in the gateway.
 *
 * Supported Gateways:
 * - Vercel AI Gateway: GET https://ai-gateway.vercel.sh/v1/models
 * - OpenRouter: GET https://openrouter.ai/api/v1/models
 */

import type { AIProvider } from "@repo/database";
import { listDatabricksModels } from "./databricks";

interface GatewayModel {
	id: string;
	name?: string;
	description?: string;
	provider?: string; // e.g., "openai", "anthropic", "groq"
	contextLength?: number;
	pricing?: {
		prompt?: number;
		completion?: number;
	};
}

interface FetchModelsResult {
	success: boolean;
	models: GatewayModel[];
	error?: string;
	cachedAt?: Date;
}

// Gateway API configurations
const GATEWAY_CONFIGS: Record<
	string,
	{
		baseUrl: string;
		modelsPath: string;
		parseResponse: (data: unknown) => GatewayModel[];
	}
> = {
	VERCEL_GATEWAY: {
		baseUrl: "https://ai-gateway.vercel.sh/v1",
		modelsPath: "/models",
		parseResponse: (data: unknown) => {
			const response = data as {
				data?: Array<{ id: string; owned_by?: string }>;
			};
			return (response.data || []).map((m) => ({
				id: m.id,
				name: m.id,
				provider: m.owned_by || extractProviderFromModelId(m.id),
			}));
		},
	},
	OPENROUTER: {
		baseUrl: "https://openrouter.ai/api/v1",
		modelsPath: "/models",
		parseResponse: (data: unknown) => {
			const response = data as {
				data?: Array<{
					id: string;
					name?: string;
					description?: string;
					context_length?: number;
					pricing?: { prompt?: string; completion?: string };
				}>;
			};
			return (response.data || []).map((m) => ({
				id: m.id,
				name: m.name || m.id,
				description: m.description,
				provider: extractProviderFromModelId(m.id),
				contextLength: m.context_length,
				pricing: m.pricing
					? {
							prompt: Number.parseFloat(m.pricing.prompt || "0"),
							completion: Number.parseFloat(
								m.pricing.completion || "0",
							),
						}
					: undefined,
			}));
		},
	},
};

/**
 * Extract provider name from model ID
 * e.g., "openai/gpt-4o" -> "openai"
 * e.g., "anthropic/claude-3-5-sonnet" -> "anthropic"
 */
function extractProviderFromModelId(modelId: string): string {
	if (modelId.includes("/")) {
		return modelId.split("/")[0].toLowerCase();
	}
	// Guess based on model name patterns
	if (modelId.startsWith("gpt-") || modelId.startsWith("o1")) {
		return "openai";
	}
	if (modelId.startsWith("claude")) {
		return "anthropic";
	}
	if (modelId.includes("llama") || modelId.includes("mixtral")) {
		return "meta";
	}
	if (modelId.includes("mistral")) {
		return "mistral";
	}
	if (modelId.includes("deepseek")) {
		return "deepseek";
	}
	if (modelId.includes("gemini")) {
		return "google";
	}
	return "unknown";
}

/**
 * Map gateway provider names to our AIProvider enum
 */
function mapToAIProvider(gatewayProvider: string): AIProvider | null {
	const mapping: Record<string, AIProvider> = {
		openai: "OPENAI_DIRECT" as AIProvider,
		anthropic: "ANTHROPIC_DIRECT" as AIProvider,
		google: "GOOGLE_VERTEX_AI" as AIProvider,
		meta: "GROQ" as AIProvider, // Meta models typically via Groq
		groq: "GROQ" as AIProvider,
		mistral: "MISTRAL_AI" as AIProvider,
		mistralai: "MISTRAL_AI" as AIProvider,
		deepseek: "DEEPSEEK" as AIProvider,
		cohere: "COHERE" as AIProvider,
		perplexity: "PERPLEXITY" as AIProvider,
		xai: "XAI" as AIProvider,
		fireworks: "FIREWORKS" as AIProvider,
		together: "TOGETHER_AI" as AIProvider,
		databricks: "DATABRICKS" as AIProvider,
	};
	return mapping[gatewayProvider.toLowerCase()] || null;
}

// Simple in-memory cache
const modelCache = new Map<
	string,
	{ models: GatewayModel[]; fetchedAt: Date }
>();
const CACHE_TTL_MS = 1 * 60 * 1000; // 1 minute (reduced for faster updates during config changes)

/**
 * Fetch models from a gateway API
 */
export async function fetchGatewayModels(
	gateway: AIProvider,
	apiKey: string,
	options?: { baseUrl?: string },
): Promise<FetchModelsResult> {
	// Databricks lists serving endpoints via the native REST API
	// (GET <host>/api/2.0/serving-endpoints), not an OpenAI-style /models path,
	// and needs the tenant's workspace host.
	if (gateway === "DATABRICKS") {
		return fetchDatabricksModels(apiKey, options?.baseUrl);
	}

	const config = GATEWAY_CONFIGS[gateway];
	if (!config) {
		return {
			success: false,
			models: [],
			error: `Gateway ${gateway} does not support model fetching`,
		};
	}

	// Check cache
	const cacheKey = `${gateway}:${apiKey.substring(0, 8)}`;
	const cached = modelCache.get(cacheKey);
	if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
		return {
			success: true,
			models: cached.models,
			cachedAt: cached.fetchedAt,
		};
	}

	try {
		const url = `${config.baseUrl}${config.modelsPath}`;
		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			const errorText = await response.text();
			return {
				success: false,
				models: [],
				error: `Gateway API error: ${response.status} - ${errorText}`,
			};
		}

		const data = await response.json();
		const parsedModels = config.parseResponse(data);

		// Deduplicate models by ID (gateway APIs sometimes return duplicates)
		const seenIds = new Set<string>();
		const models = parsedModels.filter((model) => {
			if (seenIds.has(model.id)) {
				return false;
			}
			seenIds.add(model.id);
			return true;
		});

		// Update cache
		modelCache.set(cacheKey, { models, fetchedAt: new Date() });

		return {
			success: true,
			models,
			cachedAt: new Date(),
		};
	} catch (error) {
		return {
			success: false,
			models: [],
			error: `Failed to fetch models: ${error instanceof Error ? error.message : "Unknown error"}`,
		};
	}
}

/**
 * Fetch a Databricks workspace's serving endpoints as gateway models.
 * `apiKey` must be the decrypted PAT; `baseUrl` is the workspace host.
 */
async function fetchDatabricksModels(
	apiKey: string,
	baseUrl?: string,
): Promise<FetchModelsResult> {
	if (!baseUrl) {
		return {
			success: false,
			models: [],
			error: "Databricks requires a workspace URL",
		};
	}

	const cacheKey = `DATABRICKS:${baseUrl}:${apiKey.substring(0, 8)}`;
	const cached = modelCache.get(cacheKey);
	if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
		return {
			success: true,
			models: cached.models,
			cachedAt: cached.fetchedAt,
		};
	}

	const result = await listDatabricksModels(baseUrl, apiKey);
	if (!result.ok) {
		return {
			success: false,
			models: [],
			error: `Databricks API error: ${result.message}`,
		};
	}

	const models: GatewayModel[] = result.models.map((name) => ({
		id: name,
		name,
		provider: "databricks",
	}));

	modelCache.set(cacheKey, { models, fetchedAt: new Date() });
	return { success: true, models, cachedAt: new Date() };
}

/**
 * Get unique providers from gateway models
 */
export function getProvidersFromGatewayModels(
	models: GatewayModel[],
): AIProvider[] {
	const providers = new Set<AIProvider>();
	for (const model of models) {
		if (model.provider) {
			const aiProvider = mapToAIProvider(model.provider);
			if (aiProvider) {
				providers.add(aiProvider);
			}
		}
	}
	return Array.from(providers);
}

/**
 * Group gateway models by provider
 */
export function groupModelsByProvider(
	models: GatewayModel[],
): Record<string, GatewayModel[]> {
	const grouped: Record<string, GatewayModel[]> = {};
	for (const model of models) {
		const provider = model.provider || "unknown";
		if (!grouped[provider]) {
			grouped[provider] = [];
		}
		grouped[provider].push(model);
	}
	return grouped;
}

/**
 * Check if a gateway supports dynamic model fetching
 */
export function supportsModelFetching(gateway: AIProvider): boolean {
	return gateway === "DATABRICKS" || gateway in GATEWAY_CONFIGS;
}
