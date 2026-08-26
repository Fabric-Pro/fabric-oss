/**
 * Jina AI Reader WebScraper adapter (URL Context Sources — commit 3 of 3).
 *
 * Endpoint:
 *   GET https://r.jina.ai/{url}
 *   Authorization: Bearer <apiKey>
 *
 * The Reader API returns the markdown-converted body directly in the response
 * text (default `text/markdown`). When you request `Accept: application/json`,
 * Jina returns a JSON envelope `{ data: { title, content, url } }` — we use
 * that form so we can extract the page title without parsing the markdown.
 *
 * No `crawlSite` — Jina Reader is single-URL only. PATH_PREFIX crawls fall
 * back to Firecrawl via the picker (`get-web-scraper.ts`).
 *
 * Error mapping:
 *   - 401 / 403 → UNAUTHORIZED
 *   - 402 / 429 → QUOTA_EXCEEDED
 *   - AbortError → TIMEOUT
 *   - body mentions "robots" / "disallow" → ROBOTS_BLOCKED
 *   - anything else → UNKNOWN
 */
import type {
	WebScrapeError,
	WebScrapeOptions,
	WebScrapeResult,
	WebScraper,
} from "../web-scraper";

const JINA_READER_BASE = "https://r.jina.ai";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Jina's documented JSON response shape. We only depend on the inner `data`
 * object — extra fields are passed through and ignored.
 */
interface JinaReaderResponseEnvelope {
	code?: number;
	status?: number;
	data?: {
		title?: string;
		content?: string;
		url?: string;
	};
}

function mapHttpError(
	statusCode: number,
	bodyText: string | undefined,
): WebScrapeError {
	if (statusCode === 401 || statusCode === 403) {
		return {
			code: "UNAUTHORIZED",
			message:
				"Jina rejected the API key. Re-check the configured key in Settings → Search Providers.",
			statusCode,
		};
	}
	if (statusCode === 402 || statusCode === 429) {
		return {
			code: "QUOTA_EXCEEDED",
			message:
				statusCode === 402
					? "Jina returned 402 (out of credits) — check your Jina plan."
					: "Jina returned 429 (rate limited) — check your Jina plan.",
			statusCode,
		};
	}
	if (bodyText) {
		const lower = bodyText.toLowerCase();
		if (lower.includes("robots") || lower.includes("disallow")) {
			return {
				code: "ROBOTS_BLOCKED",
				message: bodyText,
				statusCode,
			};
		}
	}
	return {
		code: "UNKNOWN",
		message: bodyText
			? `Jina HTTP ${statusCode}: ${bodyText.slice(0, 200)}`
			: `Jina HTTP ${statusCode}`,
		statusCode,
	};
}

export function createJinaScraper(apiKey: string): WebScraper {
	return {
		providerName: "jina",
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
				// The Reader API URL is built by appending the *encoded* target
				// URL as a path segment. Encoding the colons/slashes here would
				// double-encode — pass the literal URL string, as the docs do.
				response = await fetch(`${JINA_READER_BASE}/${url}`, {
					method: "GET",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						Accept: "application/json",
					},
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
								message: `Jina request to ${url} timed out after ${timeoutMs}ms`,
								cause: error,
							}
						: {
								code: "UNKNOWN",
								message:
									error instanceof Error
										? error.message
										: "Jina network request failed",
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

			let parsed: JinaReaderResponseEnvelope | undefined;
			try {
				parsed = rawText.length === 0 ? {} : JSON.parse(rawText);
			} catch (error) {
				return {
					success: false,
					error: {
						code: "UNKNOWN",
						message: `Jina returned a non-JSON response (status ${statusCode})`,
						statusCode,
						cause: error,
					},
				};
			}

			const data = parsed?.data;
			const markdown = data?.content ?? "";
			const pageUrl = data?.url ?? url;
			const pageTitle =
				typeof data?.title === "string" && data.title.length > 0
					? data.title
					: null;

			return {
				success: true,
				data: {
					pageUrl,
					pageTitle,
					markdown,
				},
			};
		},
	};
}
