/**
 * One question, asked across a module boundary: did the finalize step fail
 * BEFORE it called `workflow.start`?
 *
 * It lives in a module of its own, with no imports at all, for two reasons.
 *
 * `finalize.ts` pulls in `@repo/temporal`, and the callers that need this
 * answer deliberately keep that out of their module graph — the v1 route
 * imports `submit-change.ts` dynamically for exactly that reason, and tests
 * replace `./finalize` wholesale. A marker that travelled with the Temporal
 * client could not be recognised by any of them.
 *
 * And the answer has to be trustworthy, because acting on it means closing
 * out a snapshot row. `name === "InstructionWorkflowNotStartedError"` is the
 * obvious check and the wrong one: any error carrying that name — a wrapped
 * third-party failure, a deserialised error crossing a boundary, something
 * constructed by code that never went near this path — would be read as a
 * promise that no execution exists, and a caller would then reject a row a
 * validation run may already own. The brand below is a module-private Symbol
 * that only `instructionWorkflowNotStarted` sets, so a claim can only come
 * from the one place entitled to make it.
 */

const NOT_STARTED = Symbol("instructionWorkflowNotStarted");

class InstructionWorkflowNotStartedError extends Error {
	readonly [NOT_STARTED] = true;

	constructor(cause: unknown) {
		super("Could not reach Temporal to start the validation workflow", {
			cause,
		});
		this.name = "InstructionWorkflowNotStartedError";
	}
}

/**
 * Wrap a failure that happened before the workflow start was attempted.
 *
 * A factory rather than an exported class, so the brand cannot be applied by
 * anything but this function. `cause` is the failure that actually happened
 * and is what a caller surfaces; this wrapper's own message is never meant to
 * reach a person.
 */
export function instructionWorkflowNotStarted(cause: unknown): Error {
	return new InstructionWorkflowNotStartedError(cause);
}

/**
 * Did the finalize step fail before `workflow.start` was called?
 *
 * `true` means no execution exists and the snapshot row is safe to close out.
 * Anything else — including a start that WAS called and rejected — may have
 * succeeded with only its acknowledgement lost, and belongs to the reaper's
 * stale-VALIDATING sweep, which asks Temporal before deciding.
 */
export function isInstructionWorkflowNotStarted(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as Record<symbol, unknown>)[NOT_STARTED] === true
	);
}

/**
 * The failure that actually happened, for a caller about to surface it: the
 * marker's `cause`, or the error itself when it is not a marker.
 *
 * The cause is taken by PRESENCE, not by truthiness. `new Error(msg, { cause })`
 * installs the property whatever the value is, so the factory above always
 * leaves one behind — and `cause ?? error` handed back the wrapper for the one
 * case where the original was `null` or `undefined`. That is exactly the
 * failure a caller has least other way of seeing: a rejection with no value
 * carries nothing else to identify it, and the caller would have surfaced
 * "Could not reach Temporal to start the validation workflow" as though it
 * were the thing that went wrong.
 */
export function unwrapInstructionWorkflowError(error: unknown): unknown {
	if (!isInstructionWorkflowNotStarted(error)) {
		return error;
	}
	return Object.hasOwn(error as object, "cause")
		? (error as { cause: unknown }).cause
		: error;
}
