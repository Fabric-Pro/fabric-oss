/**
 * A send deadline for a write that must not leave the process late: a PM
 * create sent under its create claim (Fizzy #3045).
 *
 * The deadline is a reading of this process's monotonic clock
 * (`performance.now()`), so a wall-clock change cannot move it. The caller
 * starts it before it takes the claim (`dispatchDeadlineIn`) and passes it to
 * the code that sends. That code compares the clock with it immediately
 * before the request is handed to `fetch`: past the deadline, the request is
 * not sent and `DispatchDeadlinePassedError` is thrown instead. A timer that
 * stops Fabric waiting for a request already in flight is a separate,
 * additional bound, and it does not tear that request down on the HTTP and
 * SSE MCP transports (the SDK transport uses its own controller); a timer
 * alone does not bound when a request is sent, because it can fire late
 * when the event loop stalls.
 *
 * The checks that run inside a client Fabric owns (the MCP transport fetch,
 * the STDIO wrapper call, the GitLab REST POST) read the deadline from the
 * code running now (`runWithDispatchDeadline`, an AsyncLocalStorage scope),
 * because a cached MCP client's transport is shared between calls and sees
 * nothing of the call it is sending. Outside a scope they are no-ops.
 *
 * Uses globalThis to keep a single AsyncLocalStorage instance even when the
 * bundler creates several copies of this module, as `dispatch-guard` does.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

/**
 * A request was not sent because its send deadline had passed. Thrown only
 * by a check that runs before the request it guards is handed to `fetch`,
 * so it is evidence that this request was not sent.
 */
export class DispatchDeadlinePassedError extends Error {
	override name = "DispatchDeadlinePassedError";

	constructor(
		message = "The request was not sent: its send deadline had passed.",
	) {
		super(message);
	}
}

/**
 * Whether `error`, or an error in its `cause` chain, is a
 * `DispatchDeadlinePassedError`. Matched by name, so a copy of this module
 * loaded twice (or a test double) is still recognised.
 */
export function isDispatchDeadlinePassedError(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; current != null && depth < 8; depth++) {
		if (
			typeof current === "object" &&
			(current as { name?: unknown }).name ===
				"DispatchDeadlinePassedError"
		) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/** The monotonic clock deadlines are read on (milliseconds). */
function monotonicNow(): number {
	return performance.now();
}

/** A deadline `budgetMs` from now, on the monotonic clock. */
export function dispatchDeadlineIn(budgetMs: number): number {
	return monotonicNow() + budgetMs;
}

/** Whether the monotonic clock has reached `deadline`. */
export function dispatchDeadlinePassed(deadline: number): boolean {
	return monotonicNow() >= deadline;
}

/** Milliseconds left until `deadline`; 0 once it has passed. */
export function dispatchDeadlineRemainingMs(deadline: number): number {
	return Math.max(0, deadline - monotonicNow());
}

/**
 * Throws `DispatchDeadlinePassedError` when `deadline` is set and has passed.
 * Call it immediately before the send it guards, with nothing awaited in
 * between.
 */
export function throwIfDeadlinePassed(deadline: number | undefined): void {
	if (deadline !== undefined && dispatchDeadlinePassed(deadline)) {
		throw new DispatchDeadlinePassedError();
	}
}

const STORAGE_KEY = "__fabric_dispatch_deadline_storage__" as const;

const globals = globalThis as Record<string, unknown>;

const dispatchDeadlineStorage: AsyncLocalStorage<{ deadline: number }> =
	(globals[STORAGE_KEY] as
		| AsyncLocalStorage<{ deadline: number }>
		| undefined) ??
	(() => {
		const storage = new AsyncLocalStorage<{ deadline: number }>();
		globals[STORAGE_KEY] = storage;
		return storage;
	})();

/**
 * Runs `fn` with `deadline` as the send deadline of every guarded request it
 * makes, in its own async work and in work it starts (a promise still
 * running after `fn`'s caller stopped waiting keeps it too). A nested scope
 * keeps the earlier of the two deadlines.
 */
export function runWithDispatchDeadline<T>(deadline: number, fn: () => T): T {
	const outer = dispatchDeadlineStorage.getStore()?.deadline;
	return dispatchDeadlineStorage.run(
		{
			deadline:
				outer === undefined ? deadline : Math.min(outer, deadline),
		},
		fn,
	);
}

/** The send deadline of the code running now, or undefined outside a scope. */
export function currentDispatchDeadline(): number | undefined {
	return dispatchDeadlineStorage.getStore()?.deadline;
}

/**
 * For a client's send of a guarded request: call it in the same synchronous
 * run as the transport call (the line that calls `fetch`), on every path
 * that sends, a resend included. Throws `DispatchDeadlinePassedError` when
 * the scope's deadline has passed; a no-op outside a scope.
 */
export function throwIfDispatchDeadlinePassed(): void {
	throwIfDeadlinePassed(currentDispatchDeadline());
}
