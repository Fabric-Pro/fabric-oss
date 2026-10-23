/**
 * Recurring-error detection: a scheduled sweep over the projects that turned
 * it on, and a thin per-project workflow over the scan activity. All I/O,
 * clocks and model calls live in the activities, so both bodies stay
 * replay-safe.
 *
 * Same shape as the pipeline-results sweep: each project runs as its own
 * child under a project-scoped workflow id, so a tick that overlaps a still-
 * running scan collapses onto it instead of scanning the project twice, and
 * children are ABANDONed so one slow log source cannot hold the sweep open.
 */
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import {
	ParentClosePolicy,
	proxyActivities,
	startChild,
} from "@temporalio/workflow";
import type { listProjectsDueForRecurringErrorScanActivity as ListProjectsFn } from "../activities/recurring-errors/list-projects";
import type {
	scanRecurringErrorsForProject as ScanProjectFn,
	ScanRecurringErrorsInput,
	ScanRecurringErrorsResult,
} from "../activities/recurring-errors/scan-project";

const { scanRecurringErrorsForProject } = proxyActivities<{
	scanRecurringErrorsForProject: typeof ScanProjectFn;
}>({
	// One platform aggregation, up to 25 drafts and a duplicate check; bounded
	// so a hung log source or model cannot wedge the run. No heartbeat
	// timeout: the duplicate check is one long call with no natural beat.
	startToCloseTimeout: "15 minutes",
	retry: {
		initialInterval: "10s",
		maximumInterval: "2 minutes",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { listProjectsDueForRecurringErrorScanActivity } = proxyActivities<{
	listProjectsDueForRecurringErrorScanActivity: typeof ListProjectsFn;
}>({
	startToCloseTimeout: "1 minute",
	retry: { maximumAttempts: 3 },
});

export function recurringErrorScanWorkflowId(projectId: string): string {
	return `recurring-error-scan-${projectId}`;
}

export async function recurringErrorScanProjectWorkflow(
	input: ScanRecurringErrorsInput,
): Promise<ScanRecurringErrorsResult> {
	return scanRecurringErrorsForProject(input);
}

export interface RecurringErrorSweepResult {
	considered: number;
	started: number;
	alreadyRunning: number;
}

export async function recurringErrorSweepWorkflow(input?: {
	limit?: number;
}): Promise<RecurringErrorSweepResult> {
	const projects = await listProjectsDueForRecurringErrorScanActivity({
		limit: input?.limit,
	});

	let started = 0;
	let alreadyRunning = 0;
	for (const project of projects) {
		try {
			await startChild(recurringErrorScanProjectWorkflow, {
				workflowId: recurringErrorScanWorkflowId(project.projectId),
				parentClosePolicy: ParentClosePolicy.ABANDON,
				args: [
					{
						projectId: project.projectId,
						organizationId: project.organizationId ?? null,
						userId: project.userId,
						threshold: project.threshold,
						windowHours: project.windowHours,
						similarityThreshold: project.similarityThreshold,
					},
				],
			});
			started++;
		} catch (err) {
			if (err instanceof WorkflowExecutionAlreadyStartedError) {
				alreadyRunning++;
				continue;
			}
			throw err;
		}
	}

	return { considered: projects.length, started, alreadyRunning };
}
