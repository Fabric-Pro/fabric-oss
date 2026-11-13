/**
 * Turns an approve/reject response — or a thrown client error — into the toast
 * the review panel should show and whether the cached pending list needs a
 * refresh (Fizzy #2172).
 *
 * Pure, co-located and unit-tested, mirroring `newsletter-send-status.ts`. The
 * panel component is large and hard to render in a test; the interesting rule
 * here is a decision, not a rendering, so it lives where it can be asserted
 * directly.
 *
 * The rule the card is about: a `CONFLICT` from these two procedures is NOT a
 * failure. The pending list is cached, so by the time Approve is clicked the row
 * may already have been decided in another tab, by a colleague, or reclaimed as
 * a stale review. The server now explains which of those happened; this maps it
 * to a neutral notice plus a refresh, so the stale row disappears instead of
 * sitting there under a red banner.
 */

// Generic oRPC helper — it lives under field-mapping/ for historical reasons but
// has nothing field-mapping-specific about it.
import { getOrpcCode } from "./field-mapping/orpc-error";

export type NewsletterReviewAction = "approve" | "reject";

export interface ReviewFeedback {
	/** Which `sonner` toast to raise. */
	level: "success" | "info" | "error";
	message: string;
	/** Refetch the pending list (and the send history) after showing it. */
	refresh: boolean;
}

/**
 * The server's own copy is preferred whenever it sent some — it names the exact
 * state the row was found in. These are only the fallbacks for a response that
 * reports an idempotent outcome without a notice.
 */
const ALREADY_RESOLVED_FALLBACK: Record<NewsletterReviewAction, string> = {
	approve: "This newsletter was already approved.",
	reject: "This newsletter was already rejected.",
};

const FRESH_SUCCESS: Record<NewsletterReviewAction, string> = {
	approve: "Newsletter approved — sending",
	reject: "Newsletter rejected",
};

const FAILURE_PREFIX: Record<NewsletterReviewAction, string> = {
	approve: "Failed to approve",
	reject: "Failed to reject",
};

/** Last-resort conflict copy — only reached if the server sent an empty message. */
const GENERIC_CONFLICT = "This newsletter is no longer awaiting review.";

export function describeReviewSuccess(
	action: NewsletterReviewAction,
	result: { outcome?: string | null; notice?: string | null },
): ReviewFeedback {
	// `already_resolved` means the row had already reached the requested state,
	// so nothing was dispatched by this click. Reporting the usual green
	// "sending" would claim an action that did not happen.
	if (result.outcome === "already_resolved") {
		return {
			level: "info",
			message: result.notice ?? ALREADY_RESOLVED_FALLBACK[action],
			refresh: true,
		};
	}
	return {
		level: "success",
		message: FRESH_SUCCESS[action],
		refresh: true,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message.trim() : "";
}

/** The neutral notice for a send that left review under the reviewer. */
function describeReviewConflict(error: unknown): ReviewFeedback {
	return {
		level: "info",
		message: errorMessage(error) || GENERIC_CONFLICT,
		refresh: true,
	};
}

export function describeReviewFailure(
	action: NewsletterReviewAction,
	error: unknown,
): ReviewFeedback {
	const message = errorMessage(error);

	if (getOrpcCode(error) === "CONFLICT") {
		return describeReviewConflict(error);
	}

	// A real failure. Deliberately does NOT refresh: the row is still awaiting
	// this reviewer's decision, and swapping the list out from under them would
	// discard the highlight selections they have already made.
	return {
		level: "error",
		message: `${FAILURE_PREFIX[action]}: ${message || "Unknown error"}`,
		refresh: false,
	};
}

/** Why an image was refused, from the server's `data.code` or the browser's own check. */
export type NewsletterImageRefusalCode =
	| "too_large"
	| "unsupported"
	| "highlight_full"
	| "capture_in_progress"
	| "capture_limit"
	| "no_capture_environment";

const IMAGE_REFUSAL_COPY: Record<NewsletterImageRefusalCode, string> = {
	too_large:
		"That image is too large even after shrinking. Try a smaller one.",
	unsupported: "Use a PNG or JPEG image.",
	highlight_full: "This highlight already has two images.",
	capture_in_progress: "This screenshot is already being captured.",
	capture_limit:
		"This newsletter has reached its limit of screenshot captures. Upload an image instead.",
	no_capture_environment:
		"Choose an environment to capture from in the release notes settings first.",
};

const IMAGE_FAILURE_FALLBACK = "Could not save the image. Try again.";

function isImageRefusalCode(
	value: unknown,
): value is NewsletterImageRefusalCode {
	return (
		typeof value === "string" && Object.hasOwn(IMAGE_REFUSAL_COPY, value)
	);
}

function readDataCode(error: unknown): unknown {
	if (typeof error !== "object" || error === null || !("data" in error)) {
		return undefined;
	}
	const { data } = error;
	if (typeof data !== "object" || data === null || !("code" in data)) {
		return undefined;
	}
	return data.code;
}

export function describeImageRefusal(code: NewsletterImageRefusalCode): string {
	return IMAGE_REFUSAL_COPY[code];
}

/**
 * The toast for a failed image write. A CONFLICT means the send left review
 * under the reviewer: the same neutral notice as approve/reject, and the panel
 * refreshes (and closes). A capture still running is also a CONFLICT, but
 * carries its own code and leaves the panel open. Nothing else refreshes, so
 * the reviewer's unsaved ticks and order survive.
 */
export function describeImageFailure(error: unknown): ReviewFeedback {
	const code = readDataCode(error);
	if (getOrpcCode(error) === "CONFLICT" && code !== "capture_in_progress") {
		return describeReviewConflict(error);
	}
	return {
		level: "error",
		message: isImageRefusalCode(code)
			? IMAGE_REFUSAL_COPY[code]
			: IMAGE_FAILURE_FALLBACK,
		refresh: false,
	};
}
