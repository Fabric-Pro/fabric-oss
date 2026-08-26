/**
 * Temporal Schedules for workflow-builder workflows with a Schedule trigger.
 *
 * The builder has offered "Schedule" as a trigger type since it shipped, and
 * `generate-from-prompt` even instructs the model to emit a cron expression —
 * but nothing ever created a schedule, so choosing it silently did nothing.
 *
 * Mirrors the per-entity pattern already in this package for URL sources
 * (`url-source-schedule.ts`) rather than inventing a second one.
 *
 * The schedule id is DERIVED from the workflow id, not stored. That keeps the
 * two in sync by construction and means reconciliation can list schedules by
 * prefix and compare against the workflow table without a column to drift.
 */

import type { ScheduleClient } from "@temporalio/client";

/** Every schedule this module owns starts with this. Reconciliation depends on it. */
export const WORKFLOW_BUILDER_SCHEDULE_PREFIX = "workflow-builder-";

/** MUST match the worker registration in `packages/temporal/src/worker.ts`. */
const TASK_QUEUE = "workflow-builder";

/**
 * A fire starts the kickoff workflow, not the executor directly.
 *
 * The executor needs a `WorkflowExecution` row id, and a Schedule's action
 * arguments are fixed at creation, so it cannot carry a per-fire one. Pointing
 * the schedule straight at `workflowBuilderExecutionWorkflow` meant every tick
 * started the executor with no id: it went to its first status update with
 * `undefined`, updated nothing, and the run left no trace in the history at
 * all. `scheduledWorkflowKickoff` creates the row per fire and then runs the
 * graph as a child against it.
 */
const WORKFLOW_TYPE = "scheduledWorkflowKickoff";

export function buildWorkflowScheduleId(workflowId: string): string {
	return `${WORKFLOW_BUILDER_SCHEDULE_PREFIX}${workflowId}`;
}

/** Inverse of {@link buildWorkflowScheduleId}; null for a schedule we do not own. */
export function parseWorkflowIdFromScheduleId(
	scheduleId: string,
): string | null {
	if (!scheduleId.startsWith(WORKFLOW_BUILDER_SCHEDULE_PREFIX)) {
		return null;
	}
	const workflowId = scheduleId.slice(
		WORKFLOW_BUILDER_SCHEDULE_PREFIX.length,
	);
	return workflowId.length > 0 ? workflowId : null;
}

/**
 * A five- or six-field cron expression, loosely validated.
 *
 * Deliberately structural only: Temporal is the authority on the expression
 * and rejects a malformed one at create time. This exists so the API can
 * return a field-level error instead of surfacing a Temporal exception, and so
 * an obviously-wrong value never reaches the schedule client.
 */
export function isPlausibleCron(expression: string): boolean {
	const fields = expression.trim().split(/\s+/);
	if (fields.length < 5 || fields.length > 6) {
		return false;
	}
	// Every field must look like cron syntax rather than prose.
	return fields.every((field) => /^[\d*/,\-?LW#]+$/i.test(field));
}

/**
 * Read the cron expression off a workflow's Schedule trigger node.
 *
 * Returns null when the workflow has no schedule trigger, or has one with no
 * expression — both of which mean "no schedule", not "invalid".
 */
export function findScheduleCron(nodes: unknown): string | null {
	if (!Array.isArray(nodes)) {
		return null;
	}

	for (const node of nodes) {
		if (!node || typeof node !== "object") {
			continue;
		}
		const typed = node as {
			type?: unknown;
			data?: { config?: Record<string, unknown> };
		};
		if (typed.type !== "trigger") {
			continue;
		}

		const config = typed.data?.config ?? {};
		const triggerType = String(config.triggerType ?? "").toLowerCase();
		if (triggerType !== "schedule") {
			continue;
		}

		const cron = config.scheduleCron ?? config.scheduleExpression;
		if (typeof cron === "string" && cron.trim().length > 0) {
			return cron.trim();
		}
	}

	return null;
}

export interface UpsertWorkflowScheduleArgs {
	workflowId: string;
	cron: string;
	userId: string;
	organizationId?: string | null;
	projectId?: string | null;
	/** Shown in the Temporal UI so an operator can tell what a schedule is for. */
	workflowName?: string;
}

/**
 * Create or update the schedule for a workflow.
 *
 * Idempotent: an existing schedule has its spec replaced rather than being
 * recreated, so editing the cron does not lose the schedule's history.
 */
export async function upsertWorkflowSchedule(
	args: UpsertWorkflowScheduleArgs,
	scheduleClient: ScheduleClient,
): Promise<{ scheduleId: string; created: boolean }> {
	if (!isPlausibleCron(args.cron)) {
		throw new Error(`Invalid cron expression: "${args.cron}"`);
	}

	const scheduleId = buildWorkflowScheduleId(args.workflowId);

	const action = {
		type: "startWorkflow" as const,
		workflowType: WORKFLOW_TYPE,
		taskQueue: TASK_QUEUE,
		args: [
			{
				// executionId is created by the kickoff activity per fire —
				// the schedule cannot carry one, or every fire would collide
				// on the same execution row.
				workflowId: args.workflowId,
				userId: args.userId,
				organizationId: args.organizationId ?? undefined,
				projectId: args.projectId ?? undefined,
				triggerData: { source: "schedule" },
			},
		],
		// Temporal appends a unique per-fire suffix. Keep the prefix short so
		// the result stays inside the workflowId length limit.
		workflowId: `workflow-schedule-${args.workflowId}`,
	};

	try {
		await scheduleClient.create({
			scheduleId,
			spec: { cronExpressions: [args.cron] },
			action,
			policies: {
				// A run that overruns its next slot should not stack up; the
				// next tick is usually the better outcome for a user-authored
				// workflow that may have external side effects.
				overlap: "SKIP",
				catchupWindow: "1 hour",
			},
			state: {
				paused: false,
				note: `Workflow builder schedule for ${
					args.workflowName ?? args.workflowId
				}`,
			},
		});
		return { scheduleId, created: true };
	} catch (error) {
		// Already exists — update the spec in place so the cron can be edited
		// without losing the schedule.
		if (isAlreadyExists(error)) {
			const handle = scheduleClient.getHandle(scheduleId);
			await handle.update((previous) => ({
				...previous,
				spec: { cronExpressions: [args.cron] },
				action,
			}));
			return { scheduleId, created: false };
		}
		throw error;
	}
}

/** Remove a workflow's schedule. Safe to call when there is none. */
export async function deleteWorkflowSchedule(
	workflowId: string,
	scheduleClient: ScheduleClient,
): Promise<{ deleted: boolean }> {
	const scheduleId = buildWorkflowScheduleId(workflowId);

	try {
		await scheduleClient.getHandle(scheduleId).delete();
		return { deleted: true };
	} catch (error) {
		if (isNotFound(error)) {
			return { deleted: false };
		}
		throw error;
	}
}

function isAlreadyExists(error: unknown): boolean {
	const name = (error as { name?: string })?.name ?? "";
	const message = (error as { message?: string })?.message ?? "";
	return (
		name === "ScheduleAlreadyRunning" ||
		/already (exists|running)/i.test(message)
	);
}

function isNotFound(error: unknown): boolean {
	const name = (error as { name?: string })?.name ?? "";
	const message = (error as { message?: string })?.message ?? "";
	return name === "ScheduleNotFoundError" || /not found/i.test(message);
}
