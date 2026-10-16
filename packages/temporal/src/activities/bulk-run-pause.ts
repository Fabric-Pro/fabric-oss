/**
 * Pause and resume for bulk runs whose shared ChatGPT plans are all spent
 * (Fizzy #2770). The workflow side is `workflows/lib/bulk-run-pause.ts`; every
 * row write and the delayed start of the resume run live here.
 */

import {
	type BulkRunKind,
	type BulkRunResumeOf,
	type BulkRunResumeState,
	bulkRunResumeWorkflowId,
	claimBulkRunResume,
	db,
	notifyBulkRunPlanPaused,
	notifyBulkRunPlanStopped,
	recordBulkRunPause,
} from "@repo/database";
import { logger } from "@repo/logs";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import { getTemporalClient } from "../client";

/**
 * With no plan saying when it resets, a paused run sleeps this long: the
 * in-run wait guesses half an hour because it retries once, but a pause has a
 * cap, and guesses shorter than a plan window would spend it before the
 * window resets.
 */
const UNKNOWN_RESET_PAUSE_MS = 60 * 60_000;
/** Never schedule a resume sooner than this. */
const MIN_PAUSE_MS = 60_000;

export interface PauseBulkRunInput {
	kind: BulkRunKind;
	runId: string;
	/** The pause count the current run was started at (0 for the first run). */
	pauseCount: number;
	workflowIdBase: string;
	workflowType: string;
	taskQueue: string;
	executionTimeoutMs?: number;
	/** The run's input, without `resumeOf`, `allowApiFallback` or a token. */
	input: Record<string, unknown>;
	progress?: unknown;
	/** The reset estimate, jitter included. */
	waitMs: number;
	resetKnown: boolean;
	/** A document batch's documents still to generate: queued for the resume. */
	queuedDocumentIds?: string[];
}

export type PauseBulkRunResult =
	| { paused: true; resumesAt: string; pauseCount: number }
	| { paused: false; message: string };

export const BULK_RUN_PAUSE_CAP_MESSAGE =
	"Every ChatGPT plan this work may use stayed spent through every pause (up to six, within 24 hours). Run it again later, or ask an admin to let background work use the organization's AI provider.";

/**
 * Records the pause on the run's row and schedules the resume run for when
 * the plans reset. Idempotent: a retry finds its own row write, and the
 * resume's id is derived from the run and the pause count, so a second start
 * is the same run.
 *
 * The run's first pause, and its stop at the cap, are announced to whoever
 * started it and the organization's admins (Fizzy #3050). Neither notice can
 * fail the activity: the writers never throw.
 */
export async function pauseBulkRunActivity(
	input: PauseBulkRunInput,
): Promise<PauseBulkRunResult> {
	const now = Date.now();
	const delayMs = Math.max(
		input.resetKnown ? input.waitMs : UNKNOWN_RESET_PAUSE_MS,
		MIN_PAUSE_MS,
	);
	const nextPauseCount = input.pauseCount + 1;
	const resumeWorkflowId = bulkRunResumeWorkflowId(
		input.workflowIdBase,
		nextPauseCount,
	);
	const resumeState: BulkRunResumeState = {
		workflowType: input.workflowType,
		taskQueue: input.taskQueue,
		...(input.executionTimeoutMs !== undefined && {
			executionTimeoutMs: input.executionTimeoutMs,
		}),
		workflowIdBase: input.workflowIdBase,
		input: input.input,
		...(input.progress !== undefined && { progress: input.progress }),
	};
	const recorded = await recordBulkRunPause({
		kind: input.kind,
		runId: input.runId,
		expectedPauseCount: input.pauseCount,
		resumesAt: new Date(now + delayMs),
		resumeState,
		resumeWorkflowId,
	});
	if (recorded.status === "cap") {
		await notifyBulkRunPlanStopped({
			kind: input.kind,
			runId: input.runId,
			reason: "PLAN_SPENT",
		});
		return { paused: false, message: BULK_RUN_PAUSE_CAP_MESSAGE };
	}
	if (recorded.status === "gone") {
		return {
			paused: false,
			message:
				"The run was cancelled while it waited for a ChatGPT plan.",
		};
	}

	if (input.queuedDocumentIds?.length) {
		// QUEUED under the resume's id: the stale-generation sweep leaves a
		// queued document alone while that run exists — delayed counts — and
		// fails it once the run is gone, a lost resume included.
		await db.projectDocument.updateMany({
			where: { id: { in: input.queuedDocumentIds } },
			data: {
				status: "QUEUED",
				workflowId: resumeWorkflowId,
				generationStartedAt: new Date(now),
				generationProgress: 0,
			},
		});
	}

	const resumeOf: BulkRunResumeOf = {
		runId: input.runId,
		pauseCount: recorded.pauseCount,
		workflowIdBase: input.workflowIdBase,
	};
	const client = await getTemporalClient();
	try {
		await client.workflow.start(input.workflowType, {
			taskQueue: input.taskQueue,
			workflowId: resumeWorkflowId,
			args: [{ ...input.input, resumeOf }],
			startDelay: Math.max(recorded.resumesAt.getTime() - now, 0),
			...(input.executionTimeoutMs !== undefined && {
				workflowExecutionTimeout: input.executionTimeoutMs,
			}),
		});
	} catch (error) {
		if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
			throw error;
		}
	}
	logger.info("[BulkRunPause] Paused for a ChatGPT plan reset", {
		kind: input.kind,
		runId: input.runId,
		pauseCount: recorded.pauseCount,
		resumesAt: recorded.resumesAt.toISOString(),
	});
	// Last, once the resume is scheduled: a throw above retries the activity,
	// and the retry finds this same first pause recorded again.
	if (input.pauseCount === 0 && recorded.pauseCount === 1) {
		await notifyBulkRunPlanPaused({
			kind: input.kind,
			runId: input.runId,
			resumesAt: recorded.resumesAt,
			now: new Date(now),
		});
	}
	return {
		paused: true,
		resumesAt: recorded.resumesAt.toISOString(),
		pauseCount: recorded.pauseCount,
	};
}

export interface ClaimBulkRunResumeInput {
	kind: BulkRunKind;
	resumeOf: BulkRunResumeOf;
	/** A resume a person started on API billing, not the scheduled one. */
	viaApiOverride: boolean;
}

/**
 * The resume run takes its row back; `claimed: false` when a Cancel, the
 * other resume or the sweep got there first. `progress` is what the run had
 * finished when it paused.
 */
export async function claimBulkRunResumeActivity(
	input: ClaimBulkRunResumeInput,
): Promise<{ claimed: boolean; progress?: unknown }> {
	const state = await claimBulkRunResume({
		kind: input.kind,
		runId: input.resumeOf.runId,
		pauseCount: input.resumeOf.pauseCount,
		viaApiOverride: input.viaApiOverride,
	});
	if (!state) {
		return { claimed: false };
	}
	return {
		claimed: true,
		...(state.progress !== undefined && { progress: state.progress }),
	};
}
