/**
 * Importing a project from its repository (specs/2026-10-23-repository-import).
 *
 * Id `project-import-<runId>`, on `project-documents`; its activities run on
 * `fabric-worker` with the other repository reads. The analysis records the
 * checklist and leaves its findings on the run's row in REVIEW; the workflow
 * then waits for the person's selection (the `apply` signal, sent by
 * `projects.import.apply`) and creates what they kept. A run nobody reviews
 * within a week ends; its findings stay readable and a new import can start.
 *
 * Imports only the SDK, the task-queue constant and type-only activity
 * signatures, as the workflow sandbox requires.
 */
import type { ProjectImportSelection } from "@repo/database";
import {
	ApplicationFailure,
	condition,
	defineSignal,
	isCancellation,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type * as projectImport from "../activities/project-import";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../task-queues";

const work = proxyActivities<typeof projectImport>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "30 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		maximumAttempts: 3,
		initialInterval: "15 seconds",
		backoffCoefficient: 2,
	},
});

const record = proxyActivities<typeof projectImport>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "30 seconds",
	retry: { maximumAttempts: 20, initialInterval: "5 seconds" },
});

export const projectImportApplySignal =
	defineSignal<[ProjectImportSelection]>("apply");

function messageOf(error: unknown): string {
	let current: unknown = error;
	while (current instanceof Error) {
		if (current instanceof ApplicationFailure) {
			return current.message;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return "The import stopped because of an internal error. Try again.";
}

export async function projectImportWorkflow(
	input: projectImport.ProjectImportWorkflowInput,
): Promise<{ applied: boolean }> {
	let selection: ProjectImportSelection | null = null;
	setHandler(projectImportApplySignal, (chosen) => {
		selection ??= chosen;
	});
	try {
		await work.analyzeProjectImportActivity(input);
		const chosen = await condition(() => selection !== null, "7 days");
		if (!chosen || selection === null) {
			return { applied: false };
		}
		await work.applyProjectImportActivity({ ...input, selection });
		return { applied: true };
	} catch (error) {
		if (isCancellation(error)) {
			throw error;
		}
		await record.failProjectImportActivity({
			...input,
			message: messageOf(error),
		});
		return { applied: false };
	}
}
