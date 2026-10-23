/**
 * What one run did, shaped for the editor: the canvas tints each step by its
 * result and the inspector shows the selected step's output. Built from the
 * execution's own logs (`executions.get`), so it needs no extra API.
 */

type StepRunStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";

export interface StepRun {
	status: StepRunStatus;
	duration: number | null;
	output: unknown;
	error: string | null;
}

/** The run being viewed on the canvas. */
export interface ViewedRun {
	shortId: string;
	steps: ReadonlyMap<string, StepRun>;
}

interface StepLog {
	nodeId: string;
	status: string;
	duration?: number | null;
	output?: unknown;
	error?: string | null;
}

function toStepStatus(status: string): StepRunStatus {
	switch (status) {
		case "RUNNING":
		case "COMPLETED":
		case "FAILED":
		case "SKIPPED":
			return status;
		default:
			return "PENDING";
	}
}

/**
 * One entry per node. Logs arrive oldest first, so a node that ran more than
 * once is shown with its latest attempt.
 */
export function buildStepRuns(
	logs: ReadonlyArray<StepLog>,
): Map<string, StepRun> {
	const steps = new Map<string, StepRun>();
	for (const log of logs) {
		steps.set(log.nodeId, {
			status: toStepStatus(log.status),
			duration: log.duration ?? null,
			output: log.output ?? null,
			error: log.error ?? null,
		});
	}
	return steps;
}

/** The first characters of a run id, enough to tell runs apart in a list. */
export function shortRunId(executionId: string): string {
	return executionId.slice(0, 8);
}

/** How a run was started, so a cron run is not mistaken for yours. */
const TRIGGER_LABELS: Record<string, string> = {
	MANUAL: "Manual",
	WEBHOOK: "Webhook",
	SCHEDULE: "Schedule",
	EVENT: "Event",
};

export function formatTriggerType(triggerType: string | null | undefined) {
	if (!triggerType) {
		return null;
	}
	return TRIGGER_LABELS[triggerType] ?? triggerType;
}

/**
 * The run-history filters, in the order a reader scans for them: "did
 * anything break", then "is anything still going", then the rest.
 */
export const RUN_FILTERS = [
	{ value: "all", label: "All", noun: "" },
	{ value: "FAILED", label: "Failed", noun: "failed" },
	{ value: "RUNNING", label: "Running", noun: "running" },
	{ value: "COMPLETED", label: "Done", noun: "completed" },
] as const;

export type RunFilter = (typeof RUN_FILTERS)[number]["value"];

interface RunStats {
	total: number;
	completed: number;
	failed: number;
	running: number;
}

/** The count each filter shows, from `executions.stats`. */
export function runFilterCount(
	filter: RunFilter,
	stats: RunStats | undefined,
): number | undefined {
	if (!stats) {
		return undefined;
	}
	switch (filter) {
		case "all":
			return stats.total;
		case "FAILED":
			return stats.failed;
		case "RUNNING":
			return stats.running;
		case "COMPLETED":
			return stats.completed;
		default: {
			const unhandled: never = filter;
			return unhandled;
		}
	}
}
