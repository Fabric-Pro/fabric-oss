/**
 * Exa WebScraper adapter (URL Context Sources — commit 3 of 3).
 *
 * Endpoint:
 *   POST https://api.exa.ai/contents
 *   x-api-key: <apiKey>
 *   body: { urls: [url], text: true }
 *
 * Response:
 *   { results: [{ id, url, title, text }], statuses: [{ id, status }] }
 *
 * No `crawlSite` — Exa /contents is per-URL retrieval, not a crawler.
 * PATH_PREFIX falls back to Firecrawl via the picker.
 *
 * Error mapping:
 *   - 401 / 403  → UNAUTHORIZED
 *   - 402 / 429  → QUOTA_EXCEEDED
 *   - AbortError → TIMEOUT
 *   - statuses[].error containing robots/disallow → ROBOTS_BLOCKED
 *   - anything else → UNKNOWN
 */
import type {
	WebScrapeError,
	WebScrapeOptions,
	WebScrapeResult,
	WebScraper,
} from "../web-scraper";

const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
const DEFAULT_TIMEOUT_MS = 60_000;

interface ExaContentsResult {
	id?: string;
	url?: string;
	title?: string;
	text?: string;
}

interface ExaContentsStatus {
	id?: string;
	status?: string;
	error?: string;
}

interface ExaContentsResponse {
	results?: ExaContentsResult[];
	statuses?: ExaContentsStatus[];
}

function mapHttpError(
	statusCode: number,
	bodyText: string | undefined,
): WebScrapeError {
	if (statusCode === 401 || statusCode === 403) {
		return {
			code: "UNAUTHORIZED",
			message:
				"Exa rejected the API key. Re-check the configured key in Settings → Search Providers.",
			statusCode,
		};
	}
	if (statusCode === 402 || statusCode === 429) {
		return {
			code: "QUOTA_EXCEEDED",
			message:
				statusCode === 402
					? "Exa returned 402 (out of credits) — check your Exa plan."
					: "Exa returned 429 (rate limited) — check your Exa plan.",
			statusCode,
		};
	}
	return {
		code: "UNKNOWN",
		message: bodyText
			? `Exa HTTP ${statusCode}: ${bodyText.slice(0, 200)}`
			: `Exa HTTP ${statusCode}`,
		statusCode,
	};
}

export function createExaScraper(apiKey: string): WebScraper {
	return {
		providerName: "exa",
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
				response = await fetch(EXA_CONTENTS_URL, {
					method: "POST",
					headers: {
						"x-api-key": apiKey,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						urls: [url],
						text: true,
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
								message: `Exa request to ${url} timed out after ${timeoutMs}ms`,
								cause: error,
							}
						: {
								code: "UNKNOWN",
								message:
									error instanceof Error
										? error.message
										: "Exa network request failed",
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

			let parsed: ExaContentsResponse | undefined;
			try {
				parsed = rawText.length === 0 ? {} : JSON.parse(rawText);
			} catch (error) {
				return {
					success: false,
					error: {
						code: "UNKNOWN",
						message: `Exa returned a non-JSON response (status ${statusCode})`,
						statusCode,
						cause: error,
					},
				};
			}

			const first = parsed?.results?.[0];
			if (!first || typeof first.text !== "string") {
				// Inspect statuses for a robots-blocked signal so the UI shows
				// the correct copy.
				const statusError = parsed?.statuses?.[0]?.error;
				const lower = statusError?.toLowerCase() ?? "";
				if (lower.includes("robots") || lower.includes("disallow")) {
					return {
						success: false,
						error: {
							code: "ROBOTS_BLOCKED",
							message: statusError ?? "Exa refused (robots)",
						},
					};
				}
				return {
					success: false,
					error: {
						code: "UNKNOWN",
						message:
							statusError ??
							"Exa returned no content for the URL",
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
					markdown: first.text,
				},
			};
		},
	};
}
