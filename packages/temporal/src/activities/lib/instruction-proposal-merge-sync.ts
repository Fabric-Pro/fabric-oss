/**
 * The merge-sync receipt classifier and dispatch backoff (Fizzy #2563 spec
 * §9.1). Pure: the dispatcher reads the receipt and the clock, this decides.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */

/** A merged run's failures a re-dispatch cannot change (spec §9.1 table). */
const CONSUMING_FAILURES = new Set(["LIMITS_EXCEEDED", "TREE_REFUSED"]);

const MINUTE_MS = 60 * 1000;

/**
 * Whether a run receipt acknowledges the merge-sync request (spec §9.1):
 * only a merge-triggered run for exactly the expected project, sync row and
 * generation, started at or after the request, whose outcome a re-dispatch
 * could not change. Null status is a run in flight.
 */
export function classifyMergeSyncReceipt(
	run: {
		projectId: string;
		syncId: string;
		generation: number;
		trigger: string;
		startedAt: Date;
		status: string | null;
		error: string | null;
	},
	expected: {
		projectId: string;
		syncId: string;
		generation: number;
		requestedAt: Date;
	},
): "wait" | "consuming" | "retaining" {
	if (
		run.projectId !== expected.projectId ||
		run.syncId !== expected.syncId ||
		run.generation !== expected.generation
	) {
		return "retaining";
	}
	if (
		run.trigger !== "PULL_REQUEST_MERGED" ||
		run.startedAt.getTime() < expected.requestedAt.getTime()
	) {
		return "retaining";
	}
	if (run.status === null) {
		return "wait";
	}
	if (
		run.status === "SUCCEEDED" ||
		run.status === "UNCHANGED" ||
		run.status === "REJECTED"
	) {
		return "consuming";
	}
	if (
		run.status === "FAILED" &&
		run.error !== null &&
		CONSUMING_FAILURES.has(run.error)
	) {
		return "consuming";
	}
	return "retaining";
}

/** The wait after the (n+1)th dispatch: 5, 15, then 60 minutes (spec §9.1 step 4). */
export const mergeSyncBackoffMs = (dispatches: number): number =>
	[5, 15, 60][Math.min(Math.max(dispatches, 0), 2)] * MINUTE_MS;

/**
 * How many dispatches the schedule has made by `elapsedMs` after the
 * request: 0 before 5 minutes, 1 before 20, then 2. The row keeps no
 * dispatch counter, so the count is read off the request's own clock (the
 * database's), which puts dispatches at about 0, 5 and 20 minutes and then
 * hourly, as the spec's backoff does.
 */
export function mergeSyncDispatchesBefore(elapsedMs: number): number {
	if (elapsedMs < 5 * MINUTE_MS) {
		return 0;
	}
	return elapsedMs < 20 * MINUTE_MS ? 1 : 2;
}
