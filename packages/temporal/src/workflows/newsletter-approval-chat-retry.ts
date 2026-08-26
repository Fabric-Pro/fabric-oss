/**
 * Retry policy for the release-notes review-alert chat post (Fizzy #2203).
 *
 * Split out of the workflow module for the same reason as
 * `newsletter-approval-email-retry.ts`: the workflow sandbox must not import
 * anything that pulls in the observability stack, so the rationale and the
 * numbers live in their own import-free file instead of inline at the
 * `proxyActivities` call site.
 *
 * ## Why the schedule has to outlast a rolling worker deployment
 *
 * Temporal hands a scheduled activity to whichever task-queue worker replica
 * picks it up, with no guarantee it lands on one that has already loaded the
 * latest code. During a rolling deploy, old and new replicas serve the same
 * task queue for as long as the rollout takes to settle, and an activity this
 * new — shipped in the same release as the workflow step that schedules it —
 * can be handed to a replica that has not registered it yet. That attempt
 * fails immediately with an unrecognized-activity error, which no amount of
 * fast retrying fixes: only the rollout finishing, and a different replica
 * picking up the retry, does.
 *
 * The deploy workflow does not document a fixed duration for this path: the
 * Bicep deployment that switches the container app onto a new image runs to
 * whatever completion ARM takes, with no stated ceiling. (The one hard
 * ~15-minute figure in that workflow belongs to a different job —
 * sync-keyvault-secrets' post-rotation settle wait — which only runs when a
 * secret value actually changed, not on an ordinary code deploy, so it isn't
 * a bound on this failure mode.) Absent a documented number to size against,
 * this schedule's ~31-minute total span (six attempts, a 1-minute initial
 * interval, the default 2x backoff) is a deliberate, generous margin: long
 * enough that a stale-replica activity rides out an ordinary rollout and
 * heals onto an upgraded replica automatically, rather than exhausting its
 * budget mid-rollout and losing the alert for that cycle.
 *
 * This is deliberately a much longer initial interval than the reviewer
 * email's policy. That policy is timed against a provider breaker's
 * *seconds*-scale half-open window, where a fast retry can catch the
 * breaker closing. This failure mode resolves only once a *minutes*-scale
 * rollout finishes, so retrying every few seconds during that window would
 * just spend the budget on attempts that cannot yet succeed.
 */

/** `initialInterval` below, in milliseconds — the test computes with this. */
export const APPROVAL_CHAT_INITIAL_INTERVAL_MS = 60_000;

export const APPROVAL_CHAT_RETRY = {
	maximumAttempts: 6,
	initialInterval: "1m",
} as const;

// `retryScheduleSpanMs` deliberately does NOT live here. It used to, as a
// byte-identical copy of the one in `newsletter-approval-email-retry.ts` —
// docstring included — which is one definition of a formula too many for two
// files that must agree about it. The test for this module imports the email
// module's copy. That keeps THIS file import-free, which is the property the
// header above depends on: the workflow sandbox must not reach the
// observability stack through it.
