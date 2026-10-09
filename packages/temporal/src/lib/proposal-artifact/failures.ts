/**
 * Failure recognition the generation workflows share (Fizzy #2801).
 *
 * Workflow-safe: imported by workflow code, so it holds pure functions over
 * `ApplicationFailure` only. No I/O.
 */

import { ApplicationFailure } from "@temporalio/common";
import { DOCUMENT_GENERATION_SUPERSEDED } from "./types";

/**
 * Bound on the cause chain walked, so a self-referential `cause`, which a
 * third-party error is free to construct, cannot spin a workflow task.
 */
const MAX_CAUSE_DEPTH = 8;

/**
 * Did this failure, or any failure it wraps, end with `type`? A child's
 * `ApplicationFailure` reaches its parent wrapped in a `ChildWorkflowFailure`,
 * and an activity's in an `ActivityFailure`, so the type is looked for down
 * the cause chain.
 */
function hasFailureType(error: unknown, type: string): boolean {
	let current: unknown = error;
	for (
		let depth = 0;
		current != null && depth < MAX_CAUSE_DEPTH;
		depth += 1
	) {
		if (current instanceof ApplicationFailure && current.type === type) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * Did a generation child end because a newer generation took its document?
 * A parent seeing this must not write the document's status: the newer run
 * owns it.
 */
export function isSupersededGenerationFailure(error: unknown): boolean {
	return hasFailureType(error, DOCUMENT_GENERATION_SUPERSEDED);
}

/**
 * The run token a coordinated Proposal child put in the details of its
 * failure (`{ liveRunId }`), looked for down the cause chain like the type.
 * A parent guards its own FAILED write with it, so the write never lands on
 * a newer run that took the document over. Undefined for every other child,
 * and for any failure recorded before the child carried it: the parent's
 * write is then today's.
 */
export function liveRunIdOfGenerationFailure(
	error: unknown,
): string | undefined {
	let current: unknown = error;
	for (
		let depth = 0;
		current != null && depth < MAX_CAUSE_DEPTH;
		depth += 1
	) {
		if (current instanceof ApplicationFailure) {
			const [first] = current.details ?? [];
			const liveRunId = (first as { liveRunId?: unknown } | null)
				?.liveRunId;
			if (typeof liveRunId === "string" && liveRunId.length > 0) {
				return liveRunId;
			}
		}
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}
