"use client";

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * Provider display names for UI
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
	GROQ: "Groq",
	OPENAI_DIRECT: "OpenAI",
	ANTHROPIC_DIRECT: "Anthropic",
	DEEPSEEK: "DeepSeek",
	MISTRAL_AI: "Mistral AI",
	TOGETHER_AI: "Together AI",
	COHERE: "Cohere",
	PERPLEXITY: "Perplexity",
	XAI: "xAI",
	VERCEL_GATEWAY: "Vercel AI Gateway",
	OPENROUTER: "OpenRouter",
	CLOUDFLARE_AI: "Cloudflare AI",
	AZURE_AI_FOUNDRY: "Azure AI Foundry",
	AWS_BEDROCK: "AWS Bedrock",
	GOOGLE_VERTEX_AI: "Google Vertex AI",
	DATABRICKS: "Databricks",
};

/**
 * Provider priority for sorting (most commonly used first)
 */
const PROVIDER_PRIORITY = [
	"GROQ",
	"OPENAI_DIRECT",
	"ANTHROPIC_DIRECT",
	"DEEPSEEK",
	"MISTRAL_AI",
	"TOGETHER_AI",
];

export interface AvailableModel {
	id: string;
	canonicalName: string;
	displayName: string;
	providerModelId: string;
	provider: string;
	speedTier: string;
	qualityTier: string;
	// Extended data (from full models array)
	description?: string | null;
	family?: string;
	vendor?: string;
	contextWindow?: number;
	capabilities?: string[];
	inputCostPer1M?: number | null;
	outputCostPer1M?: number | null;
}

/**
 * Hook to fetch ONLY models available through user's configured providers
 *
 * This hook should be used instead of useAiModels when you need to show
 * models that the user actually has access to (based on their AI configuration).
 *
 * TENANT ISOLATION: This hook automatically uses the current organization context.
 * - If in org context: fetches models for the organization's configured providers
 * - If in personal context: fetches models for the user's personal providers
 *
 * You can override this behavior by passing an explicit organizationId:
 * - `undefined` (default): Auto-detect from context
 * - `null`: Force personal context
 * - `string`: Force specific organization context
 *
 * @param options - Optional configuration
 * @param options.organizationId - Override the organization context (undefined = auto-detect)
 * @param options.taskType - Filter models by task type (e.g., "CHAT", "TOOL_CALLING")
 */
export function useAvailableModels(options?: {
	organizationId?: string | null;
	taskType?: string;
}) {
	// Auto-inject organization ID from context if not explicitly provided
	const contextOrgId = useOrganizationId();
	const organizationId =
		options?.organizationId !== undefined
			? options.organizationId
			: contextOrgId;
	const taskType = options?.taskType;

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: [
			"ai-config",
			"models",
			"available",
			organizationId,
			taskType,
		],
		queryFn: async () => {
			return await orpcClient.aiConfig.models.listAvailable({
				organizationId,
				taskType,
			});
		},
		staleTime: 5 * 60 * 1000, // Cache for 5 minutes
		gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
	});

	// Get configured providers
	const configuredProviders = data?.configuredProviders ?? [];
	const defaultProvider = data?.defaultProvider ?? null;
	const providerIds = data?.providerIds ?? [];

	// Check if user has any providers configured
	const hasProviderConfigured = configuredProviders.length > 0;

	// Get models grouped by provider from the API
	const modelsByProvider = data?.modelsByProvider ?? {};

	// Sort providers by priority
	const sortedProviders = useMemo(() => {
		return Object.keys(modelsByProvider).sort((a, b) => {
			const aIndex = PROVIDER_PRIORITY.indexOf(a);
			const bIndex = PROVIDER_PRIORITY.indexOf(b);
			if (aIndex === -1 && bIndex === -1) {
				return a.localeCompare(b);
			}
			if (aIndex === -1) {
				return 1;
			}
			if (bIndex === -1) {
				return -1;
			}
			return aIndex - bIndex;
		});
	}, [modelsByProvider]);

	// Flat list of all available models with extended data
	// The API now returns extended data directly in modelsByProvider
	const models = useMemo(() => {
		const allModels: AvailableModel[] = [];
		for (const provider of sortedProviders) {
			const providerModels = modelsByProvider[provider] ?? [];
			for (const model of providerModels) {
				allModels.push({
					...model,
					provider,
				});
			}
		}
		return allModels;
	}, [modelsByProvider, sortedProviders]);

	// Find a model by canonical name or ID
	const findModel = (identifier: string): AvailableModel | undefined => {
		return models.find(
			(m) => m.id === identifier || m.canonicalName === identifier,
		);
	};

	// Get display name for a model identifier
	const getModelDisplayName = (identifier: string): string => {
		const model = findModel(identifier);
		return model?.displayName ?? identifier;
	};

	// Get the full model string (provider/providerModelId) for a canonical name
	const getModelString = (canonicalName: string): string | undefined => {
		const model = findModel(canonicalName);
		if (!model) {
			return undefined;
		}

		const providerPrefix = model.provider
			.toLowerCase()
			.replace("_direct", "");
		return `${providerPrefix}/${model.providerModelId}`;
	};

	return {
		// Raw data
		models,
		modelsByProvider,
		sortedProviders,

		// Provider info
		configuredProviders,
		defaultProvider,
		providerIds,
		hasProviderConfigured,

		// Loading state
		isLoading,
		error,
		refetch,

		// Helper functions
		findModel,
		getModelDisplayName,
		getModelString,
	};
}

/**
 * Get the provider display name
 */
export function getProviderDisplayName(provider: string): string {
	return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}
