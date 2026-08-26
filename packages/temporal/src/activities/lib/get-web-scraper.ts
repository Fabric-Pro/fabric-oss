/**
 * Tenant-scoped scraper picker (URL Context Sources — commit 3 of 3).
 *
 * Reads the unified `OrganizationSearchProvider` / `UserSearchProvider` table
 * under the strict XOR tenancy contract (AGENTS.md) and returns the first
 * scrape-capable provider for the tenant, with the API key decrypted and the
 * adapter constructed.
 *
 * Ordering matches `getEnabledOrganizationSearchProviders` /
 * `getEnabledUserSearchProviders`: `isDefault: true` first, then by `priority`
 * (ascending — lower = higher precedence in this schema), then by `createdAt`.
 *
 * `requireCrawl: true` filters to crawl-capable providers only (Firecrawl in
 * v1.1) — used by the PATH_PREFIX server-side pre-flight.
 *
 * Returns `null` when no candidate qualifies, so the caller can throw the
 * appropriate typed BAD_REQUEST (`SCRAPE_PROVIDER_NOT_CONFIGURED` /
 * `CRAWL_PROVIDER_NOT_CONFIGURED`) per `process-context-link.ts`.
 */
import {
	getEnabledOrganizationSearchProviders,
	getEnabledUserSearchProviders,
} from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import { createExaScraper } from "./scrapers/exa-scraper";
import { createFirecrawlScraper } from "./scrapers/firecrawl-scraper";
import { createJinaScraper } from "./scrapers/jina-scraper";
import { createTavilyScraper } from "./scrapers/tavily-scraper";
import {
	isCrawlCapableProvider,
	isScrapeCapableProvider,
	type WebScraper,
	type WebScraperProviderName,
} from "./web-scraper";

export interface GetWebScraperArgs {
	userId: string | null;
	organizationId: string | null;
	requireCrawl: boolean;
}

/**
 * The subset of the `OrganizationSearchProvider` / `UserSearchProvider` row
 * shape we depend on. Both Prisma models expose these fields verbatim — we
 * declare the contract locally so the picker doesn't import from `@repo/database`'s
 * generated types just for the field list.
 */
interface SearchProviderRow {
	providerName: string;
	encryptedApiKey: string | null;
	enabled: boolean;
	isDefault: boolean;
	priority: number;
	createdAt: Date;
}

/**
 * Build a `WebScraper` adapter from a known provider name + decrypted key.
 * Exported so activities can rebuild the adapter from their input without
 * re-running the DB query (the workflow passes `providerName` + `apiKey`
 * through the activity input).
 *
 * Returns `null` for providers we cannot scrape with (`parallel`). Callers
 * should treat that as "no candidate available".
 */
export function createScraperByName(
	providerName: WebScraperProviderName,
	apiKey: string,
): WebScraper | null {
	switch (providerName) {
		case "firecrawl":
			return createFirecrawlScraper(apiKey);
		case "jina":
			return createJinaScraper(apiKey);
		case "tavily":
			return createTavilyScraper(apiKey);
		case "exa":
			return createExaScraper(apiKey);
		case "parallel":
			// Not supported as a URL-context scraper in v1.1.
			return null;
	}
}

function pickProvider(
	providers: SearchProviderRow[],
	requireCrawl: boolean,
): SearchProviderRow | null {
	const filter = requireCrawl
		? isCrawlCapableProvider
		: isScrapeCapableProvider;
	for (const provider of providers) {
		if (!provider.enabled || !provider.encryptedApiKey) {
			continue;
		}
		if (!filter(provider.providerName)) {
			continue;
		}
		return provider;
	}
	return null;
}

/**
 * Pick the right scraper for the tenant. Returns `null` when no candidate
 * qualifies — the caller is responsible for throwing the typed error.
 *
 * XOR tenancy:
 *   - `organizationId` non-null → org providers only (never falls back to user)
 *   - `organizationId` null     → user providers only
 *
 * Decryption errors are bubbled up — the procedure layer translates them into
 * INTERNAL_SERVER_ERROR, same as the legacy Firecrawl path.
 */
export async function getWebScraperForTenant(
	args: GetWebScraperArgs,
): Promise<WebScraper | null> {
	const { userId, organizationId, requireCrawl } = args;

	let providers: SearchProviderRow[];
	if (organizationId) {
		providers = await getEnabledOrganizationSearchProviders(organizationId);
	} else if (userId) {
		providers = await getEnabledUserSearchProviders(userId);
	} else {
		// No tenant context — should never happen for an authenticated call.
		return null;
	}

	const picked = pickProvider(providers, requireCrawl);
	if (!picked) {
		return null;
	}
	if (!picked.encryptedApiKey) {
		return null;
	}

	const apiKey = decryptApiKey(picked.encryptedApiKey);
	return createScraperByName(
		picked.providerName as WebScraperProviderName,
		apiKey,
	);
}

/**
 * Lightweight variant — returns just the provider name that *would* be
 * picked, without decrypting the API key. Used by the API procedure to stamp
 * `ProjectContext.metadata.scraperProvider` and by the UI's "Indexing with X"
 * indicator (via a separate query path; the picker itself is server-only).
 */
export async function getPreferredScrapeProviderName(args: {
	userId: string | null;
	organizationId: string | null;
	requireCrawl: boolean;
}): Promise<WebScraperProviderName | null> {
	let providers: SearchProviderRow[];
	if (args.organizationId) {
		providers = await getEnabledOrganizationSearchProviders(
			args.organizationId,
		);
	} else if (args.userId) {
		providers = await getEnabledUserSearchProviders(args.userId);
	} else {
		return null;
	}

	const picked = pickProvider(providers, args.requireCrawl);
	return (picked?.providerName as WebScraperProviderName | undefined) ?? null;
}
