/**
 * Search Provider Registry
 * Manages available search providers and creates instances
 */

import { logger } from "@repo/logs";
import type { ProviderConfig, SearchProviderMetadata } from "../types";
import type { BaseSearchProvider } from "./base";
import { ExaSearchProvider } from "./exa";
import { FirecrawlSearchProvider } from "./firecrawl";
import { JinaSearchProvider } from "./jina";
import { ParallelSearchProvider } from "./parallel";
import { TavilySearchProvider } from "./tavily";

/**
 * Registry of all available search providers
 */
export const searchProviderRegistry: Record<
	string,
	{
		metadata: SearchProviderMetadata;
		create: (apiKey?: string, endpoint?: string) => BaseSearchProvider;
	}
> = {
	exa: {
		metadata: new ExaSearchProvider().metadata,
		create: (apiKey, endpoint) => new ExaSearchProvider(apiKey, endpoint),
	},
	tavily: {
		metadata: new TavilySearchProvider().metadata,
		create: (apiKey, endpoint) =>
			new TavilySearchProvider(apiKey, endpoint),
	},
	firecrawl: {
		metadata: new FirecrawlSearchProvider().metadata,
		create: (apiKey, endpoint) =>
			new FirecrawlSearchProvider(apiKey, endpoint),
	},
	parallel: {
		metadata: new ParallelSearchProvider().metadata,
		create: (apiKey, endpoint) =>
			new ParallelSearchProvider(apiKey, endpoint),
	},
	jina: {
		metadata: new JinaSearchProvider().metadata,
		create: (apiKey, endpoint) => new JinaSearchProvider(apiKey, endpoint),
	},
};

/**
 * Get list of all available provider names
 */
export function getAvailableProviderNames(): string[] {
	return Object.keys(searchProviderRegistry);
}

/**
 * Get metadata for all available providers
 */
export function getAllProviderMetadata(): SearchProviderMetadata[] {
	return Object.values(searchProviderRegistry).map((p) => p.metadata);
}

/**
 * Get metadata for a specific provider
 */
export function getProviderMetadata(
	providerName: string,
): SearchProviderMetadata | null {
	return searchProviderRegistry[providerName]?.metadata || null;
}

/**
 * Create a provider instance with configuration
 */
export function createProvider(
	providerName: string,
	apiKey?: string,
	endpoint?: string,
): BaseSearchProvider | null {
	const registry = searchProviderRegistry[providerName];
	if (!registry) {
		logger.warn(
			`[SearchProviderRegistry] Unknown provider: ${providerName}`,
		);
		return null;
	}

	return registry.create(apiKey, endpoint);
}

/**
 * Create providers from database configuration
 * Returns providers sorted by priority
 */
export function createProvidersFromConfig(
	configs: ProviderConfig[],
): BaseSearchProvider[] {
	// Sort by priority (lower = higher priority)
	const sortedConfigs = [...configs].sort((a, b) => a.priority - b.priority);

	const providers: BaseSearchProvider[] = [];

	for (const config of sortedConfigs) {
		const provider = createProvider(
			config.providerName,
			config.apiKey,
			config.endpoint,
		);

		if (provider) {
			providers.push(provider);
		}
	}

	return providers;
}

/**
 * Check which providers are available (have API keys configured)
 */
export async function getConfiguredProviders(
	configs: ProviderConfig[],
): Promise<BaseSearchProvider[]> {
	const providers = createProvidersFromConfig(configs);
	const availableProviders: BaseSearchProvider[] = [];

	for (const provider of providers) {
		const isAvailable = await provider.isAvailable();
		if (isAvailable) {
			availableProviders.push(provider);
		}
	}

	return availableProviders;
}

// Export provider classes
export { BaseSearchProvider, type ISearchProvider } from "./base";
export { ExaSearchProvider } from "./exa";
export { FirecrawlSearchProvider } from "./firecrawl";
export { JinaSearchProvider } from "./jina";
export { ParallelSearchProvider } from "./parallel";
export { TavilySearchProvider } from "./tavily";
