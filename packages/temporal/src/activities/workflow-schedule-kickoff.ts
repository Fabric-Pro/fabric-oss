/**
 * Activity backing the scheduled kickoff workflow.
 *
 * A Temporal Schedule fires with fixed arguments, so it cannot carry a
 * per-fire execution id — every tick needs its own `WorkflowExecution` row, or
 * runs would overwrite each other's status and logs. The kickoff workflow
 * creates that row here and then runs the graph against it.
 */

import {
	canRunOrganizationWorkflows,
	createWorkflowExecution,
	db,
	getWorkflowById,
	isWorkflowLive,
	type Prisma,
} from "@repo/database";
import { getScheduleClient } from "../client";
import { findPublishedFrameId } from "../lib/workflow-run-output";
import { deleteWorkflowSchedule } from "../schedules/workflow-builder-schedule";
import {
	decideScheduledRunOutcome,
	OWNER_ACCESS_LOST_REASON,
	pausedState,
	type ScheduledRunStatus,
} from "./lib/scheduled-run-outcome";
import {
	lockWorkflowRow,
	parseWorkflowSettings,
	readScheduledRunState,
	writeScheduledRunState,
} from "./lib/workflow-settings";

export interface CreateScheduledExecutionInput {
	workflowId: string;
	userId: string;
	organizationId?: string;
}

export interface CreateScheduledExecutionResult {
	executionId: string;
	version: number;
	projectId?: string;
	/** False when the workflow is gone, no longer published, or its owner lost access. */
	shouldRun: boolean;
	reason?: string;
}

/**
 * The owner's standing may have changed since the schedule was made, and the
 * run uses the owner's rights: a demoted or removed owner's schedule must not
 * keep acting for them. Pauses the workflow the way a run of failures does
 * (status, recorded reason, schedule removed after the commit) and runs nothing.
 */
async function pauseAfterOwnerAccessLost(
	workflowId: string,
	organizationId: string,
): Promise<void> {
	await db.$transaction(async (tx) => {
		await lockWorkflowRow(tx, workflowId);
		const workflow = await tx.workflow.findFirst({
			where: { id: workflowId, organizationId },
			select: { status: true, settings: true },
		});
		if (!workflow || !isWorkflowLive(workflow.status)) {
			return;
		}
		const settings = parseWorkflowSettings(workflow.settings);
		const state = pausedState(
			readScheduledRunState(settings),
			OWNER_ACCESS_LOST_REASON,
			new Date().toISOString(),
		);
		await tx.workflow.update({
			where: { id: workflowId },
			data: {
				status: "PAUSED",
				settings: writeScheduledRunState(
					settings,
					state,
				) as Prisma.InputJsonValue,
			},
		});
	});
	await deleteWorkflowSchedule(workflowId, await getScheduleClient());
}

export async function createScheduledExecution(
	input: CreateScheduledExecutionInput,
): Promise<CreateScheduledExecutionResult> {
	const workflow = await getWorkflowById(
		input.workflowId,
		input.userId,
		input.organizationId,
	);

	if (!workflow) {
		// The workflow was deleted but its schedule outlived it. Reconciliation
		// removes these; until then, skip quietly rather than failing a run
		// nobody can see.
		return {
			executionId: "",
			version: 0,
			shouldRun: false,
			reason: "Workflow no longer exists",
		};
	}

	// Only a published workflow runs on a schedule. Unpublishing deletes the
	// schedule, so this is the belt-and-braces case where that did not land.
	if (!isWorkflowLive(workflow.status)) {
		return {
			executionId: "",
			version: workflow.version,
			shouldRun: false,
			reason: `Workflow is ${workflow.status}, not published`,
		};
	}

	if (
		input.organizationId &&
		!(await canRunOrganizationWorkflows(input.userId, input.organizationId))
	) {
		await pauseAfterOwnerAccessLost(input.workflowId, input.organizationId);
		return {
			executionId: "",
			version: workflow.version,
			shouldRun: false,
			reason: OWNER_ACCESS_LOST_REASON,
		};
	}

	const execution = await createWorkflowExecution({
		workflowId: input.workflowId,
		version: workflow.version,
		triggerType: "SCHEDULE",
		triggerInput: {
			source: "schedule",
		} as Prisma.InputJsonValue,
		userId: input.userId,
		organizationId: input.organizationId,
	});

	return {
		executionId: execution.id,
		version: workflow.version,
		projectId: workflow.projectId ?? undefined,
		shouldRun: true,
	};
}

export interface RecordScheduledRunOutcomeInput {
	workflowId: string;
	executionId: string;
	organizationId?: string;
	status: ScheduledRunStatus;
}

export interface RecordScheduledRunOutcomeResult {
	/** False when this execution's outcome was already counted, or the workflow is gone. */
	recorded: boolean;
	consecutiveFailures: number;
	paused: boolean;
}

type NotificationData = Pick<
	Prisma.NotificationUncheckedCreateInput,
	"type" | "title" | "snippet" | "link"
> & { payload: Prisma.InputJsonValue };

/** The owner's first-success notification: the page it made, else the workflow. */
function firstSuccessNotification(input: {
	workflowId: string;
	workflowName: string;
	executionId: string;
	frameId: string | null;
}): NotificationData {
	const { frameId } = input;
	return {
		type: "WORKFLOW_RUN_COMPLETED",
		title: `Scheduled workflow "${input.workflowName}" has run for the first time`,
		snippet: frameId
			? "Its first result is ready to open."
			: "Open the workflow to see its first run.",
		link: frameId ? `frames/${frameId}` : `workflows/${input.workflowId}`,
		payload: {
			workflowId: input.workflowId,
			workflowName: input.workflowName,
			executionId: input.executionId,
			status: "COMPLETED",
			...(frameId ? { frameId } : {}),
		},
	};
}

function failureNotification(input: {
	workflowId: string;
	workflowName: string;
	executionId: string;
	consecutiveFailures: number;
	paused: boolean;
}): NotificationData {
	return {
		type: "WORKFLOW_RUN_FAILED",
		title: input.paused
			? `Scheduled workflow "${input.workflowName}" was paused after ${input.consecutiveFailures} failed runs`
			: `Scheduled workflow "${input.workflowName}" failed`,
		snippet: input.paused
			? "It will not run again until you resume it. Open the run history to see what went wrong."
			: "Open the run history to see what went wrong.",
		link: `workflows/${input.workflowId}`,
		payload: {
			workflowId: input.workflowId,
			workflowName: input.workflowName,
			executionId: input.executionId,
			status: "FAILED",
			paused: input.paused,
		},
	};
}

/**
 * Counts one scheduled run toward the workflow's consecutive-failure streak and
 * tells its owner what happened. A success resets the streak; a failure extends
 * it, and the third in a row pauses the workflow and removes its schedule, so an
 * agent nobody is watching cannot keep failing (or spending) forever.
 *
 * Idempotent per execution: the counter, the status change and the notification
 * commit in one transaction, guarded by the execution id recorded in
 * `settings.lastOutcomeExecutionId`, so a retried activity changes nothing and
 * sends nothing twice. The schedule removal happens after the commit and is
 * repeated on a retry, since Temporal cannot join the transaction.
 *
 * Notifications carry no raw error: the notification list is UI-reachable and
 * the run history holds the detail.
 */
export async function recordScheduledRunOutcome(
	input: RecordScheduledRunOutcomeInput,
): Promise<RecordScheduledRunOutcomeResult> {
	const organizationId = input.organizationId ?? null;

	const outcome = await db.$transaction(async (tx) => {
		await lockWorkflowRow(tx, input.workflowId);
		const workflow = await tx.workflow.findFirst({
			where: { id: input.workflowId, organizationId },
			select: {
				name: true,
				status: true,
				userId: true,
				settings: true,
			},
		});
		if (!workflow) {
			return null;
		}

		const settings = parseWorkflowSettings(workflow.settings);
		const current = readScheduledRunState(settings);
		if (current.lastOutcomeExecutionId === input.executionId) {
			return {
				recorded: false,
				consecutiveFailures: current.consecutiveFailures,
				paused: workflow.status === "PAUSED",
			};
		}

		const decision = decideScheduledRunOutcome({
			state: current,
			executionId: input.executionId,
			status: input.status,
			workflowIsLive: isWorkflowLive(workflow.status),
			workflowIsPaused: workflow.status === "PAUSED",
			now: new Date().toISOString(),
		});
		const { consecutiveFailures } = decision.state;
		const common = {
			workflowId: input.workflowId,
			workflowName: workflow.name,
			executionId: input.executionId,
		};

		let notification: NotificationData | null = null;
		if (decision.firstSuccess) {
			const execution = await tx.workflowExecution.findFirst({
				where: { id: input.executionId, workflowId: input.workflowId },
				select: { output: true },
			});
			notification = firstSuccessNotification({
				...common,
				frameId: findPublishedFrameId(execution?.output),
			});
		} else if (input.status === "FAILED") {
			notification = failureNotification({
				...common,
				consecutiveFailures,
				paused: decision.pause,
			});
		}
		if (notification) {
			await tx.notification.create({
				data: {
					userId: workflow.userId,
					organizationId,
					category: "SYSTEM",
					...notification,
				},
			});
		}

		await tx.workflow.update({
			where: { id: input.workflowId },
			data: {
				...(decision.pause ? { status: "PAUSED" as const } : {}),
				settings: writeScheduledRunState(
					settings,
					decision.state,
				) as Prisma.InputJsonValue,
			},
		});
		return {
			recorded: true,
			consecutiveFailures,
			paused: decision.pause || workflow.status === "PAUSED",
		};
	});

	if (!outcome) {
		return { recorded: false, consecutiveFailures: 0, paused: false };
	}
	if (outcome.paused) {
		await deleteWorkflowSchedule(
			input.workflowId,
			await getScheduleClient(),
		);
	}
	return outcome;
}
