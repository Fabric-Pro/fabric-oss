/**
 * Whether document generation can research the web for an organization, and
 * what is missing when it cannot.
 *
 * Research needs two things: a provider that can search, and one that can read
 * (scrape) a page. One provider may do both (Firecrawl), or two may split them
 * (Exa for search, Jina for reading). A row counts only when it is enabled and
 * has a stored key; the key is never decrypted here, because the answer is
 * configuration presence, not a working credential.
 *
 * Only the organization's providers count. The organization is the only tenant
 * context (docs/adr/018-organization-is-the-only-tenant-context.md), so a
 * missing organization is the fail-closed arm: unavailable, both halves
 * missing, and no provider read.
 */
import { getEnabledOrganizationSearchProviders } from "@repo/database";
import { isWebSearchCapableProvider } from "@repo/search";
import { isScrapeCapableUrlSourceProvider } from "../procedures/contexts/lib/url-source-provider";

type WebResearchCapability = "search" | "read";

export interface WebResearchAvailability {
	available: boolean;
	/** Always in `search`, `read` order, so the UI's reason text is stable. */
	missing: WebResearchCapability[];
}

/** The provider-row fields the answer depends on. */
export interface WebResearchProviderRow {
	providerName: string;
	enabled: boolean;
	encryptedApiKey: string | null;
}

export function computeWebResearchAvailability(
	providers: readonly WebResearchProviderRow[],
): WebResearchAvailability {
	const usable = providers.filter(
		(provider) => provider.enabled && Boolean(provider.encryptedApiKey),
	);
	const canSearch = usable.some((provider) =>
		isWebSearchCapableProvider(provider.providerName),
	);
	const canRead = usable.some((provider) =>
		isScrapeCapableUrlSourceProvider(provider.providerName),
	);

	const missing: WebResearchCapability[] = [];
	if (!canSearch) {
		missing.push("search");
	}
	if (!canRead) {
		missing.push("read");
	}
	return { available: missing.length === 0, missing };
}

/**
 * Availability for an organization. `null` answers unavailable without a
 * query: there is no tenant whose providers could be read.
 */
export async function loadWebResearchAvailability(
	organizationId: string | null,
): Promise<WebResearchAvailability> {
	if (!organizationId) {
		return computeWebResearchAvailability([]);
	}
	return computeWebResearchAvailability(
		await getEnabledOrganizationSearchProviders(organizationId),
	);
}
