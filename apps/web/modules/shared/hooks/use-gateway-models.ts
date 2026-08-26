"use client";

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

/**
 * Provider display names for UI
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	google: "Google",
	meta: "Meta",
	groq: "Groq",
	mistral: "Mistral AI",
	mistralai: "Mistral AI",
	deepseek: "DeepSeek",
	cohere: "Cohere",
	perplexity: "Perplexity",
	xai: "xAI",
	fireworks: "Fireworks",
	together: "Together AI",
};

export interface GatewayModel {
	id: string;
	name?: string;
	description?: string;
	provider?: string;
	contextLength?: number;
}

/**
 * Hook to fetch models directly from the configured AI gateway
 *
 * This hook fetches real-time model availability from the gateway's API,
 * ensuring the model list is always current with what's configured.
 *
 * TENANT ISOLATION: This hook automatically uses the current organization context.
 * - If in org context: fetches models for the organization's configured gateway
 * - If in personal context: fetches models for the user's personal gateway
 *
 * You can override this behavior by passing an explicit organizationId:
 * - `undefined` (default): Auto-detect from context
 * - `null`: Force personal context
 * - `string`: Force specific organization context
 *
 * Use this for:
 * - Chatbot model selector (show all available models)
 * - Any UI that needs real-time model availability
 *
 * Use useAvailableModels instead for:
 * - Settings pages (curated model list from database)
 * - Task-based model preferences
 */
// Stable empty references to avoid creating new objects on each render
const EMPTY_ARRAY: never[] = [];
const EMPTY_OBJECT: Record<string, never[]> = {};

export function useGatewayModels(options?: { organizationId?: string | null }) {
	// Auto-inject organization ID from context if not explicitly provided
	const contextOrgId = useOrganizationId();
	const organizationId =
		options?.organizationId !== undefined
			? options.organizationId
			: contextOrgId;

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: ["ai-config", "gateway-models", organizationId],
		queryFn: async () => {
			return await orpcClient.aiConfig.models.listFromGateway({
				organizationId,
			});
		},
		staleTime: 5 * 60 * 1000, // Cache for 5 minutes
		gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
	});

	// Memoize derived values to prevent infinite loops in Select components
	// Using stable empty references when data is not available
	const success = data?.success ?? false;
	const gateway = data?.gateway ?? null;
	const gatewayDisplayName = data?.gatewayDisplayName ?? null;
	const errorMessage = data?.error;

	// Memoize arrays and objects to maintain referential stability
	const providers = useMemo(
		() => data?.providers ?? EMPTY_ARRAY,
		[data?.providers],
	);
	const models = useMemo(() => data?.models ?? EMPTY_ARRAY, [data?.models]);
	const modelsByProvider = useMemo(
		() => data?.modelsByProvider ?? EMPTY_OBJECT,
		[data?.modelsByProvider],
	);

	// Sort providers alphabetically
	const sortedProviders = useMemo(() => {
		return Object.keys(modelsByProvider).sort((a, b) => {
			const aName = PROVIDER_DISPLAY_NAMES[a.toLowerCase()] || a;
			const bName = PROVIDER_DISPLAY_NAMES[b.toLowerCase()] || b;
			return aName.localeCompare(bName);
		});
	}, [modelsByProvider]);

	// Find a model by ID - memoized to prevent unnecessary re-renders
	const findModel = useCallback(
		(modelId: string): GatewayModel | undefined => {
			return models.find((m) => m.id === modelId);
		},
		[models],
	);

	// Get display name for a model ID - memoized to prevent unnecessary re-renders
	const getModelDisplayName = useCallback(
		(modelId: string): string => {
			const model = models.find((m) => m.id === modelId);
			return model?.name || modelId;
		},
		[models],
	);

	// Get provider display name - memoized to prevent unnecessary re-renders
	const getProviderDisplayName = useCallback((provider: string): string => {
		return PROVIDER_DISPLAY_NAMES[provider.toLowerCase()] || provider;
	}, []);

	return {
		// Status
		success,
		isLoading,
		error: error || errorMessage,
		refetch,

		// Gateway info
		gateway,
		gatewayDisplayName,
		hasGatewayConfigured: !!gateway,

		// Providers
		providers,
		sortedProviders,

		// Models
		models,
		modelsByProvider,

		// Helper functions
		findModel,
		getModelDisplayName,
		getProviderDisplayName,
	};
}
