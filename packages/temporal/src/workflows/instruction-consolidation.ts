/**
 * Instructions consolidation (specs/2026-10-21-ai-artifacts-hub §5.2, P4):
 * move a code repository's AI files into the separate instructions
 * repository Fabric created for the project.
 *
 * Id `instruction-consolidation-<consolidationId>`, on
 * `project-instructions`; its activities run on `fabric-worker` with the
 * other instruction git work. The API creates the repository, connects it
 * and records the run before it starts this workflow, so no credential ever
 * travels in its input or history.
 *
 * Steps, each recorded on the run's row: COPYING (one commit on the
 * instructions repository's default branch), CONFIGURING (Coding
 * Instructions read from that repository), CLEANUP (a pull request removing
 * the files from the code repository), DONE. The cleanup comes last, so the
 * code repository loses nothing until the copy is in place.
 *
 * Imports only the SDK, the task-queue constant and type-only activity
 * signatures, as the workflow sandbox requires.
 */
import {
	ApplicationFailure,
	isCancellation,
	proxyActivities,
	workflowInfo,
} from "@temporalio/workflow";
import type * as consolidation from "../activities/instruction-consolidation";
import { INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE } from "../task-queues";

const git = proxyActivities<typeof consolidation>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "10 minutes",
	retry: {
		maximumAttempts: 4,
		initialInterval: "15 seconds",
		backoffCoefficient: 2,
	},
});

const record = proxyActivities<typeof consolidation>({
	taskQueue: INSTRUCTION_SYNC_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "30 seconds",
	retry: { maximumAttempts: 20, initialInterval: "5 seconds" },
});

function messageOf(error: unknown): string {
	let current: unknown = error;
	while (current instanceof Error) {
		if (current instanceof ApplicationFailure) {
			return current.message;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return "The move stopped because of an internal error. Try again.";
}

export async function instructionConsolidationWorkflow(
	input: consolidation.InstructionConsolidationWorkflowInput,
): Promise<{ pullRequestUrl: string | null }> {
	const ids = {
		consolidationId: input.consolidationId,
		projectId: input.projectId,
	};
	// The run's start time, whole seconds: the same commits on every retry and replay.
	const date = `${workflowInfo().startTime.toISOString().slice(0, 19)}Z`;
	const step = { ...input, date };
	try {
		await record.recordConsolidationStepActivity({
			...ids,
			step: "COPYING",
		});
		await git.copyConsolidationFilesActivity(step);
		await record.recordConsolidationStepActivity({
			...ids,
			step: "CONFIGURING",
		});
		await git.configureConsolidationSyncActivity(step);
		await record.recordConsolidationStepActivity({
			...ids,
			step: "CLEANUP",
		});
		const cleanup = await git.openConsolidationCleanupActivity(step);
		await record.recordConsolidationStepActivity({
			...ids,
			step: "DONE",
			status: "COMPLETED",
			error: null,
		});
		return cleanup;
	} catch (error) {
		if (isCancellation(error)) {
			throw error;
		}
		await record.recordConsolidationStepActivity({
			...ids,
			status: "FAILED",
			error: messageOf(error),
		});
		throw error;
	}
}
