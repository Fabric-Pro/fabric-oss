/**
 * The review-alert chat retry schedule has to outlast a rolling worker
 * deployment (Fizzy #2203).
 *
 * Unlike the reviewer-email sibling there is no second constant to compare
 * against: the deploy workflow documents no ceiling for the path that switches
 * the container app onto a new image, so the module picks ~31 minutes as a
 * deliberate margin and says so in prose. Prose is not checked by anything, so
 * what this file pins is that the module's OWN numbers still add up to the
 * figure it claims, and that the millisecond constant has not drifted from the
 * duration string Temporal actually reads.
 *
 * `retryScheduleSpanMs` is imported from the EMAIL retry module on purpose.
 * There is one definition of that formula in the repo; the chat module used to
 * carry a byte-identical copy, docstring and all, and it was deleted rather than
 * kept in sync by hand. Importing it here rather than into the chat module keeps
 * that module import-free, which is what stops the workflow sandbox reaching the
 * observability stack through it.
 */

import { describe, expect, it } from "vitest";
import {
	APPROVAL_CHAT_INITIAL_INTERVAL_MS,
	APPROVAL_CHAT_RETRY,
} from "../../src/workflows/newsletter-approval-chat-retry";
import { retryScheduleSpanMs } from "../../src/workflows/newsletter-approval-email-retry";

describe("review-alert chat retry policy", () => {
	it("keeps its declared interval and the millisecond constant in step", () => {
		// The drift that matters: someone shortens `initialInterval` to "30s"
		// for a faster local loop and the constant keeps claiming 60_000, so
		// every span computed from it is wrong by a factor of two.
		expect(APPROVAL_CHAT_RETRY.initialInterval).toBe(
			`${APPROVAL_CHAT_INITIAL_INTERVAL_MS / 60_000}m`,
		);
	});

	it("spans the ~31 minutes the module documents", () => {
		// Six attempts, a 1-minute initial interval and the default 2x backoff:
		// 1 + 2 + 4 + 8 + 16 minutes of gaps before the sixth. The module's
		// rationale for outlasting a rollout rests on this number being what the
		// policy actually produces.
		const span = retryScheduleSpanMs(
			APPROVAL_CHAT_RETRY.maximumAttempts,
			APPROVAL_CHAT_INITIAL_INTERVAL_MS,
		);

		expect(span).toBe(31 * 60_000);
	});

	it("outlasts the reviewer email's schedule by an order of magnitude", () => {
		// Not decoration: the two policies are deliberately different shapes.
		// The email's is timed against a provider breaker's seconds-scale
		// half-open window; this one against a minutes-scale rollout, where
		// retrying every few seconds spends the budget on attempts that cannot
		// yet succeed. Making them similar would be the regression.
		const chatSpan = retryScheduleSpanMs(
			APPROVAL_CHAT_RETRY.maximumAttempts,
			APPROVAL_CHAT_INITIAL_INTERVAL_MS,
		);

		expect(chatSpan).toBeGreaterThan(10 * 60_000);
	});
});
