/**
 * One provider call for the web-research endpoint, within its limits.
 *
 * Each call is capped at 20 seconds. Search results carry no page `content`:
 * evidence comes only from reading a page, so a snippet can never stand in
 * for it, and snippets are cut to 500 characters. A read returns at most
 * 12,000 characters of page text and says whether it was cut.
 *
 * Failure messages are fixed per error code. A provider's own message can
 * echo the query or the URL, so it never reaches the response or the logs.
 */

import type {
	WebResearchSearcher,
	WebScrapeErrorCode,
	WebScraper,
} from "@repo/temporal/activities";
import { cutAtCodeUnits } from "@repo/utils/cut-at-code-units";
import type { ConfidentialMatcher } from "./confidential-terms";
import { checkResearchUrl, type UrlRejectionReason } from "./url-policy";

export const PROVIDER_CALL_TIMEOUT_MS = 20_000;
export const MAX_PAGE_CONTENT_LENGTH = 12_000;
const MAX_SNIPPET_LENGTH = 500;

export interface ResearchCallFailure {
	ok: false;
	status: 422 | 502;
	code: "SEARCH_FAILED" | "FETCH_FAILED" | "URL_NOT_ALLOWED";
	message: string;
	/** A short, content-free label for the logs. */
	logKind: string;
	reason?: UrlRejectionReason;
}

interface WebSearchHit {
	url: string;
	title: string;
	snippet: string;
	publishedDate?: string;
	author?: string;
}

export interface WebSearchSuccess {
	ok: true;
	provider: string;
	results: WebSearchHit[];
}

export interface ReadUrlSuccess {
	ok: true;
	url: string;
	finalUrl: string;
	title?: string;
	publisher: string;
	content: string;
	truncated: boolean;
}

const SEARCH_FAILED_MESSAGE = "The web search failed. Try again later.";
const SEARCH_TIMEOUT_MESSAGE = "The web search took too long and was stopped.";
const READ_TIMEOUT_MESSAGE = "The page took too long to load.";
const READ_EMPTY_MESSAGE = "The page has no readable text.";
const READ_REDIRECT_MESSAGE =
	"The page redirected to an address that may not be read.";

const READ_FAILURE_MESSAGES: Record<WebScrapeErrorCode, string> = {
	ROBOTS_BLOCKED: "The site does not allow automated reading of this page.",
	QUOTA_EXCEEDED:
		"The page-reading provider is out of quota or rate-limited. Try again later.",
	TIMEOUT: READ_TIMEOUT_MESSAGE,
	UNAUTHORIZED:
		"The page-reading provider rejected the organization's credentials.",
	UNSUPPORTED_CONTENT_TYPE: "The URL does not point to a readable text page.",
	UNKNOWN: "The page could not be read.",
};

class ProviderTimeoutError extends Error {
	constructor() {
		super("Provider call timed out");
		this.name = "ProviderTimeoutError";
	}
}

/**
 * Settles with `promise` or rejects after `ms`. The provider's own request is
 * not aborted; its late result is ignored.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new ProviderTimeoutError()), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** A content-free label for an error: its class name, never its message. */
export function errorClass(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}

export async function runWebSearch(
	searcher: WebResearchSearcher,
	query: string,
	maxResults: number,
): Promise<WebSearchSuccess | ResearchCallFailure> {
	try {
		const results = await withTimeout(
			searcher.search(query, maxResults),
			PROVIDER_CALL_TIMEOUT_MS,
		);
		return {
			ok: true,
			provider: searcher.providerName,
			results: results.slice(0, maxResults).map((result) => ({
				url: result.url,
				title: result.title,
				snippet: cutAtCodeUnits(
					result.snippet ?? "",
					MAX_SNIPPET_LENGTH,
				),
				...(result.publishedDate && {
					publishedDate: result.publishedDate,
				}),
				...(result.author && { author: result.author }),
			})),
		};
	} catch (error) {
		const timedOut = error instanceof ProviderTimeoutError;
		return {
			ok: false,
			status: 502,
			code: "SEARCH_FAILED",
			message: timedOut ? SEARCH_TIMEOUT_MESSAGE : SEARCH_FAILED_MESSAGE,
			logKind: timedOut ? "timeout" : errorClass(error),
		};
	}
}

function readFailure(message: string, logKind: string): ResearchCallFailure {
	return { ok: false, status: 502, code: "FETCH_FAILED", message, logKind };
}

/** `url` must already have passed the URL policy. */
export async function runReadUrl(
	scraper: WebScraper,
	url: URL,
	matcher: ConfidentialMatcher,
): Promise<ReadUrlSuccess | ResearchCallFailure> {
	let scraped: Awaited<ReturnType<WebScraper["scrapeUrl"]>>;
	try {
		scraped = await withTimeout(
			scraper.scrapeUrl(url.href, {
				timeoutMs: PROVIDER_CALL_TIMEOUT_MS,
			}),
			PROVIDER_CALL_TIMEOUT_MS,
		);
	} catch (error) {
		return error instanceof ProviderTimeoutError
			? readFailure(READ_TIMEOUT_MESSAGE, "timeout")
			: readFailure(READ_FAILURE_MESSAGES.UNKNOWN, errorClass(error));
	}

	if (!scraped.success) {
		return readFailure(
			READ_FAILURE_MESSAGES[scraped.error.code] ??
				READ_FAILURE_MESSAGES.UNKNOWN,
			scraped.error.code,
		);
	}

	const text = scraped.data.markdown ?? "";
	if (text.trim() === "") {
		return readFailure(READ_EMPTY_MESSAGE, "empty");
	}

	// The address the provider reports is checked as reported: one that is
	// not a public http(s) URL refuses the page rather than falling back to
	// the request. Only a provider that reports none falls back.
	const finalUrl = scraped.data.pageUrl?.trim() || url.href;
	const redirect = checkResearchUrl(finalUrl, matcher);
	if (!redirect.allowed) {
		return {
			ok: false,
			status: 422,
			code: "URL_NOT_ALLOWED",
			message: READ_REDIRECT_MESSAGE,
			logKind: "redirect",
			reason: redirect.reason,
		};
	}

	const content = cutAtCodeUnits(text, MAX_PAGE_CONTENT_LENGTH);
	const title = scraped.data.pageTitle?.trim();
	return {
		ok: true,
		url: url.href,
		finalUrl: redirect.url.href,
		...(title && { title }),
		publisher: redirect.url.hostname.replace(/^www\./, ""),
		content,
		truncated: content.length < text.length,
	};
}
