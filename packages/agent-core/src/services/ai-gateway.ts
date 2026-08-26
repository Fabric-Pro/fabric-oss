/**
 * AI Provider Configuration Utilities
 *
 * Shared utilities for AI provider configuration used by both:
 * - Temporal Orchestrator mode (via activities)
 * - Direct mode (via API routes)
 *
 * Provides unified:
 * - API key resolution (org → user → env fallback)
 * - Model initialization with proper configuration
 */

import { getModel, getRAGProviderConfig } from "@repo/ai";

// ============================================================================
// Types
// ============================================================================

export interface AIProviderConfig {
	userId: string;
	organizationId?: string;
	/** Model name - required, must come from database configuration */
	modelName: string;
}

export interface ResolvedAIConfig {
	apiKey: string;
	provider: string | null;
	baseUrl: string | null;
	enabledProviders: string[];
	source: "organization" | "user" | "environment";
}

// ============================================================================
// Functions
// ============================================================================

/**
 * Resolve AI Provider API key following priority order:
 * 1. Organization provider config (if organizationId provided)
 * 2. User provider config
 * 3. Environment variable (AI_GATEWAY_API_KEY for backwards compatibility)
 *
 * Uses centralized AI model resolution from @repo/ai.
 *
 * @throws Error if no API key is configured
 */
export async function resolveAIProviderApiKey(
	userId: string,
	organizationId?: string,
): Promise<ResolvedAIConfig> {
	try {
		// Use centralized RAG provider config
		// Note: getRAGProviderConfig() already decrypts the API key
		const config = await getRAGProviderConfig({ userId, organizationId });

		return {
			apiKey: config.apiKey, // Already decrypted by getRAGProviderConfig()
			provider: config.provider,
			baseUrl: config.baseUrl,
			enabledProviders: config.enabledProviders,
			source: config.source,
		};
	} catch {
		// Fallback to environment variable for backwards compatibility
		if (process.env.AI_GATEWAY_API_KEY) {
			return {
				apiKey: process.env.AI_GATEWAY_API_KEY,
				provider: "VERCEL_GATEWAY",
				baseUrl: null,
				enabledProviders: [],
				source: "environment",
			};
		}

		throw new Error(
			"AI Provider not configured. Please configure an AI provider in settings or set AI_GATEWAY_API_KEY environment variable.",
		);
	}
}

/**
 * Get an AI model instance with proper configuration.
 * Handles API key resolution automatically.
 *
 * @param config - AI Provider configuration
 * @returns Configured AI model instance
 * @throws Error if no API key is configured
 */
export async function getConfiguredAIModel(config: AIProviderConfig) {
	const { userId, organizationId, modelName } = config;

	if (!modelName) {
		throw new Error(
			"Model name is required. Configure a model in Settings → AI Models.",
		);
	}

	const resolved = await resolveAIProviderApiKey(userId, organizationId);

	return getModel(modelName, {
		userId,
		organizationId,
		apiKey: resolved.apiKey,
		provider: resolved.provider ?? undefined,
		baseUrl: resolved.baseUrl,
	});
}

/**
 * Check if an AI Provider is configured for a user/organization
 */
export async function isAIProviderConfigured(
	userId: string,
	organizationId?: string,
): Promise<boolean> {
	try {
		await resolveAIProviderApiKey(userId, organizationId);
		return true;
	} catch {
		return false;
	}
}
