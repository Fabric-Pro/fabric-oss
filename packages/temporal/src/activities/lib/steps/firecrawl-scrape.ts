/**
 * Firecrawl Scrape Step
 * Scrapes web pages using Firecrawl API
 *
 * Uses the unified search providers configuration from UserSearchProvider/OrganizationSearchProvider
 * and the shared `firecrawl-client` wrapper for the HTTP boundary + typed error mapping.
 */

import type { NodeExecutionResult, StepParams } from "../../types";
import { scrapeUrl } from "../firecrawl-client";
import { getFirecrawlApiKey } from "../firecrawl-credentials";
import { interpolateTemplate } from "./utils";

export async function executeFirecrawlScrapeStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { url, formats = ["markdown"] } = params.nodeConfig as {
		url?: string;
		formats?: string[] | string;
	};

	if (!url) {
		return { success: false, error: "URL is required" };
	}

	const requestedFormats = typeof formats === "string" ? [formats] : formats;
	if (
		!Array.isArray(requestedFormats) ||
		requestedFormats.length === 0 ||
		requestedFormats.some(
			(format) => typeof format !== "string" || !format.trim(),
		)
	) {
		return {
			success: false,
			error: "Formats must be a non-empty list of format names",
		};
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

	const result = await scrapeUrl(interpolatedUrl, {
		apiKey,
		formats: requestedFormats,
	});

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
