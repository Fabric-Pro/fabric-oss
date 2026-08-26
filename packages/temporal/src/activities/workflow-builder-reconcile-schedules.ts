/**
 * Reconcile workflow-builder schedules against the workflow table.
 *
 * Schedule sync is best-effort by design — `syncWorkflowSchedule` never throws,
 * because a publish must not fail just because Temporal was briefly
 * unreachable. That leaves a gap: a workflow deleted or unpublished while
 * Temporal was down keeps a schedule that fires against nothing, forever.
 *
 * This closes it. Because the schedule id is derived from the workflow id
 * rather than stored, the whole reconciliation is a prefix scan — there is no
 * column that can itself drift.
 *
 * Modelled on `reconcile-url-source-schedules`, including its dependency
 * injection: the worker takes list/delete/fetch as arguments so it can be
 * tested without a Temporal client.
 */

import { db } from "@repo/database";
import type { ScheduleSummary } from "@temporalio/client";
import { getScheduleClient } from "../client";
import {
	deleteWorkflowSchedule,
	findScheduleCron,
	parseWorkflowIdFromScheduleId,
	WORKFLOW_BUILDER_SCHEDULE_PREFIX,
} from "../schedules/workflow-builder-schedule";

export interface ReconcileWorkflowSchedulesInput {
	/** Report what would change without changing it. */
	dryRun?: boolean;
}

export interface ReconcileWorkflowSchedulesOutput {
	scanned: number;
	orphansDeleted: number;
	dryRun: boolean;
	reasons: Record<string, number>;
}

/** What a workflow row has to look like for its schedule to be legitimate. */
export interface ReconcilableWorkflow {
	status: string;
	nodes: unknown;
}

export type WorkflowFetcher = (
	workflowId: string,
) => Promise<ReconcilableWorkflow | null>;

/**
 * Why a schedule should not exist — null when it is legitimate.
 *
 * Deliberately conservative: anything unrecognised is left alone. Deleting a
 * schedule we merely failed to understand would be worse than leaving an
 * orphan for a human to spot.
 */
export function classifyScheduleOrphan(
	workflow: ReconcilableWorkflow | null,
): string | null {
	if (!workflow) {
		return "workflow-deleted";
	}

	if (workflow.status !== "PUBLISHED" && workflow.status !== "ACTIVE") {
		return "workflow-not-published";
	}

	if (!findScheduleCron(workflow.nodes)) {
		return "trigger-no-longer-scheduled";
	}

	return null;
}

/**
 * Internal worker — extracted so tests can drive it with a fake schedule list
 * and fake fetcher without `@temporalio/client`.
 */
export async function reconcileWorkflowSchedules(args: {
	listSchedules: () => AsyncIterable<ScheduleSummary>;
	deleteSchedule: (workflowId: string) => Promise<void>;
	fetchWorkflow: WorkflowFetcher;
	dryRun: boolean;
	heartbeat?: (details?: unknown) => void;
}): Promise<ReconcileWorkflowSchedulesOutput> {
	let scanned = 0;
	let orphansDeleted = 0;
	const reasons: Record<string, number> = {};

	for await (const summary of args.listSchedules()) {
		// Filter again client-side: the server-side query is an optimisation,
		// and Temporal Cloud's indexing can lag.
		if (!summary.scheduleId.startsWith(WORKFLOW_BUILDER_SCHEDULE_PREFIX)) {
			continue;
		}

		const workflowId = parseWorkflowIdFromScheduleId(summary.scheduleId);
		if (!workflowId) {
			continue;
		}

		scanned++;
		args.heartbeat?.({ scanned, orphansDeleted });

		const workflow = await args.fetchWorkflow(workflowId);
		const reason = classifyScheduleOrphan(workflow);
		if (!reason) {
			continue;
		}

		reasons[reason] = (reasons[reason] ?? 0) + 1;

		if (!args.dryRun) {
			await args.deleteSchedule(workflowId);
		}
		orphansDeleted++;
	}

	return { scanned, orphansDeleted, dryRun: args.dryRun, reasons };
}

const defaultWorkflowFetcher: WorkflowFetcher = async (workflowId) => {
	// Reconciliation is a system sweep, so it reads across tenants
	// deliberately — it is asking "does this row still exist and still want a
	// schedule", not serving a user's request.
	const workflow = await db.workflow.findUnique({
		where: { id: workflowId },
		select: { status: true, nodes: true },
	});
	return workflow ?? null;
};

export async function reconcileWorkflowSchedulesActivity(
	input: ReconcileWorkflowSchedulesInput = {},
): Promise<ReconcileWorkflowSchedulesOutput> {
	const dryRun = input.dryRun ?? false;
	const scheduleClient = await getScheduleClient();

	const result = await reconcileWorkflowSchedules({
		listSchedules: () =>
			scheduleClient.list({
				query: `ScheduleId STARTS_WITH "${WORKFLOW_BUILDER_SCHEDULE_PREFIX}"`,
			}),
		deleteSchedule: async (workflowId) => {
			await deleteWorkflowSchedule(workflowId, scheduleClient);
		},
		fetchWorkflow: defaultWorkflowFetcher,
		dryRun,
	});

	console.log("[ReconcileWorkflowSchedules] done", result);

	return result;
}
