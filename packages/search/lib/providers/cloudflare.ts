/**
 * Cloudflare Browser Rendering provider.
 *
 * Scrape only: Fabric uses Browser Rendering's `/markdown` endpoint to turn a
 * URL source into Markdown (the URL-source scraper lives in the Temporal
 * package). It has no web search, so `metadata.supportsSearch` is false and
 * search-provider selection skips it; this class exists so Settings can test a
 * configured token.
 *
 * The account ID is stored as the row's endpoint, the account-scoped API base
 * URL `https://api.cloudflare.com/client/v4/accounts/<accountId>`. Requests go
 * to a URL rebuilt from the parsed account ID, never to the stored string.
 */

import {
	cloudflareMarkdownUrl,
	redactCloudflareToken,
} from "@repo/utils/cloudflare-browser-rendering";
import type {
	SearchProviderMetadata,
	SearchResponse,
	TestConnectionResult,
} from "../types";
import { BaseSearchProvider } from "./base";
import { fetchSearchEndpoint } from "./outbound";

const TEST_TIMEOUT_MS = 30_000;
const TEST_PAGE_URL = "https://example.com";
/** Longest stretch of upstream error text returned to the caller. */
const MAX_DETAIL_CHARS = 300;

export class CloudflareBrowserRenderingProvider extends BaseSearchProvider {
	readonly metadata: SearchProviderMetadata = {
		name: "cloudflare",
		displayName: "Cloudflare Browser Rendering",
		description:
			"Renders pages in a headless browser and returns them as Markdown. Used to scrape single-page URL sources; it does not search the web.",
		keyPrefix: "CLOUDFLARE_API_TOKEN",
		docsUrl:
			"https://developers.cloudflare.com/browser-rendering/rest-api/markdown-endpoint/",
		icon: "globe",
		supportedCategories: [],
		// URL-source scraping runs through the Temporal scraper adapter, not
		// through `retrieveContent` here.
		supportsContentRetrieval: false,
		supportsImageSearch: false,
		supportsSearch: false,
	};

	async search(_query: string): Promise<SearchResponse> {
		throw new Error(
			"Cloudflare Browser Rendering does not support web search",
		);
	}

	override async isAvailable(): Promise<boolean> {
		return !!this.apiKey && cloudflareMarkdownUrl(this.endpoint) !== null;
	}

	override async testConnection(): Promise<TestConnectionResult> {
		if (!this.apiKey) {
			return { success: false, error: "API token is required" };
		}
		const markdownUrl = cloudflareMarkdownUrl(this.endpoint);
		if (!markdownUrl) {
			return {
				success: false,
				error: "A valid Cloudflare account ID is required",
			};
		}

		const startTime = Date.now();
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
		try {
			const response = await fetchSearchEndpoint(markdownUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({ url: TEST_PAGE_URL }),
				signal: controller.signal,
			});
			const responseTime = Date.now() - startTime;
			const body = (await response.json().catch(() => null)) as {
				success?: boolean;
				result?: unknown;
				errors?: Array<{ code?: number; message?: string }>;
			} | null;

			if (
				response.ok &&
				body?.success === true &&
				typeof body.result === "string"
			) {
				return {
					success: true,
					responseTime,
					info: {
						provider: "Cloudflare Browser Rendering",
						status: "Connected",
					},
				};
			}
			if (response.status === 401 || response.status === 403) {
				return {
					success: false,
					error: "Cloudflare rejected the API token. Check the token, its Browser Rendering (Browser Run) - Edit permission, and the account ID.",
					responseTime,
				};
			}
			if (response.status === 429) {
				return {
					success: false,
					error: "Cloudflare rate-limited the request. Try again shortly.",
					responseTime,
				};
			}
			// Cloudflare's own text goes back to the browser: redact any echo
			// of the token from the whole raw text before cutting it to length.
			const detail = body?.errors
				?.map((e) => e?.message)
				.filter(
					(m): m is string => typeof m === "string" && m.length > 0,
				)
				.join("; ");
			const safeDetail = detail
				? redactCloudflareToken(detail, this.apiKey).slice(
						0,
						MAX_DETAIL_CHARS,
					)
				: "";
			return {
				success: false,
				error: `Connection failed (${response.status})${safeDetail ? `: ${safeDetail}` : ""}`,
				responseTime,
			};
		} catch (error) {
			const responseTime = Date.now() - startTime;
			const message =
				error instanceof Error ? error.message : String(error);
			if (/abort|timeout/i.test(message)) {
				return {
					success: false,
					error: "Connection timed out. Please try again.",
					responseTime,
				};
			}
			return {
				success: false,
				error: redactCloudflareToken(message, this.apiKey).slice(
					0,
					MAX_DETAIL_CHARS,
				),
				responseTime,
			};
		} finally {
			clearTimeout(timeoutId);
		}
	}
}
