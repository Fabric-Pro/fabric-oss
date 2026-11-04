/**
 * An unsupported content type is an expected outcome of a URL scrape, not an
 * error. A crawl under a path prefix routinely meets images, archives and
 * other files the provider cannot turn into Markdown; the provider answers
 * with `UNSUPPORTED_CONTENT_TYPE` (for example "The URL returned a file type
 * that Firecrawl cannot process: image/svg+xml").
 *
 * The Firecrawl activities used to throw that as a non-retryable
 * `ApplicationFailure`, which the worker logged as an exception. When the
 * caller sets `reportUnsupportedContent`, they now log one warning and
 * return `unsupported` instead; the workflow then takes the same path the
 * failure took. Without the flag they keep throwing, so a workflow worker
 * still on the earlier code, which cannot read the outcome, never receives
 * one during a rollout.
 */
import { activityLogger } from "../../lib/activity-logger";

/** What the scrape reported about a URL whose file type cannot be indexed. */
export interface UnsupportedContent {
	/** The MIME type named in the provider's message, when it names one. */
	contentType?: string;
	/** The provider's message, unchanged: the reason shown to the user. */
	message: string;
}

const MIME_TYPE =
	/\b((?:application|audio|font|image|model|text|video)\/[a-z0-9][a-z0-9.+-]*[a-z0-9+])/i;

/** The MIME type a provider's message names, if any. */
export function contentTypeFromMessage(message: string): string | undefined {
	return MIME_TYPE.exec(message)?.[1]?.toLowerCase();
}

/**
 * The outcome for a URL whose file type cannot be indexed, logged as the one
 * expected skip. Logs the URL and the content type only; the API key never
 * reaches this function.
 */
export function unsupportedContentOutcome(
	url: string,
	error: { message: string },
): UnsupportedContent {
	const contentType = contentTypeFromMessage(error.message);
	activityLogger.warn(
		"URL is a file type that cannot be indexed; skipped (expected)",
		{ url, contentType },
	);
	return contentType === undefined
		? { message: error.message }
		: { contentType, message: error.message };
}
