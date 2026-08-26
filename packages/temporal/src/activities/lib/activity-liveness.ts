/**
 * Liveness + cancellation helpers for long-running activities.
 *
 * Two things every activity that does bounded-but-slow IO needs, and which are
 * easy to get subtly wrong:
 *
 *  - **Heartbeating.** An activity that declares `heartbeatTimeout` and then
 *    never heartbeats is KILLED at that timeout and retried, however healthy it
 *    actually is. The declaration is a promise to check in; this makes keeping
 *    it a one-liner.
 *  - **Bounding a fetch.** `fetch` has no default timeout, so a provider host
 *    that accepts the connection and then stalls holds the activity until
 *    `startToCloseTimeout` — burning the whole budget on one dead request.
 *
 * Both are written to work OUTSIDE an activity context too, because these
 * modules are called directly from unit tests, where `Context.current()` throws.
 */

import { Context, heartbeat } from "@temporalio/activity";

/**
 * Heartbeat, or do nothing when there is no activity context (unit tests).
 *
 * Deliberately swallows: the only failure mode is "not running inside an
 * activity", and an activity that cannot heartbeat should not fail the work it
 * was heartbeating about.
 */
export function safeHeartbeat(details?: unknown): void {
	try {
		heartbeat(details);
	} catch {
		// Not inside a Temporal activity — nothing to report liveness to.
	}
}

/**
 * An `AbortSignal` that fires when the request outlives `timeoutMs` OR when the
 * activity is cancelled, so a cancelled workflow tears down in-flight HTTP
 * instead of waiting for it. Outside an activity, only the timeout applies.
 */
export function requestAbortSignal(timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	try {
		return AbortSignal.any([timeout, Context.current().cancellationSignal]);
	} catch {
		// No activity context (unit tests) — the timeout alone is the bound.
		return timeout;
	}
}
