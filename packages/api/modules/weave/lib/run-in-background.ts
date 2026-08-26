import { logger } from "@repo/logs";
import { waitUntil } from "@vercel/functions";

/**
 * Schedule a continuation that must keep running after the response is sent.
 *
 * On Vercel, a bare `void promise` is not guaranteed to finish once the
 * response returns — `waitUntil` extends the function lifetime until the
 * promise settles. Off Vercel (local dev, tests) the promise is already
 * executing eagerly and `waitUntil` degrades to a no-op lifetime extension.
 *
 * The rejection handler belongs here rather than at each call site: by the time
 * one of these settles the response has already been sent, so there is no
 * request left to surface the failure to, and an unhandled rejection takes the
 * warm instance with it. Callers schedule work they have already decided not to
 * wait for — they should not each have to remember that.
 *
 * Kept as a local wrapper so tests can assert "continuation scheduled" by
 * mocking this module instead of `@vercel/functions`.
 */
export function runInBackground(promise: Promise<unknown>): void {
	waitUntil(
		promise.catch((error) => {
			logger.warn("background continuation failed", error);
		}),
	);
}
