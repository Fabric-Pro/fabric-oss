import { resolveUrlSourceScraperCredential } from "@repo/database";
import { redactCloudflareToken } from "@repo/utils/cloudflare-browser-rendering";
import { ApplicationFailure } from "@temporalio/activity";
import type { ContextOwner } from "../../../lib/context-owner";
import type {
	WebScrapePage,
	WebScraperProviderName,
} from "../../lib/web-scraper";

export interface UrlScraperActivityReference {
	contextId?: string;
	owner?: ContextOwner;
	organizationId?: string | null;
	providerName?: WebScraperProviderName;
	/** Compatibility with activities scheduled by earlier workflow versions. */
	apiKey?: string;
	providerEndpoint?: string;
}

export async function resolveActivityScraperCredential(
	input: UrlScraperActivityReference,
) {
	const {
		contextId,
		owner,
		organizationId,
		providerName = "firecrawl",
	} = input;
	if (contextId === undefined && input.apiKey) {
		return { apiKey: input.apiKey, endpoint: input.providerEndpoint };
	}
	if (!contextId) {
		throw ApplicationFailure.nonRetryable(
			"A URL source reference is required to resolve the scraper credential.",
			"URL_SCRAPER_CREDENTIAL_REQUIRED",
		);
	}

	const credential = await resolveUrlSourceScraperCredential({
		contextId,
		organizationId:
			owner?.kind === "company" && owner.organizationId !== organizationId
				? undefined
				: organizationId,
		providerName,
		company: owner?.kind === "company",
	});
	switch (credential.status) {
		case "resolved":
			return credential;
		case "source-not-authorized":
			throw ApplicationFailure.nonRetryable(
				"The URL source is unavailable in this organization.",
				"URL_SCRAPER_SOURCE_NOT_AUTHORIZED",
			);
		case "provider-unavailable":
			throw ApplicationFailure.nonRetryable(
				"The URL source's scraper is not configured or enabled in this organization.",
				"URL_SCRAPER_PROVIDER_UNAVAILABLE",
			);
		case "credential-unreadable":
			throw ApplicationFailure.nonRetryable(
				"The URL source's scraper credential could not be read. Re-save it in Search Providers.",
				"URL_SCRAPER_CREDENTIAL_UNREADABLE",
			);
	}
}

export function redactScraperText(text: string, apiKey: string): string {
	return text.replaceAll(apiKey, "[redacted]");
}

export function redactScraperPage(
	page: WebScrapePage,
	apiKey: string,
): WebScrapePage {
	return {
		...page,
		pageUrl: redactScraperText(page.pageUrl, apiKey),
		pageTitle:
			page.pageTitle === null
				? null
				: redactScraperText(page.pageTitle, apiKey),
		markdown: redactScraperText(page.markdown, apiKey),
		...(page.etag !== undefined
			? { etag: redactScraperText(page.etag, apiKey) }
			: {}),
		...(page.lastModifiedHeader !== undefined
			? {
					lastModifiedHeader: redactScraperText(
						page.lastModifiedHeader,
						apiKey,
					),
				}
			: {}),
	};
}

export function redactScraperMessage(message: string, apiKey: string): string {
	return redactCloudflareToken(message, apiKey);
}

/** Some adapters can throw outside their normal error-result contract. */
export async function callUrlScraper<T>(
	apiKey: string,
	call: () => Promise<T>,
): Promise<T> {
	try {
		return await call();
	} catch (error) {
		// Do not attach the original cause or stack to a serialized failure.
		throw ApplicationFailure.retryable(
			redactScraperMessage(
				error instanceof Error ? error.message : String(error),
				apiKey,
			),
			"FIRECRAWL_UNKNOWN",
		);
	}
}
