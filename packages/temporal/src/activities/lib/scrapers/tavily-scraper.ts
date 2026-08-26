/**
 * Tavily WebScraper adapter (URL Context Sources — commit 3 of 3).
 *
 * Endpoint:
 *   POST https://api.tavily.com/extract
 *   Authorization: Bearer <apiKey>
 *   body: { urls: [url], extract_depth: "advanced" }
 *
 * Response (success):
 *   { results: [{ url, raw_content }], failed_results: [...] }
 *
 * We call the array form with a single URL so we don't need a separate
 * single-URL endpoint. The first non-failed entry is returned.
 *
 * No `crawlSite` — Tavily Extract is per-URL, not a crawler. PATH_PREFIX
 * falls back to Firecrawl via the picker.
 *
 * Error mapping:
 *   - 401 / 403       → UNAUTHORIZED
 *   - 402 / 429       → QUOTA_EXCEEDED
 *   - AbortError      → TIMEOUT
 *   - body mentions
 *     robots/disallow → ROBOTS_BLOCKED
 *   - failed_results  → UNKNOWN (we surface the failure reason)
 */
import type {
	WebScrapeError,
	WebScrapeOptions,
	WebScrapeResult,
	WebScraper,
} from "../web-scraper";

const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
const DEFAULT_TIMEOUT_MS = 60_000;

interface TavilyExtractSuccessResult {
	url: string;
	raw_content?: string;
	title?: string;
}

interface TavilyExtractFailedResult {
	url: string;
	error?: string;
}

interface TavilyExtractResponse {
	results?: TavilyExtractSuccessResult[];
	failed_results?: TavilyExtractFailedResult[];
}

function mapHttpError(
	statusCode: number,
	bodyText: string | undefined,
): WebScrapeError {
	if (statusCode === 401 || statusCode === 403) {
		return {
			code: "UNAUTHORIZED",
			message:
				"Tavily rejected the API key. Re-check the configured key in Settings → Search Providers.",
			statusCode,
		};
	}
	if (statusCode === 402 || statusCode === 429) {
		return {
			code: "QUOTA_EXCEEDED",
			message:
				statusCode === 402
					? "Tavily returned 402 (out of credits) — check your Tavily plan."
					: "Tavily returned 429 (rate limited) — check your Tavily plan.",
			statusCode,
		};
	}
	return {
		code: "UNKNOWN",
		message: bodyText
			? `Tavily HTTP ${statusCode}: ${bodyText.slice(0, 200)}`
			: `Tavily HTTP ${statusCode}`,
		statusCode,
	};
}

export function createTavilyScraper(apiKey: string): WebScraper {
	return {
		providerName: "tavily",
		async scrapeUrl(
			url: string,
			opts: WebScrapeOptions = {},
		): Promise<WebScrapeResult> {
			const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			const controller = new AbortController();
			const timeoutHandle = setTimeout(
				() => controller.abort(),
				timeoutMs,
			);

			let response: Response;
			try {
				response = await fetch(TAVILY_EXTRACT_URL, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						urls: [url],
						extract_depth: "advanced",
					}),
					signal: controller.signal,
				});
			} catch (error) {
				clearTimeout(timeoutHandle);
				const aborted =
					error instanceof Error &&
					(error.name === "AbortError" ||
						/abort/i.test(error.message));
				return {
					success: false,
					error: aborted
						? {
								code: "TIMEOUT",
								message: `Tavily request to ${url} timed out after ${timeoutMs}ms`,
								cause: error,
							}
						: {
								code: "UNKNOWN",
								message:
									error instanceof Error
										? error.message
										: "Tavily network request failed",
								cause: error,
							},
				};
			} finally {
				clearTimeout(timeoutHandle);
			}

			const statusCode = response.status;
			const rawText = await response.text().catch(() => "");

			if (!response.ok) {
				return {
					success: false,
					error: mapHttpError(statusCode, rawText),
				};
			}

			let parsed: TavilyExtractResponse | undefined;
			try {
				parsed = rawText.length === 0 ? {} : JSON.parse(rawText);
			} catch (error) {
				return {
					success: false,
					error: {
						code: "UNKNOWN",
						message: `Tavily returned a non-JSON response (status ${statusCode})`,
						statusCode,
						cause: error,
					},
				};
			}

			const first = parsed?.results?.[0];
			if (!first) {
				const failureMessage = parsed?.failed_results?.[0]?.error;
				const lower = failureMessage?.toLowerCase() ?? "";
				if (lower.includes("robots") || lower.includes("disallow")) {
					return {
						success: false,
						error: {
							code: "ROBOTS_BLOCKED",
							message:
								failureMessage ?? "Tavily refused (robots)",
						},
					};
				}
				return {
					success: false,
					error: {
						code: "UNKNOWN",
						message:
							failureMessage ??
							"Tavily returned no successful results for the URL",
					},
				};
			}

			return {
				success: true,
				data: {
					pageUrl: first.url ?? url,
					pageTitle:
						typeof first.title === "string" &&
						first.title.length > 0
							? first.title
							: null,
					markdown: first.raw_content ?? "",
				},
			};
		},
	};
}
