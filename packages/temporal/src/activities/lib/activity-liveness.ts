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

/** How often `withHeartbeatTicker` checks in. Well inside any sane `heartbeatTimeout`. */
export const HEARTBEAT_TICK_MS = 10_000;

/**
 * True when called from inside a running Temporal activity.
 *
 * `Context.current()` throws outside one, and that is the only signal there is.
 */
export function inActivityContext(): boolean {
	try {
		Context.current();
		return true;
	} catch {
		return false;
	}
}

/**
 * Run `fn` while heartbeating on a fixed interval, stopping when it settles.
 *
 * For an activity whose work is one long, otherwise silent call — a 30 s HTTP
 * request, an AI generation, a browser session, an approval poll — there is no
 * natural point in the code to heartbeat from. Declaring `heartbeatTimeout` on
 * such an activity without this kills it at that timeout however healthy it
 * is, and the retry re-runs the side effect. The ticker keeps the promise the
 * declaration made; `heartbeatTimeout` stays meaningful for a worker that has
 * actually died, because a dead worker stops ticking.
 *
 * `fn`'s outcome is passed through untouched. The interval is cleared in
 * `finally`, so it cannot outlive a throw, and it is `unref`'d so it never
 * holds the process open on its own.
 *
 * Outside an activity (unit tests calling the activity function directly) this
 * is a plain call: no interval is started and nothing is heartbeated.
 */
export async function withHeartbeatTicker<T>(
	fn: () => Promise<T>,
	options: { details?: unknown; intervalMs?: number } = {},
): Promise<T> {
	if (!inActivityContext()) {
		return await fn();
	}

	const intervalMs = options.intervalMs ?? HEARTBEAT_TICK_MS;
	// Check in immediately as well: a node that fails fast should still leave
	// one heartbeat behind, and the first tick is otherwise a full interval out.
	safeHeartbeat(options.details);
	const ticker = setInterval(
		() => safeHeartbeat(options.details),
		intervalMs,
	);
	ticker.unref?.();

	try {
		return await fn();
	} finally {
		clearInterval(ticker);
	}
}
