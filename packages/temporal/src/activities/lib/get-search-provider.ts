/**
 * Resolve the web-search provider a tenant has configured.
 *
 * Order: the default search-capable provider, then any other enabled
 * search-capable row, then the fixed fallback list (exa, parallel, tavily,
 * firecrawl). A scrape-only provider (Cloudflare Browser Rendering) is never
 * chosen. Returns null when nothing usable is configured.
 */

import {
	getMergedSearchProviderConfigs,
	getSearchProviderConfig,
} from "@repo/database";
import { logger } from "@repo/logs";
import { isWebSearchCapableProvider } from "@repo/search";
import { decryptApiKey } from "@repo/utils";

export async function resolveSearchProviderForTenant(
	userId: string,
	organizationId?: string,
): Promise<{ apiKey: string; providerName: string } | null> {
	// A scrape-only provider (Cloudflare Browser Rendering) cannot search, so
	// it is never chosen here, even as the default: selection falls through
	// to the next search-capable row. The fallback list below names only
	// search providers, so it needs no filter of its own.
	const configs = (
		await getMergedSearchProviderConfigs({
			userId,
			organizationId,
		})
	).filter((c) => isWebSearchCapableProvider(c.providerName));

	const defaultProvider = configs.find(
		(c) => c.isDefault && c.enabled && c.encryptedApiKey,
	);
	if (defaultProvider) {
		try {
			const encryptedApiKey = defaultProvider.encryptedApiKey;
			if (!encryptedApiKey) {
				return null;
			}
			return {
				apiKey: decryptApiKey(encryptedApiKey),
				providerName: defaultProvider.providerName,
			};
		} catch (error) {
			logger.error("Failed to decrypt default search provider API key", {
				error,
				providerName: defaultProvider.providerName,
			});
		}
	}

	for (const config of configs) {
		if (config.enabled && config.encryptedApiKey) {
			try {
				return {
					apiKey: decryptApiKey(config.encryptedApiKey),
					providerName: config.providerName,
				};
			} catch (error) {
				logger.error("Failed to decrypt search provider API key", {
					error,
					providerName: config.providerName,
				});
			}
		}
	}

	const fallbackPriority = ["exa", "parallel", "tavily", "firecrawl"];
	const configuredNames = new Set(configs.map((c) => c.providerName));

	for (const providerName of fallbackPriority) {
		if (configuredNames.has(providerName)) {
			continue;
		}

		const config = await getSearchProviderConfig({
			userId,
			organizationId: organizationId || undefined,
			providerName,
		});

		if (config?.encryptedApiKey && config.enabled) {
			try {
				return {
					apiKey: decryptApiKey(config.encryptedApiKey),
					providerName,
				};
			} catch (error) {
				logger.error(
					"Failed to decrypt fallback search provider API key",
					{
						error,
						providerName,
					},
				);
			}
		}
	}

	return null;
}
