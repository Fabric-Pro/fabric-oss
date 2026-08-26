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

export function describeReviewFailure(
	action: NewsletterReviewAction,
	error: unknown,
): ReviewFeedback {
	const message = error instanceof Error ? error.message.trim() : "";

	if (getOrpcCode(error) === "CONFLICT") {
		return {
			level: "info",
			message: message || GENERIC_CONFLICT,
			refresh: true,
		};
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
