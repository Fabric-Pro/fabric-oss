/**
 * Cloudflare Browser Rendering WebScraper adapter.
 *
 * Endpoint (Cloudflare API reference, "Browser Rendering › Markdown"):
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/browser-rendering/markdown
 *   Authorization: Bearer <api token>
 *   { "url": "<page>" }
 *
 * Response envelope: `{ success, result, errors: [{ code, message }] }` where
 * `result` is the page as Markdown, rendered in a real browser so JavaScript
 * pages come back populated. `meta.title` carries the page title when
 * Cloudflare reports one, and `result` may start with YAML front matter
 * holding a `title`.
 *
 * The account ID arrives as the provider row's stored endpoint (the
 * account-scoped API base URL). The request URL is rebuilt from the parsed
 * account ID, so only api.cloudflare.com is ever contacted; an endpoint that
 * does not parse yields no adapter (`createScraperByName` returns null).
 *
 * No `crawlSite` — Browser Rendering's `/markdown` is single-URL only.
 *
 * Error mapping:
 *   - 401 / 403 → UNAUTHORIZED
 *   - 402 / 429 → QUOTA_EXCEEDED (429 is Cloudflare's rate-limit status)
 *   - AbortError → TIMEOUT
 *   - `success: false` or a non-string `result` → UNKNOWN, with
 *     Cloudflare's own error message
 *   - anything else → UNKNOWN
 *
 * The API token is only ever placed in the Authorization header; no message
 * built here includes it.
 */
import {
	cloudflareMarkdownUrl,
	redactCloudflareToken,
} from "@repo/utils/cloudflare-browser-rendering";
import {
	guardDispatch,
	rethrowIfDispatchStopped,
	throwIfDispatchStopped,
} from "@repo/utils/dispatch-guard";
import type {
	WebScrapeError,
	WebScrapeOptions,
	WebScrapeResult,
	WebScraper,
} from "../web-scraper";

const DEFAULT_TIMEOUT_MS = 60_000;
const PROVIDER_LABEL = "Cloudflare Browser Rendering";

interface CloudflareError {
	code?: number;
	message?: string;
}

interface CloudflareMarkdownEnvelope {
	success?: boolean;
	result?: unknown;
	errors?: CloudflareError[];
	meta?: { title?: unknown };
}

/** Longest stretch of upstream error text carried into one message. */
const MAX_DETAIL_CHARS = 200;

/**
 * Cloudflare's error messages, joined. Each raw message has any echo of the
 * API token redacted before it is cut to length, so neither a message that
 * quotes the request nor the cut can carry the token, or part of it, into
 * logs or the source's stored error.
 */
function describeErrors(
	errors: CloudflareError[] | undefined,
	apiKey: string,
): string | null {
	if (!Array.isArray(errors) || errors.length === 0) {
		return null;
	}
	const parts = errors
		.map((e) => {
			const message =
				typeof e?.message === "string"
					? redactCloudflareToken(e.message, apiKey).slice(
							0,
							MAX_DETAIL_CHARS,
						)
					: "";
			const code = typeof e?.code === "number" ? ` (code ${e.code})` : "";
			return message ? `${message}${code}` : "";
		})
		.filter((part) => part.length > 0);
	if (parts.length === 0) {
		return null;
	}
	return parts.join("; ");
}

function isAbortError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "AbortError" ||
			error.name === "TimeoutError" ||
			/abort/i.test(error.message))
	);
}

function parseEnvelope(rawText: string): CloudflareMarkdownEnvelope | null {
	if (rawText.length === 0) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(rawText);
		return parsed && typeof parsed === "object"
			? (parsed as CloudflareMarkdownEnvelope)
			: null;
	} catch {
		return null;
	}
}

function mapHttpError(
	statusCode: number,
	envelope: CloudflareMarkdownEnvelope | null,
	apiKey: string,
): WebScrapeError {
	if (statusCode === 401 || statusCode === 403) {
		return {
			code: "UNAUTHORIZED",
			message: `${PROVIDER_LABEL} rejected the API token. Check the token and its Browser Rendering permission in Settings → Search Providers.`,
			statusCode,
		};
	}
	if (statusCode === 402 || statusCode === 429) {
		return {
			code: "QUOTA_EXCEEDED",
			message:
				statusCode === 429
					? `${PROVIDER_LABEL} returned 429 (rate limited) — check your Cloudflare plan's Browser Rendering limits.`
					: `${PROVIDER_LABEL} returned 402 — check your Cloudflare billing.`,
			statusCode,
		};
	}
	const detail = describeErrors(envelope?.errors, apiKey);
	return {
		code: "UNKNOWN",
		message: detail
			? `${PROVIDER_LABEL} HTTP ${statusCode}: ${detail}`
			: `${PROVIDER_LABEL} HTTP ${statusCode}`,
		statusCode,
	};
}

/**
 * The page title: Cloudflare's `meta.title`, else a `title:` line in leading
 * YAML front matter, else the first `# ` heading, else null.
 */
function extractTitle(markdown: string, metaTitle: unknown): string | null {
	if (typeof metaTitle === "string" && metaTitle.trim().length > 0) {
		return metaTitle.trim();
	}
	const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
	if (frontMatter?.[1]) {
		const titleLine = /^title:\s*(.+)$/m.exec(frontMatter[1]);
		const title = titleLine?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
		if (title) {
			return title;
		}
	}
	const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(markdown);
	return heading?.[1]?.trim() || null;
}

/**
 * Build the adapter for a stored account endpoint, or `null` when the
 * endpoint is missing or is not an account-scoped Cloudflare API base URL.
 */
export function createCloudflareScraper(
	apiKey: string,
	endpoint: string | null | undefined,
): WebScraper | null {
	const markdownUrl = cloudflareMarkdownUrl(endpoint);
	if (!markdownUrl) {
		return null;
	}
	return {
		providerName: "cloudflare",
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

			// The timer stays armed until the body has been read, so the
			// budget covers the whole request, not just the response headers.
			let response: Response | undefined;
			let rawText = "";
			try {
				// Inside a dispatch guard (an Advisor chat turn) a stopped
				// guard refuses before the request, and the request carries
				// the guard's abort signal beside the timeout's. Outside a
				// guard this returns the timeout's signal unchanged.
				const signal = await guardDispatch(controller.signal);
				// Awaiting the guard is itself an await: the latched stops
				// are checked again in the same run as the send.
				throwIfDispatchStopped();
				response = await fetch(markdownUrl, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify({ url }),
					signal,
					// The token must only ever reach api.cloudflare.com.
					redirect: "error",
				});
				rawText = await response.text();
			} catch (error) {
				// A stop leaves as an error: a { success: false } result would
				// be taken for a failed scrape. This covers the body read too.
				rethrowIfDispatchStopped(error);
				if (controller.signal.aborted || isAbortError(error)) {
					return {
						success: false,
						error: {
							code: "TIMEOUT",
							message: `${PROVIDER_LABEL} request to ${url} timed out after ${timeoutMs}ms`,
							cause: error,
						},
					};
				}
				if (!response) {
					return {
						success: false,
						error: {
							code: "UNKNOWN",
							message:
								error instanceof Error
									? redactCloudflareToken(
											error.message,
											apiKey,
										).slice(0, MAX_DETAIL_CHARS)
									: `${PROVIDER_LABEL} network request failed`,
							cause: error,
						},
					};
				}
				// The body could not be read: carry on with an empty one, which
				// the status and envelope checks below report.
				rawText = "";
			} finally {
				clearTimeout(timeoutHandle);
			}

			const statusCode = response.status;
			const envelope = parseEnvelope(rawText);

			if (!response.ok) {
				return {
					success: false,
					error: mapHttpError(statusCode, envelope, apiKey),
				};
			}

			if (!envelope) {
				return {
					success: false,
					error: {
						code: "UNKNOWN",
						message: `${PROVIDER_LABEL} returned a non-JSON response (status ${statusCode})`,
						statusCode,
					},
				};
			}

			if (
				envelope.success !== true ||
				typeof envelope.result !== "string"
			) {
				const detail = describeErrors(envelope.errors, apiKey);
				return {
					success: false,
					error: {
						code: "UNKNOWN",
						message: detail
							? `${PROVIDER_LABEL} could not render ${url}: ${detail}`
							: `${PROVIDER_LABEL} returned no Markdown for ${url}`,
						statusCode,
					},
				};
			}

			const markdown = envelope.result;
			return {
				success: true,
				data: {
					pageUrl: url,
					pageTitle: extractTitle(markdown, envelope.meta?.title),
					markdown,
				},
			};
		},
	};
}
