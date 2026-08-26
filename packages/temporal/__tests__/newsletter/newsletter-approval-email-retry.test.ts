/**
 * The reviewer-email retry schedule has to outlast the Resend breaker's
 * half-open window (Fizzy #2172, Codex review).
 *
 * These two numbers live in different packages and neither file can import the
 * other — the workflow sandbox must not pull in `@repo/observability`. So the
 * invariant that ties them together is asserted here, where both are reachable.
 */

import { DEFAULT_HALF_OPEN_AFTER_MS } from "@repo/observability/breakers";
import { describe, expect, it } from "vitest";
import {
	APPROVAL_EMAIL_INITIAL_INTERVAL_MS,
	APPROVAL_EMAIL_RETRY,
	retryScheduleSpanMs,
} from "../../src/workflows/newsletter-approval-email-retry";

describe("retryScheduleSpanMs", () => {
	it("is zero for a policy that never retries", () => {
		expect(retryScheduleSpanMs(1, 5_000)).toBe(0);
	});

	it("sums the doubling gaps between attempts", () => {
		// Gaps of 5s and 10s → last attempt begins 15s after the first.
		expect(retryScheduleSpanMs(3, 5_000)).toBe(15_000);
		// …plus a 20s gap.
		expect(retryScheduleSpanMs(4, 5_000)).toBe(35_000);
	});
});

describe("reviewer-email retry policy", () => {
	it("keeps its declared interval and the millisecond constant in step", () => {
		expect(APPROVAL_EMAIL_RETRY.initialInterval).toBe(
			`${APPROVAL_EMAIL_INITIAL_INTERVAL_MS / 1000}s`,
		);
	});

	it("lands its final attempt after the breaker half-opens", () => {
		// The point of the assertion: a schedule that finishes inside the open
		// window does not merely retry too few times — every retry is rejected
		// locally without reaching Resend, so the budget buys nothing at all and
		// the reviewers go unmailed through an outage the provider recovered
		// from seconds later.
		const span = retryScheduleSpanMs(
			APPROVAL_EMAIL_RETRY.maximumAttempts,
			APPROVAL_EMAIL_INITIAL_INTERVAL_MS,
		);

		expect(span).toBeGreaterThan(DEFAULT_HALF_OPEN_AFTER_MS);
	});
});
