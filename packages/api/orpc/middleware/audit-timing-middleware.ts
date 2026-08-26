/**
 * Audit-timing middleware.
 *
 * Measures the elapsed wall-clock time for every oRPC procedure
 * invocation and stashes the value in an AsyncLocalStorage frame that
 * `recordAuditFromRequest` reads when assembling an audit row.
 *
 * Why AsyncLocalStorage rather than the oRPC `context` argument? oRPC
 * middlewares can only mutate `context` BEFORE awaiting `next()`. The
 * audit row is emitted INSIDE the procedure handler — by then the
 * timing middleware has not yet seen the result. We therefore:
 *
 *   1. Open an ALS frame with a mutable `{ startedAt }` payload.
 *   2. Run the handler inside it.
 *   3. After the handler returns, compute `Date.now() - startedAt` and
 *      write it into the payload.
 *   4. `recordAuditFromRequest` reads the same payload synchronously on
 *      its way out and attaches `durationMs` to the audit row.
 *
 * The handler may emit MULTIPLE audit rows; all of them carry the same
 * elapsed time — the value reflects total procedure latency, not
 * per-emission latency. This is fine for the v1 use case (operator
 * triage of "what was slow"); per-row instrumentation is a future
 * enhancement.
 *
 * Failure modes:
 *   - The middleware never throws. If something goes wrong with the ALS
 *     bookkeeping, the audit row simply has `durationMs: null`.
 *   - Test harnesses that bypass the middleware also produce null
 *     durations — by design.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { os } from "@orpc/server";
import { getCorrelationIdFromContext } from "../../lib/correlation-id";
import {
	detachSpansForFlush,
	dropSpans,
	runWithRequestSpanContext,
} from "../../lib/request-span";

interface AuditTimingFrame {
	/** High-resolution timestamp captured at procedure entry. */
	startedAtMs: number;
	/**
	 * Filled in by the middleware after the handler returns or throws.
	 * Audit rows emitted DURING the handler read `startedAtMs` and
	 * compute the elapsed value themselves; rows emitted AFTER the
	 * handler (rare) can read this directly.
	 */
	durationMs: number | null;
	/**
	 * Set when a CURATED audit row (any action outside the machine-derived
	 * `activity.*` namespace) is written during this procedure.
	 *
	 * The automatic activity middleware reads this to decide whether to emit a
	 * generic row: a procedure that already recorded a purpose-built event
	 * (`project.created`, `org.member.removed`) must not also produce an
	 * `activity.projects.create` row, or the viewer shows every meaningful
	 * action twice.
	 */
	curatedAuditWritten: boolean;
}

const auditTimingStorage = new AsyncLocalStorage<AuditTimingFrame>();

/**
 * Mark the current procedure as having written a curated audit row.
 *
 * Called from `recordAuditFromRequest` rather than from each procedure, so a
 * new curated emission automatically suppresses its generic counterpart with no
 * per-call-site bookkeeping.
 *
 * SAFETY: never throws — no active frame is a no-op.
 */
export function markCuratedAuditWritten(): void {
	try {
		const frame = auditTimingStorage.getStore();
		if (frame) {
			frame.curatedAuditWritten = true;
		}
	} catch {
		// Deliberately swallowed: bookkeeping must never break a request.
	}
}

/**
 * Did this procedure already write a curated audit row? Returns `false`
 * outside an active frame, which biases toward capturing rather than losing an
 * event.
 */
export function hasCuratedAuditWritten(): boolean {
	try {
		return auditTimingStorage.getStore()?.curatedAuditWritten === true;
	} catch {
		return false;
	}
}

/**
 * Read the current procedure's elapsed wall-clock time in milliseconds.
 * Returns `null` outside an active timing frame (e.g. Temporal
 * activities, retention purges, tests that don't mount the middleware).
 *
 * SAFETY: never throws — a missing frame returns null.
 */
export function getAuditTimingDurationMs(): number | null {
	try {
		const frame = auditTimingStorage.getStore();
		if (!frame) {
			return null;
		}
		// If the handler has already finished (rare — only used for rows
		// emitted in `finally` blocks), prefer the stored value.
		if (typeof frame.durationMs === "number") {
			return frame.durationMs;
		}
		const now = Date.now();
		return Math.max(0, now - frame.startedAtMs);
	} catch {
		return null;
	}
}

/**
 * The middleware itself. Mounts on the public procedure chain BEFORE
 * the auth check so latency includes session-resolution time (which
 * is the operator-relevant metric — "did auth slow this request
 * down?").
 *
 * Mounts INSIDE the audit-error middleware so timing is captured even
 * for procedures that throw before the handler emits any audit row;
 * the error middleware reads the same ALS frame.
 */
export const auditTimingMiddleware = os
	.$context<{
		headers: Headers;
	}>()
	.middleware(async ({ next }) => {
		const frame: AuditTimingFrame = {
			startedAtMs: Date.now(),
			durationMs: null,
			curatedAuditWritten: false,
		};
		// v2 item 4: open a request-span buffering frame keyed by the
		// active correlationId. Successful procedure invocations drop
		// the buffer on the way out (no DB write); failures are flushed
		// by the audit-error middleware via `flushSpansOnFailure`.
		// Tenant scope (org/user) cannot be resolved at this point in
		// the chain yet (auth middleware runs after timing), so we
		// start with null tenant fields; the error middleware re-stamps
		// these onto the audit row alongside the spans.
		const correlationId = getCorrelationIdFromContext() ?? "anonymous";
		const spanContext = {
			correlationId,
			organizationId: null as string | null,
			userId: null as string | null,
		};
		try {
			return await auditTimingStorage.run(frame, () =>
				runWithRequestSpanContext(spanContext, async () => {
					try {
						const result = await next();
						frame.durationMs = Math.max(
							0,
							Date.now() - frame.startedAtMs,
						);
						// Success path: discard the span buffer so we
						// don't pay a DB INSERT on the happy path.
						dropSpans();
						return result;
					} catch (err) {
						frame.durationMs = Math.max(
							0,
							Date.now() - frame.startedAtMs,
						);
						// We don't flush here: the audit-error middleware
						// owns failure capture and is the only place that
						// knows the resolved tenant.
						//
						// But it mounts OUTSIDE this middleware, so by the
						// time it runs this ALS frame has exited and its
						// `spanStorage.getStore()` returns undefined —
						// which meant `flushSpansOnFailure` returned having
						// written nothing, on every failure, and
						// `audit.tracedRequest` served an empty span list
						// while advertising db spans.
						//
						// Detach the buffer here, while the frame is still
						// live, and leave it keyed by correlationId for the
						// outer middleware to collect.
						detachSpansForFlush(correlationId);
						throw err;
					}
				}),
			);
		} catch (err) {
			// ALS run failed — extremely unlikely. Re-throw the original
			// error; downstream middleware (audit-error capture) still
			// observes the throw with `durationMs = null`.
			throw err;
		}
	});
