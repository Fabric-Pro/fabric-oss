/**
 * Federated Connector Base
 *
 * Abstract base class for connectors that support real-time search
 * against external services WITHOUT pre-indexing.
 *
 * Federated search is a read-only freshness layer that supplements
 * indexed results. It respects live permissions and always returns fresh data.
 *
 * Separation from action tools:
 * - Federated search = read-only freshness (search APIs)
 * - Action tools = write capabilities (create/update via MCP)
 */

import type {
	ConnectorConfig,
	ConnectorProvider,
	FederatedSearchOptions,
	FederatedSearchResult,
	IFederatedConnector,
} from "./types";

/**
 * Abstract base for federated connectors.
 * Provides common helpers for real-time search implementations.
 */
export abstract class FederatedConnector implements IFederatedConnector {
	abstract provider: ConnectorProvider;

	/**
	 * Execute a real-time search against the external service.
	 * Must be implemented by each provider.
	 */
	abstract federatedSearch(
		options: FederatedSearchOptions,
	): Promise<FederatedSearchResult[]>;

	/**
	 * Build a FederatedSearchResult from raw data.
	 */
	protected buildResult(fields: {
		id: string;
		title: string;
		content: string;
		url?: string;
		sourceName: string;
		externalTimestamp?: Date;
		author?: string;
		metadata?: Record<string, unknown>;
	}): FederatedSearchResult {
		return {
			...fields,
			provider: this.provider,
		};
	}

	/**
	 * Truncate content to a reasonable length for search results.
	 */
	protected truncateContent(content: string, maxLength = 500): string {
		if (content.length <= maxLength) {
			return content;
		}
		return `${content.slice(0, maxLength)}...`;
	}
}

// =============================================================================
// Federated Connector Registry
// =============================================================================

const federatedRegistry = new Map<
	ConnectorProvider,
	() => IFederatedConnector
>();

/**
 * Register a federated connector implementation.
 */
export function registerFederatedConnector(
	provider: ConnectorProvider,
	factory: () => IFederatedConnector,
): void {
	federatedRegistry.set(provider, factory);
}

/**
 * Get a federated connector by provider.
 */
export function getFederatedConnector(
	provider: ConnectorProvider,
): IFederatedConnector | null {
	const factory = federatedRegistry.get(provider);
	return factory ? factory() : null;
}

/**
 * List all providers with federated search support.
 */
export function listFederatedConnectors(): ConnectorProvider[] {
	return Array.from(federatedRegistry.keys());
}

/**
 * Search across all registered federated connectors in parallel.
 * Each connector that has a valid config is searched.
 *
 * @param query - Search query
 * @param configs - Connector configs keyed by provider
 * @param maxResultsPerProvider - Max results per provider (default: 5)
 * @returns Aggregated results from all providers, with "Live" freshness tag
 */
export async function searchAllFederated(
	query: string,
	configs: Map<ConnectorProvider, ConnectorConfig>,
	maxResultsPerProvider = 5,
): Promise<FederatedSearchResult[]> {
	const providers = listFederatedConnectors();
	const results: FederatedSearchResult[] = [];

	const searches = providers
		.filter((provider) => configs.has(provider))
		.map(async (provider) => {
			const connector = getFederatedConnector(provider);
			const config = configs.get(provider);
			if (!connector || !config) {
				return;
			}

			try {
				const providerResults = await connector.federatedSearch({
					query,
					config,
					maxResults: maxResultsPerProvider,
				});
				results.push(...providerResults);
			} catch (error) {
				// Non-fatal: log and continue with other providers
				console.warn(
					`[FederatedSearch] ${provider} search failed:`,
					error instanceof Error ? error.message : error,
				);
			}
		});

	await Promise.all(searches);
	return results;
}
