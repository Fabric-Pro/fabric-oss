/**
 * Keeps a workflow's Temporal Schedule in step with its definition.
 *
 * Called wherever a workflow's schedule-relevant state changes: publish makes
 * it live, unpublish and delete take it away, and saving an already-published
 * workflow updates the cron in place.
 *
 * Never throws. A schedule that fails to sync must not block the publish or
 * delete that triggered it — the workflow itself is the source of truth, and
 * the reconciler repairs drift on its next pass. The outcome is returned so
 * callers can surface it.
 */

import {
	deleteWorkflowSchedule,
	findScheduleCron,
	getScheduleClient,
	isPlausibleCron,
	isTemporalAvailable,
	upsertWorkflowSchedule,
} from "@repo/temporal";

export interface SyncWorkflowScheduleArgs {
	workflowId: string;
	/** The workflow's node graph; the cron is read off its trigger node. */
	nodes: unknown;
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
	workflowName?: string;
	/**
	 * Whether the workflow should have a live schedule at all. False for a
	 * draft, an unpublished workflow, or one being deleted — a schedule is
	 * only ever live for a published workflow.
	 */
	active: boolean;
}

export type SyncWorkflowScheduleResult =
	| { outcome: "created" | "updated"; cron: string }
	| { outcome: "deleted" }
	| { outcome: "none"; reason: string }
	| { outcome: "failed"; reason: string };

export async function syncWorkflowSchedule(
	args: SyncWorkflowScheduleArgs,
): Promise<SyncWorkflowScheduleResult> {
	const cron = args.active ? findScheduleCron(args.nodes) : null;

	try {
		if (!(await isTemporalAvailable())) {
			return {
				outcome: "none",
				reason: "Temporal unavailable; reconciler will repair",
			};
		}

		const scheduleClient = await getScheduleClient();

		// No schedule trigger (or no longer active) — remove any schedule the
		// workflow used to have. Safe when there is none.
		if (!cron) {
			const { deleted } = await deleteWorkflowSchedule(
				args.workflowId,
				scheduleClient,
			);
			return deleted
				? { outcome: "deleted" }
				: { outcome: "none", reason: "No schedule trigger" };
		}

		if (!isPlausibleCron(cron)) {
			return {
				outcome: "failed",
				reason: `Invalid cron expression: "${cron}"`,
			};
		}

		const { created } = await upsertWorkflowSchedule(
			{
				workflowId: args.workflowId,
				cron,
				userId: args.userId,
				organizationId: args.organizationId,
				projectId: args.projectId,
				workflowName: args.workflowName,
			},
			scheduleClient,
		);

		return { outcome: created ? "created" : "updated", cron };
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : "Unknown schedule error";
		console.error("[Workflows] Failed to sync schedule", {
			workflowId: args.workflowId,
			reason,
		});
		return { outcome: "failed", reason };
	}
}
