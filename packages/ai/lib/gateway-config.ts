/**
 * AI Gateway and Provider Configuration
 *
 * This module re-exports provider configuration from @repo/database (single source of truth)
 * and provides additional utility functions for working with AI gateways.
 */

import type { AIProvider } from "@repo/database";

// Re-export ProviderMetadata type with alias to avoid conflicts with AI SDK
export type { ProviderMetadata as AIProviderMetadata } from "@repo/database";
// Re-export provider constants and metadata from @repo/database (single source of truth)
export {
	AI_PROVIDER_METADATA,
	DIRECT_PROVIDERS,
	GATEWAY_PROVIDERS,
	getProviderDisplayName,
	getProviderMetadata,
	isDirectProvider,
	isGatewayProvider,
} from "@repo/database";

/**
 * Default base URLs for each provider
 * These are derived from AI_PROVIDER_METADATA.baseUrl
 */
import { AI_PROVIDER_METADATA as PROVIDER_METADATA } from "@repo/database";

export const DEFAULT_BASE_URLS: Partial<Record<string, string>> =
	Object.fromEntries(
		Object.entries(PROVIDER_METADATA)
			.filter(([_, meta]) => meta.baseUrl)
			.map(([provider, meta]) => [provider, meta.baseUrl]),
	);

/**
 * Check if a provider requires a custom base URL
 */
export function requiresBaseUrl(provider: string): boolean {
	const metadata = PROVIDER_METADATA[provider as AIProvider];
	return metadata?.requiresBaseUrl ?? false;
}

/**
 * Get the default base URL for a provider
 */
export function getDefaultBaseUrl(provider: string): string | undefined {
	return DEFAULT_BASE_URLS[provider];
}

/**
 * Validate API key format if provider has a known prefix
 */
export function validateApiKeyFormat(
	provider: string,
	apiKey: string,
): { valid: boolean; message?: string } {
	const metadata = PROVIDER_METADATA[provider as AIProvider];
	if (!metadata?.keyPrefix) {
		return { valid: true };
	}

	if (!apiKey.startsWith(metadata.keyPrefix)) {
		return {
			valid: false,
			message: `API key should start with "${metadata.keyPrefix}"`,
		};
	}

	return { valid: true };
}

/**
 * Full provider configuration for API calls
 */
export interface ProviderConfig {
	provider: string;
	apiKey: string;
	baseUrl?: string;
	model: string;
	enabledProviders?: string[];
}

/**
 * Build the effective base URL for a provider
 */
export function buildEffectiveBaseUrl(
	provider: string,
	customBaseUrl?: string,
): string | undefined {
	// Custom URL takes precedence
	if (customBaseUrl) {
		return customBaseUrl;
	}

	// Use default if available
	return DEFAULT_BASE_URLS[provider];
}
