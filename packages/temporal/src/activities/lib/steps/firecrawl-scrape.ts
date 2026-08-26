/**
 * Firecrawl Scrape Step
 * Scrapes web pages using Firecrawl API
 *
 * Uses the unified search providers configuration from UserSearchProvider/OrganizationSearchProvider
 * and the shared `firecrawl-client` wrapper for the HTTP boundary + typed error mapping.
 */

import { getSearchProviderConfig } from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import type { NodeExecutionResult, StepParams } from "../../types";
import { scrapeUrl } from "../firecrawl-client";
import { interpolateTemplate } from "./utils";

async function getFirecrawlApiKey(
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

		return null;
	} catch (error) {
		console.error("[Firecrawl] Error getting API key:", error);
		return null;
	}
}

export async function executeFirecrawlScrapeStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { url, formats = ["markdown"] } = params.nodeConfig as {
		url?: string;
		formats?: string[];
	};

	if (!url) {
		return { success: false, error: "URL is required" };
	}

	const interpolatedUrl = interpolateTemplate(url, params.inputs);
	const apiKey = await getFirecrawlApiKey(
		params.userId,
		params.organizationId,
	);

	if (!apiKey) {
		return {
			success: false,
			error: "Firecrawl API key not configured. Please configure it in Settings > Search Providers.",
		};
	}

	const result = await scrapeUrl(interpolatedUrl, { apiKey, formats });

	if (!result.success) {
		return {
			success: false,
			error: result.error.message,
		};
	}

	const { pageUrl, pageTitle, markdown } = result.data;
	return {
		success: true,
		// Preserve the legacy `data.*` shape that downstream workflow nodes
		// have been consuming via `result.data?.markdown`, while also
		// surfacing the normalised fields for new callers.
		output: {
			markdown,
			// Hoisted to the top level because that is where the plugin
			// declares it, and therefore where {{Node.title}} looks. The
			// nested copy stays for workflows written against it.
			title: pageTitle,
			url: pageUrl,
			metadata: {
				sourceURL: pageUrl,
				title: pageTitle,
			},
		},
	};
}
