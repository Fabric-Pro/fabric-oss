import {
	fetchCredentialsByProvider,
	getSearchProviderConfig,
} from "@repo/database";
import { decryptApiKey } from "@repo/utils";

/** Retain search-provider precedence while supporting workflow-only connections. */
export async function getFirecrawlApiKey(
	userId: string,
	organizationId?: string,
): Promise<string | null> {
	try {
		const config = await getSearchProviderConfig({
			userId,
			organizationId,
			providerName: "firecrawl",
		});
		if (config?.encryptedApiKey) {
			return decryptApiKey(config.encryptedApiKey);
		}
		return (
			(
				await fetchCredentialsByProvider(
					"FIRECRAWL",
					userId,
					organizationId,
				)
			)?.FIRECRAWL_API_KEY || null
		);
	} catch {
		console.error("[Firecrawl] Credentials could not be loaded");
		return null;
	}
}
