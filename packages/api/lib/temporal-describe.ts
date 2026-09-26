/**
 * Shared plumbing for describing a Temporal workflow execution: a per-call
 * timeout bound, and the terminal statuses that mean an execution has closed.
 */

class DescribeTimeout extends Error {}

/** Races `promise` against `ms`; a timeout rejects with `DescribeTimeout`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new DescribeTimeout()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Workflow statuses that mean the execution has finished, in any outcome. */
export const CLOSED_WORKFLOW_STATUSES: ReadonlySet<string> = new Set([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"TERMINATED",
	"TIMED_OUT",
	"CONTINUED_AS_NEW",
]);
