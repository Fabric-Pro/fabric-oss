/**
 * Retry policy for the release-notes reviewer email (Fizzy #2172).
 *
 * Split out of the workflow module so the schedule can be asserted against the
 * provider breaker's half-open window in a test. The two numbers cannot meet in
 * the workflow itself: the workflow sandbox must not import
 * `@repo/observability`, which pulls in OpenTelemetry and cockatiel. So this
 * file stays import-free and the test does the comparison.
 *
 * ## Why the schedule has to outlast the breaker
 *
 * `sendEmail` runs inside `withProviderBreaker("resend", …)`, which opens after
 * five consecutive failures and stays open for 30 seconds. Until this branch
 * the Resend adapter reported provider rejections as successes, so that breaker
 * never opened from an API error and this interaction did not exist. It does
 * now.
 *
 * A schedule that finishes inside the open window is not merely unlucky — every
 * one of its retries is a guaranteed no-op, rejected locally without ever
 * reaching Resend. The activity would burn its whole budget during the outage
 * and the workflow would swallow the failure, leaving every reviewer unmailed
 * even though the provider recovered seconds later. The last attempt therefore
 * has to land after the breaker half-opens.
 *
 * This narrows the window rather than closing it. The breaker is shared across
 * everything that mails through Resend in this process, so a concurrent send can
 * still consume the single half-open probe. Closing that needs the per-recipient
 * outbox this activity deliberately does without.
 */

/** `initialInterval` below, in milliseconds — the test computes with this. */
export const APPROVAL_EMAIL_INITIAL_INTERVAL_MS = 5_000;

export const APPROVAL_EMAIL_RETRY = {
	maximumAttempts: 4,
	initialInterval: "5s",
} as const;

/**
 * Elapsed time from the first attempt to the last, for a Temporal retry policy
 * using the default backoff coefficient of 2 and no `maximumInterval` cap.
 *
 * Temporal waits `initialInterval * 2^n` before attempt `n + 2`, so the span is
 * the sum of those gaps: `initialInterval * (2^(attempts - 1) - 1)`.
 */
export function retryScheduleSpanMs(
	attempts: number,
	initialIntervalMs: number,
): number {
	if (attempts <= 1) {
		return 0;
	}
	return initialIntervalMs * (2 ** (attempts - 1) - 1);
}
