/**
 * Reranker Configuration
 *
 * Centralized configuration for reranking providers.
 * Uses environment variables with sensible defaults.
 */

import type { RerankerConfig, RerankerProviderType } from "./types";
import { RERANKER_MODELS } from "./types";

/**
 * Get the default reranker provider from environment
 */
export function getDefaultRerankerProvider(): RerankerProviderType {
	const provider = process.env.RERANKER_PROVIDER?.toLowerCase();
	if (provider === "cohere") {
		return "cohere";
	}
	// Default to cross-encoder (free, self-hosted)
	return "cross-encoder";
}

/**
 * Get Cohere API key from environment
 */
export function getCohereApiKey(): string | undefined {
	return process.env.COHERE_API_KEY;
}

/**
 * Check if Cohere provider is available (has API key)
 */
export function isCohereAvailable(): boolean {
	const apiKey = getCohereApiKey();
	return !!apiKey && apiKey.length > 0;
}

/**
 * Get the appropriate reranker config based on environment and preferences
 *
 * @param preferredProvider - Optional preferred provider (overrides env)
 * @param overrides - Optional config overrides
 * @returns RerankerConfig for the selected provider
 */
export function getRerankerConfig(
	preferredProvider?: RerankerProviderType,
	overrides?: Partial<RerankerConfig>,
): RerankerConfig {
	// Determine provider: preference > env > default
	let provider: RerankerProviderType =
		preferredProvider || getDefaultRerankerProvider();

	// If Cohere is selected but no API key, fall back to cross-encoder
	if (provider === "cohere" && !isCohereAvailable()) {
		console.warn(
			"[Reranker] Cohere selected but no API key found, falling back to cross-encoder",
		);
		provider = "cross-encoder";
	}

	const baseConfig: RerankerConfig = {
		provider,
		timeout: 30000,
	};

	// Add provider-specific config
	if (provider === "cohere") {
		baseConfig.apiKey = getCohereApiKey();
		baseConfig.model = RERANKER_MODELS.cohere.default;
	} else {
		baseConfig.model = RERANKER_MODELS["cross-encoder"].default;
	}

	return {
		...baseConfig,
		...overrides,
	};
}

/**
 * Environment variable names for documentation
 */
export const RERANKER_ENV_VARS = {
	/** Provider selection: 'cross-encoder' (default) or 'cohere' */
	RERANKER_PROVIDER: "RERANKER_PROVIDER",
	/** Cohere API key (required for cohere provider) */
	COHERE_API_KEY: "COHERE_API_KEY",
} as const;
