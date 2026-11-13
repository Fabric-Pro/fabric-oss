/**
 * Web-search and page-reading providers for the internal web-research
 * endpoint in apps/web.
 *
 * apps/web has no direct `@repo/search` dependency, so the endpoint gets its
 * searcher and scraper from here: the tenant's configured providers, resolved
 * and constructed the same way the direct-chat tools do it. These wrappers
 * add one research-only distinction the shared resolvers do not make: an
 * organization that HAS an enabled provider the server cannot use (a key that
 * no longer decrypts, or settings the provider cannot be built from) is told
 * apart from one that has none, so the person can be told to fix that
 * provider rather than to add one. The shared resolvers stay exactly as chat
 * uses them.
 */

import { getEnabledOrganizationSearchProviders } from "@repo/database";
import {
	createProvider,
	isWebSearchCapableProvider,
	type SearchResult,
} from "@repo/search";
import { resolveSearchProviderForTenant } from "./get-search-provider";
import {
	getPreferredScrapeProviderName,
	getWebScraperForTenant,
} from "./get-web-scraper";
import type { WebScraper } from "./web-scraper";

export interface WebResearchSearcher {
	providerName: string;
	search(query: string, maxResults: number): Promise<SearchResult[]>;
}

/**
 * Why an enabled provider could not be used: `key_unreadable` when its stored
 * key could not be decrypted; `provider_unusable` when the key was read but
 * the provider could not be built from the row's settings (a Cloudflare row
 * without a valid account endpoint).
 */
type WebResearchProviderUnusableReason = "key_unreadable" | "provider_unusable";

/**
 * Why no provider could serve a research call: `none` when the organization
 * has no enabled provider for the tool; `unusable` when it has one the server
 * could not use, for the given `reason`. `providerName` names the unusable
 * provider, for logs.
 */
export type WebResearchProviderUnavailable =
	| { unavailable: "none" }
	| {
			unavailable: "unusable";
			providerName: string;
			reason: WebResearchProviderUnusableReason;
	  };

/**
 * The organization's web searcher, or why there is none.
 *
 * A failure to read the organization's provider rows propagates: that is a
 * server fault, not an answer about the organization's configuration.
 */
export async function getWebResearchSearcher(
	userId: string,
	organizationId: string,
): Promise<{ searcher: WebResearchSearcher } | WebResearchProviderUnavailable> {
	const providerConfig = await resolveSearchProviderForTenant(
		userId,
		organizationId,
	);
	if (!providerConfig) {
		// The resolver skips a row whose key fails to decrypt and returns null
		// once nothing usable is left; an enabled search row with a key here
		// is therefore one it could not use.
		const providers =
			await getEnabledOrganizationSearchProviders(organizationId);
		const unusable = providers.find(
			(provider) =>
				provider.enabled &&
				Boolean(provider.encryptedApiKey) &&
				isWebSearchCapableProvider(provider.providerName),
		);
		return unusable
			? {
					unavailable: "unusable",
					providerName: unusable.providerName,
					reason: "key_unreadable",
				}
			: { unavailable: "none" };
	}

	const { providerName, apiKey } = providerConfig;
	const provider = createProvider(providerName, apiKey);
	// A provider this build cannot construct: re-entering its key would not
	// help, so it reads as no provider at all.
	if (!provider) {
		return { unavailable: "none" };
	}

	return {
		searcher: {
			providerName,
			search: async (query, maxResults) =>
				(
					await provider.search(query, {
						maxResults,
						category: "general",
					})
				).results,
		},
	};
}

/**
 * The organization's page reader, or why there is none.
 *
 * The provider the picker would choose is read first, without decrypting
 * anything; a failure of that read propagates as a server fault, not an
 * answer about the organization's configuration. Only when it names a
 * provider is the scraper built. That build decrypts the key and throws when
 * it cannot (`key_unreadable`), and returns no scraper when the decrypted key
 * cannot make one from the row's settings (`provider_unusable`).
 */
export async function getWebResearchScraper(args: {
	userId: string;
	organizationId: string;
}): Promise<{ scraper: WebScraper } | WebResearchProviderUnavailable> {
	const providerName = await getPreferredScrapeProviderName({
		userId: args.userId,
		organizationId: args.organizationId,
		requireCrawl: false,
	});
	if (!providerName) {
		return { unavailable: "none" };
	}

	let scraper: WebScraper | null;
	try {
		scraper = await getWebScraperForTenant({
			userId: args.userId,
			organizationId: args.organizationId,
			requireCrawl: false,
		});
	} catch {
		// The error can describe key material; it is neither kept nor logged.
		return {
			unavailable: "unusable",
			providerName,
			reason: "key_unreadable",
		};
	}
	return scraper
		? { scraper }
		: {
				unavailable: "unusable",
				providerName,
				reason: "provider_unusable",
			};
}
