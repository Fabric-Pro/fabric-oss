/**
 * Ending a project setup paused for a ChatGPT plan reset (Fizzy #2770):
 * Cancel, and a newer setup of the same project, which always wins. The run
 * ends FAILED, the project's analysis and the documents queued for its resume
 * are closed, and the scheduled resume is stopped — so it can never write over
 * the newer setup's status.
 */

import {
	bulkRunResumeWorkflowId,
	cancelPausedBulkRun,
	closePausedProjectSetup,
	getPausedProjectSetup,
} from "@repo/database";

export const SETUP_CANCELLED_MESSAGE =
	"Setup cancelled while waiting for a ChatGPT plan reset. Run it again when you are ready.";

const SETUP_SUPERSEDED_MESSAGE =
	"A newer setup of this project started, so this one, which was waiting for a ChatGPT plan reset, was cancelled.";

/** False when the run was no longer paused (its resume got there first). */
export async function cancelPausedSetupRun(args: {
	runId: string;
	message: string;
}): Promise<boolean> {
	const cancelled = await cancelPausedBulkRun({
		kind: "PROJECT_SETUP",
		runId: args.runId,
		message: args.message,
	});
	if (!cancelled) {
		return false;
	}
	await closePausedProjectSetup({
		resumeState: cancelled.resumeState,
		pauseCount: cancelled.pauseCount,
		message: args.message,
	});
	try {
		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();
		await client.workflow
			.getHandle(
				bulkRunResumeWorkflowId(
					cancelled.resumeState.workflowIdBase,
					cancelled.pauseCount,
				),
			)
			.terminate("Cancelled by user");
	} catch {
		// The resume finds the row cancelled and ends on its own.
	}
	return true;
}

/**
 * Whether a setup of the project is paused for a plan reset: its analysis
 * reads SCANNING, yet a new setup may start — and replaces it.
 */
export async function projectSetupIsPaused(args: {
	projectId: string;
	organizationId: string | null;
	userId: string;
}): Promise<boolean> {
	return (await getPausedProjectSetup(args)) !== null;
}

/** At most this many paused setups of one project are cancelled in one go. */
const MAX_PAUSED_SETUPS = 10;

/**
 * Before a new setup of the project starts: every setup of it paused for a
 * plan reset is cancelled. Returns how many were.
 */
export async function cancelPausedSetupsOfProject(args: {
	projectId: string;
	organizationId: string | null;
	userId: string;
}): Promise<number> {
	let cancelled = 0;
	for (let i = 0; i < MAX_PAUSED_SETUPS; i++) {
		const paused = await getPausedProjectSetup(args);
		if (!paused) {
			break;
		}
		if (
			await cancelPausedSetupRun({
				runId: paused.id,
				message: SETUP_SUPERSEDED_MESSAGE,
			})
		) {
			cancelled++;
		}
	}
	return cancelled;
}
