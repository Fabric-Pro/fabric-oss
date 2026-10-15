/**
 * The scraper a URL source runs with, chosen the same way everywhere.
 *
 * Adding a link (`processLink`), re-syncing it, retrying a stalled one,
 * retrying one child page, editing its schedule, and every company-context
 * website crawl all need a literal scraper key, because the worker cannot reach
 * the credential store. They used to resolve it separately, and four of them
 * looked only for Firecrawl — so a tenant with Jina, Tavily, Exa or Cloudflare
 * could add a source but never re-sync it, and a tenant with both was silently
 * moved to Firecrawl. This module is the one place that decides, so the
 * procedures cannot drift apart again.
 *
 * Picker order mirrors `getWebScraperForTenant` in
 * `packages/temporal/src/activities/lib/get-web-scraper.ts`: the first enabled
 * row (default first, then priority) that can scrape — or, for a path-prefix
 * crawl, can crawl. The provider is chosen fresh on every call; the one a
 * source was first added with (`metadata.scraperProvider`) is a record of what
 * ran, not a pin.
 *
 * Tenancy is exclusive: an organization's providers when an organization is in
 * play, the user's own otherwise. The two sets are never merged.
 */
import { ORPCError } from "@orpc/server";
import {
	db,
	getEnabledOrganizationSearchProviders,
	getEnabledUserSearchProviders,
} from "@repo/database";
import { logger } from "@repo/logs";
import { decryptApiKey } from "@repo/utils";

/**
 * Provider names recognised by the URL-source flow. Mirror of
 * `WebScraperProviderName` in the temporal package — duplicated here so
 * the API package doesn't reach across into a workflow-side type. Kept in
 * lockstep via the test in `__tests__/process-context-link.test.ts`.
 */
export type UrlSourceProviderName =
	| "firecrawl"
	| "jina"
	| "tavily"
	| "exa"
	| "cloudflare"
	| "parallel";

const SCRAPE_CAPABLE: ReadonlySet<UrlSourceProviderName> = new Set([
	"firecrawl",
	"jina",
	"tavily",
	"exa",
	"cloudflare",
]);
const CRAWL_CAPABLE: ReadonlySet<UrlSourceProviderName> = new Set([
	"firecrawl",
	"cloudflare",
]);

/**
 * Subset of the OrganizationSearchProvider / UserSearchProvider row shape we
 * need. Both Prisma models share these fields verbatim.
 */
interface SearchProviderRow {
	providerName: string;
	encryptedApiKey: string | null;
	/** Cloudflare's account endpoint; carried to the workflow as `providerEndpoint`. */
	endpoint?: string | null;
	enabled: boolean;
	isDefault: boolean;
	priority: number;
	createdAt: Date;
}

/**
 * BAD_REQUEST payload codes. The UI gates on `code` to render the correct
 * notice. `FIRECRAWL_NOT_CONFIGURED` is no longer thrown by the API: the web
 * client still recognises it so an older server keeps rendering the notice.
 */
type ProviderNotConfiguredCode =
	| "SCRAPE_PROVIDER_NOT_CONFIGURED"
	| "CRAWL_PROVIDER_NOT_CONFIGURED"
	| "FIRECRAWL_NOT_CONFIGURED";

interface ProviderNotConfiguredData {
	code: ProviderNotConfiguredCode;
	settingsPath: string;
}

function buildSearchProvidersSettingsPath(orgSlug?: string | null): string {
	return orgSlug
		? `/app/${orgSlug}/settings/search-providers`
		: "/app/settings/search-providers";
}

export async function resolveOrgSlug(
	organizationId: string | undefined,
): Promise<string | null> {
	if (!organizationId) {
		return null;
	}
	const org = await db.organization.findUnique({
		where: { id: organizationId },
		select: { slug: true },
	});
	return org?.slug ?? null;
}

/**
 * Pick the first scrape-capable (and crawl-capable, when requireCrawl)
 * provider from the tenant's enabled list. Mirror of `getWebScraperForTenant`
 * minus the adapter construction — that happens activity-side in the worker.
 * Inlining the ordering here means the procedure doesn't depend on the
 * temporal worker code at compile time.
 */
function pickEnabledProvider(
	providers: SearchProviderRow[],
	requireCrawl: boolean,
): SearchProviderRow | null {
	const filter = requireCrawl
		? (n: string) => CRAWL_CAPABLE.has(n as UrlSourceProviderName)
		: (n: string) => SCRAPE_CAPABLE.has(n as UrlSourceProviderName);
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

/** The scraper a crawl runs with, its decrypted key and its stored endpoint. */
export interface UrlSourceProvider {
	providerName: UrlSourceProviderName;
	apiKey: string;
	/** The row's stored endpoint; Cloudflare keeps its account ID here. */
	providerEndpoint?: string;
}

/**
 * The workflow / schedule fields a resolved provider contributes. Spread this
 * next to nothing else: it carries `apiKey`, `providerName` and, only when the
 * row has one, `providerEndpoint`.
 */
export function providerWorkflowArgs(provider: UrlSourceProvider): {
	apiKey: string;
	providerName: UrlSourceProviderName;
	providerEndpoint?: string;
} {
	return {
		apiKey: provider.apiKey,
		providerName: provider.providerName,
		...(provider.providerEndpoint
			? { providerEndpoint: provider.providerEndpoint }
			: {}),
	};
}

/**
 * Resolve the scraper for a crawl of `scope`, or throw the typed BAD_REQUEST
 * the add-link dialog renders:
 *
 * - `SCRAPE_PROVIDER_NOT_CONFIGURED` — no enabled provider can scrape;
 * - `CRAWL_PROVIDER_NOT_CONFIGURED` — `PATH_PREFIX` was asked for and none
 *   can crawl (only Firecrawl and Cloudflare Browser Rendering can).
 *
 * `sourceNoun` is the subject of the message ("URL sources" for a project,
 * "Website sources" for company context). A decrypt failure is a 500, not a
 * missing-configuration notice: the key exists but cannot be read.
 */
export async function resolveUrlSourceProvider(params: {
	organizationId: string | null | undefined;
	userId: string | null | undefined;
	scope: "SINGLE_PAGE" | "PATH_PREFIX";
	sourceNoun?: string;
}): Promise<UrlSourceProvider> {
	const { scope, sourceNoun = "URL sources" } = params;
	const organizationId = params.organizationId ?? undefined;

	let providers: SearchProviderRow[];
	if (organizationId) {
		providers = await getEnabledOrganizationSearchProviders(organizationId);
	} else if (params.userId) {
		providers = await getEnabledUserSearchProviders(params.userId);
	} else {
		// Neither tenant arm: nothing to read, and no reason to guess one.
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Cannot resolve a search provider without an owner",
		});
	}

	const notConfigured = async (
		code: ProviderNotConfiguredData["code"],
		message: string,
	): Promise<never> => {
		const data: ProviderNotConfiguredData = {
			code,
			settingsPath: buildSearchProvidersSettingsPath(
				await resolveOrgSlug(organizationId),
			),
		};
		throw new ORPCError("BAD_REQUEST", { message, data });
	};

	if (!pickEnabledProvider(providers, false)) {
		return notConfigured(
			"SCRAPE_PROVIDER_NOT_CONFIGURED",
			`${sourceNoun} need a search provider with scraping (Firecrawl, Jina, Tavily, Exa, or Cloudflare Browser Rendering). Configure one in Settings → Search Providers.`,
		);
	}

	// For PATH_PREFIX we additionally require a crawl-capable provider
	// (Firecrawl, or Cloudflare Browser Rendering which discovers pages by
	// following in-prefix links). Other providers can't, so PATH_PREFIX with
	// Jina/Tavily/Exa would silently fall back to a single-page scrape —
	// surfacing the limitation explicitly is the better UX.
	const chosen = pickEnabledProvider(providers, scope === "PATH_PREFIX");
	if (!chosen?.encryptedApiKey) {
		return notConfigured(
			"CRAWL_PROVIDER_NOT_CONFIGURED",
			"Path-prefix crawls require Firecrawl or Cloudflare Browser Rendering. Configure one in Settings → Search Providers, or pick Single page.",
		);
	}

	const providerName = chosen.providerName as UrlSourceProviderName;
	try {
		return {
			providerName,
			apiKey: decryptApiKey(chosen.encryptedApiKey),
			...(chosen.endpoint ? { providerEndpoint: chosen.endpoint } : {}),
		};
	} catch (error) {
		logger.error(
			`[UrlSourceProvider] Failed to decrypt the ${providerName} API key: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: `Failed to read ${providerName} API key`,
		});
	}
}
