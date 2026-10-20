/**
 * What a cancelled Direct chat turn may no longer do.
 *
 * Stop (or the client going away) cancels the workflow, which cancels the
 * activity: Temporal aborts the activity's `cancellationSignal`. Stopping the
 * model stream is not enough on its own: a tool already running keeps going
 * once its awaited guard returns, and a tool the SDK starts on the abort
 * boundary starts anyway. Three layers keep a cancelled turn from dispatching
 * a side effect:
 *
 *  - the ambient dispatch guard (`@repo/utils/dispatch-guard`), installed for
 *    the whole turn. Model and embedding requests from the `@repo/ai` factory,
 *    the MCP client's HTTP sends, and the database writes and service calls
 *    that already call `throwIfDispatchStopped()` immediately before writing
 *    consult it, so they refuse once the turn is cancelled;
 *  - a check at every tool's entry, with the turn's signal handed to the tool
 *    as the SDK's per-call `abortSignal` (`guardToolsAgainstCancellation`);
 *  - a check immediately before a wrapper's own dispatch, after any awaited
 *    guard (`throwIfTurnCancelled`), as the MCP tool wrapper does.
 */

import type { DispatchGuard } from "@repo/utils/dispatch-guard";
import { CancelledFailure } from "@temporalio/common";

/**
 * The error a cancelled turn ends with. Temporal reports an activity attempt
 * as cancelled only when it ends with a `CancelledFailure` (or an AbortError)
 * after its cancellation signal fired; any other ending is a failure or a
 * result the workflow would act on.
 */
export function cancellationError(signal: AbortSignal): CancelledFailure {
	return signal.reason instanceof CancelledFailure
		? signal.reason
		: new CancelledFailure("Direct chat turn cancelled");
}

/**
 * Throws the cancellation when any of `signals` has aborted. Call it
 * immediately before a side effect, after every await that precedes it.
 */
export function throwIfTurnCancelled(
	...signals: Array<AbortSignal | undefined>
): void {
	for (const signal of signals) {
		if (signal?.aborted) {
			throw cancellationError(signal);
		}
	}
}

/**
 * A dispatch guard that stops everything under it once `signal` aborts. It
 * carries no token ledger: Direct chat has none.
 */
export function turnCancellationGuard(
	key: string,
	signal: AbortSignal,
): DispatchGuard {
	const throwIfStopped = () => throwIfTurnCancelled(signal);
	return {
		key,
		assertDispatchable: async () => throwIfStopped(),
		abortSignal: () => signal,
		// After a cancel, whatever failed failed because of it.
		rethrowIfStopped: () => throwIfStopped(),
		throwIfStopped,
	};
}

interface ExecutableTool {
	execute: (...args: unknown[]) => unknown;
}

function isExecutable(value: unknown): value is ExecutableTool {
	return (
		typeof value === "object" &&
		value !== null &&
		"execute" in value &&
		typeof (value as { execute?: unknown }).execute === "function"
	);
}

function executionOptions(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};
}

/**
 * Wraps every executable tool in `tools`, in place, so that a call made after
 * the turn was cancelled throws the cancellation instead of running, and the
 * tool receives the turn's signal as its per-call `abortSignal` when the SDK
 * passed none. Everything else on the tool definition is kept as it was.
 */
export function guardToolsAgainstCancellation(
	tools: Record<string, unknown>,
	cancellation: AbortSignal | undefined,
): void {
	for (const [name, definition] of Object.entries(tools)) {
		if (!isExecutable(definition)) {
			continue;
		}
		const execute = definition.execute;
		tools[name] = {
			...definition,
			execute: (
				input: unknown,
				options?: unknown,
				...rest: unknown[]
			) => {
				const callOptions = executionOptions(options);
				const callSignal = callOptions.abortSignal as
					| AbortSignal
					| undefined;
				try {
					throwIfTurnCancelled(callSignal, cancellation);
				} catch (error) {
					// Rejected rather than thrown: the tool's own return value
					// (a promise, or an async iterable for a streaming tool)
					// is passed through untouched below.
					return Promise.reject(error);
				}
				const abortSignal = callSignal ?? cancellation;
				return execute(
					input,
					abortSignal ? { ...callOptions, abortSignal } : options,
					...rest,
				);
			},
		};
	}
}
