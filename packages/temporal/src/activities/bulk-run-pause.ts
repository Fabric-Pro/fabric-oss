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
	getBulkRunPauseStage,
	notifyBulkRunPlanPaused,
	notifyBulkRunPlanStopped,
	recordBulkRunPause,
} from "@repo/database";
import { withoutResumeDocuments } from "@repo/database/prisma/queries/bulk-run-resume-documents";
import { logger } from "@repo/logs";
import { Context } from "@temporalio/activity";
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
	/**
	 * A document batch's or setup's documents still to generate: queued for
	 * the resume, those the run still holds.
	 */
	queuedDocumentIds?: string[];
}

export type PauseBulkRunResult =
	| { paused: true; resumesAt: string; pauseCount: number }
	| { paused: false; message: string };

export const BULK_RUN_PAUSE_CAP_MESSAGE =
	"Every ChatGPT plan this work may use stayed spent through every pause (up to six, within 24 hours). Run it again later, or ask an admin to let background work use the organization's AI provider.";

const BULK_RUN_GONE_MESSAGE =
	"The run was cancelled while it waited for a ChatGPT plan.";

/**
 * The statuses of a document a bulk run still holds: DRAFT while a batch has
 * not reached it (a batch creates its documents DRAFT), QUEUED while it waits
 * for a resume, GENERATING while it is written. Any other status means
 * something else ended the run's hold: a person's save over a stalled run
 * completes the document (Fizzy #2946), and the stale-generation sweep fails
 * one.
 */
const HELD_DOCUMENT_STATUSES = ["DRAFT", "QUEUED", "GENERATING"] as const;

/**
 * How each kind names the child it generates a document in
 * (`batch-document-generation.ts`, `existing-project-setup.ts`): a Proposal
 * child records its own workflow id on the document when it claims the live
 * preview.
 */
const DOCUMENT_CHILD_INFIX: Partial<Record<BulkRunKind, string>> = {
	DOCUMENT_BATCH: "-child-",
	PROJECT_SETUP: "-doc-",
};

/**
 * The workflow run this activity pauses: the one that scheduled it. Always
 * set for an activity a workflow scheduled; without it only documents no run
 * recorded itself on count as the run's.
 */
function pausingWorkflowId(): string | undefined {
	return Context.current().info.workflowExecution?.workflowId;
}

/**
 * Queues the documents the pausing run still holds under the resume's id and
 * returns those queued there. A document is the run's while its status says a
 * run holds it and its workflow id is none (a first run, which records none),
 * the pausing run's own (a resume's documents carry it) or one of that run's
 * document children. Never another resume's: a Run now resume, or the
 * scheduled one, owns its documents once it moved them, and a newer
 * generation stamps its own id.
 *
 * A document already queued under this pause's resume is not written again
 * and is read back by that identity, so a retried pause counts the documents
 * its earlier attempt queued and nothing else.
 */
async function queueHeldDocuments(args: {
	kind: BulkRunKind;
	documentIds: string[];
	pausingWorkflowId: string | undefined;
	resumeWorkflowId: string;
	now: Date;
}): Promise<Set<string>> {
	const pausing = args.pausingWorkflowId;
	const childInfix = DOCUMENT_CHILD_INFIX[args.kind];
	// QUEUED under the resume's id: the stale-generation sweep leaves a
	// queued document alone while that run exists — delayed counts — and
	// fails it once the run is gone, a lost resume included.
	await db.projectDocument.updateMany({
		where: {
			id: { in: args.documentIds },
			status: { in: [...HELD_DOCUMENT_STATUSES] },
			OR: [
				{ workflowId: null },
				...(pausing ? [{ workflowId: pausing }] : []),
				...(pausing && childInfix
					? [
							{
								workflowId: {
									startsWith: `${pausing}${childInfix}`,
								},
							},
						]
					: []),
			],
		},
		data: {
			status: "QUEUED",
			workflowId: args.resumeWorkflowId,
			generationStartedAt: args.now,
			generationProgress: 0,
		},
	});
	const queued = await db.projectDocument.findMany({
		where: {
			id: { in: args.documentIds },
			status: "QUEUED",
			workflowId: args.resumeWorkflowId,
		},
		select: { id: true },
	});
	return new Set(queued.map((doc) => doc.id));
}

/**
 * Records the pause on the run's row and schedules the resume run for when
 * the plans reset. Idempotent: a retry finds its own row write, and the
 * resume's id is derived from the run and the pause count, so a second start
 * is the same run.
 *
 * A document batch's or setup's documents still to generate are queued for
 * the resume first, and only those the run still holds; the rest leave the
 * saved state and the resume's input, both built from the one set, so the
 * resume cannot generate over a person's save or take a document a newer
 * generation owns (Fizzy #2946). A retry saves its own set over the earlier
 * attempt's while the run still waits, so Run now reads the list the
 * scheduled resume starts with.
 *
 * A retry that finds the pause already taken back by a resume (Run now, or
 * the scheduled one) writes nothing and starts nothing: the run is that
 * resume's now, and the pausing run ends as paused.
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
	const resumedMeanwhile = (pauseCount: number): PauseBulkRunResult => {
		logger.info("[BulkRunPause] A resume already took the paused run", {
			kind: input.kind,
			runId: input.runId,
			pauseCount,
		});
		return {
			paused: true,
			resumesAt: new Date(now).toISOString(),
			pauseCount,
		};
	};

	// Before the pause is recorded, so its saved state is built from the
	// documents queued here; only while the run is this pause's to record or
	// still waits on it. At the cap, or for a run cancelled meanwhile, the
	// workflow fails the documents it handed over, these included.
	let saved: Pick<BulkRunResumeState, "input" | "progress"> = {
		input: input.input,
		progress: input.progress,
	};
	if (input.queuedDocumentIds?.length) {
		const stage = await getBulkRunPauseStage({
			kind: input.kind,
			runId: input.runId,
			expectedPauseCount: input.pauseCount,
		});
		if (stage === "resumed") {
			return resumedMeanwhile(nextPauseCount);
		}
		if (stage === "gone") {
			return { paused: false, message: BULK_RUN_GONE_MESSAGE };
		}
		const held = await queueHeldDocuments({
			kind: input.kind,
			documentIds: input.queuedDocumentIds,
			pausingWorkflowId: pausingWorkflowId(),
			resumeWorkflowId,
			now: new Date(now),
		});
		const released = new Set(
			input.queuedDocumentIds.filter((id) => !held.has(id)),
		);
		if (released.size > 0) {
			saved = withoutResumeDocuments(input.kind, saved, released);
			logger.info(
				"[BulkRunPause] Left out documents the run no longer holds",
				{
					kind: input.kind,
					runId: input.runId,
					documentIds: [...released],
				},
			);
		}
	}

	const resumeState: BulkRunResumeState = {
		workflowType: input.workflowType,
		taskQueue: input.taskQueue,
		...(input.executionTimeoutMs !== undefined && {
			executionTimeoutMs: input.executionTimeoutMs,
		}),
		workflowIdBase: input.workflowIdBase,
		input: saved.input,
		...(saved.progress !== undefined && { progress: saved.progress }),
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
	if (recorded.status === "resumed") {
		return resumedMeanwhile(recorded.pauseCount);
	}
	if (recorded.status === "gone") {
		return { paused: false, message: BULK_RUN_GONE_MESSAGE };
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
			args: [{ ...saved.input, resumeOf }],
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
