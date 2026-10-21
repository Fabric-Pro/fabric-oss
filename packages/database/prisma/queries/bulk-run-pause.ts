/**
 * Bulk runs that pause for a ChatGPT plan reset and resume later (Fizzy
 * #2770): a security/accessibility scan, its finding review and grouping, and
 * a batch document generation (whose run row is its `AgentTask`).
 *
 * When every shared plan a run may use is spent and the organization waits
 * for the reset, the run saves its progress here, sets `WAITING_FOR_PLAN`
 * with `resumesAt`, and ends; a resume run started for `resumesAt` claims the
 * row back. Every transition is a compare-and-set on the status and the pause
 * count, so the scheduled resume, "Run now on API billing" and Cancel can
 * race and exactly one of them wins.
 */

import { db, type Prisma } from "../client";
import {
	LLM_PROVIDER_PURPOSE_FILTER,
	readProviderRowCredentials,
} from "./ai-gateway";
import {
	bulkRunResumeDocumentIds,
	withoutResumeDocuments,
} from "./bulk-run-resume-documents";
import { notifyBulkRunPlanStopped } from "./chatgpt-plan-work-notifications";

export type BulkRunKind =
	| "PROJECT_SCAN"
	| "SCAN_REVIEW"
	| "SCAN_GROUPING"
	| "DOCUMENT_BATCH"
	| "ATLAS_ANALYSIS"
	| "PROJECT_SETUP";

export const BULK_RUN_WAITING_STATUS = "WAITING_FOR_PLAN";

/** A run pauses at most this many times… */
export const BULK_RUN_MAX_PAUSES = 6;
/** …and never resumes later than this after it first paused. */
export const BULK_RUN_MAX_PAUSED_MS = 24 * 60 * 60_000;

/**
 * What a paused run needs to start again: the workflow to start, on which
 * queue and with which input, and what it had finished. The input never
 * carries a credential: a resumed document batch mints a fresh agent token.
 */
export interface BulkRunResumeState {
	workflowType: string;
	taskQueue: string;
	executionTimeoutMs?: number;
	workflowIdBase: string;
	input: Record<string, unknown>;
	progress?: unknown;
}

interface PausableDelegate {
	updateMany(args: {
		where: Record<string, unknown>;
		data: Record<string, unknown>;
	}): Promise<{ count: number }>;
	findUnique(args: {
		where: { id: string };
		select: Record<string, boolean>;
	}): Promise<Record<string, unknown> | null>;
	findMany(args: {
		where: Record<string, unknown>;
		select: Record<string, boolean>;
	}): Promise<Record<string, unknown>[]>;
}

// The four tables share the pause columns but not a Prisma type.
function delegate(kind: BulkRunKind): PausableDelegate {
	switch (kind) {
		case "PROJECT_SCAN":
			return db.projectScan as unknown as PausableDelegate;
		case "SCAN_REVIEW":
			return db.scanFindingReview as unknown as PausableDelegate;
		case "SCAN_GROUPING":
			return db.scanFindingGrouping as unknown as PausableDelegate;
		case "DOCUMENT_BATCH":
		case "PROJECT_SETUP":
			return db.agentTask as unknown as PausableDelegate;
		case "ATLAS_ANALYSIS":
			return db.atlasAnalysisRun as unknown as PausableDelegate;
		default: {
			const unreachable: never = kind;
			return unreachable;
		}
	}
}

/** The `agentId` of a project setup's run row, its `AgentTask`. */
export const PROJECT_SETUP_AGENT_ID = "project_setup";

/** Which `AgentTask` rows are the runs of each AgentTask-backed kind. */
const AGENT_TASK_AGENT_IDS: Partial<Record<BulkRunKind, string>> = {
	DOCUMENT_BATCH: "project_document_generator",
	PROJECT_SETUP: PROJECT_SETUP_AGENT_ID,
};

/** `AgentTask` has no `startedAt`; the scan tables do. */
function startedNow(kind: BulkRunKind, now: Date): Record<string, unknown> {
	return AGENT_TASK_AGENT_IDS[kind] ? {} : { startedAt: now };
}

/**
 * Only the rows of `kind`: the AgentTask-backed kinds share one table, and a
 * sweep over one must not close the other's runs.
 */
function rowsOfKind(kind: BulkRunKind): Record<string, unknown> {
	const agentId = AGENT_TASK_AGENT_IDS[kind];
	return agentId ? { agentId } : {};
}

export type RecordBulkRunPauseResult =
	| { status: "paused"; pauseCount: number; resumesAt: Date }
	| { status: "cap"; pauseCount: number }
	| { status: "resumed"; pauseCount: number }
	| { status: "gone" };

/**
 * Where a run stands for the pause it started at `expectedPauseCount`:
 * `pausing` before that pause is recorded, `paused` once it is and the run
 * waits, `resumed` once a resume (the scheduled one or Run now) took the run
 * back, or a later pause of it, and `gone` when the run was cancelled, failed
 * or deleted. Only a retried pause activity ever reads a stage past `pausing`.
 */
export type BulkRunPauseStage = "pausing" | "paused" | "resumed" | "gone";

function pauseStageOf(
	row: Record<string, unknown> | null,
	expectedPauseCount: number,
): BulkRunPauseStage {
	if (!row) {
		return "gone";
	}
	const pauseCount = row.pauseCount as number;
	if (pauseCount === expectedPauseCount) {
		return row.status === "PENDING" || row.status === "RUNNING"
			? "pausing"
			: "gone";
	}
	if (pauseCount < expectedPauseCount || row.status === "FAILED") {
		return "gone";
	}
	return pauseCount === expectedPauseCount + 1 &&
		row.status === BULK_RUN_WAITING_STATUS
		? "paused"
		: "resumed";
}

/** The run's {@link BulkRunPauseStage} for the pause it started at `expectedPauseCount`. */
export async function getBulkRunPauseStage(args: {
	kind: BulkRunKind;
	runId: string;
	expectedPauseCount: number;
}): Promise<BulkRunPauseStage> {
	const row = await delegate(args.kind).findUnique({
		where: { id: args.runId },
		select: { status: true, pauseCount: true },
	});
	return pauseStageOf(row, args.expectedPauseCount);
}

/**
 * Pause a running run until `resumesAt`, keeping `resumeState`. A compare-
 * and-set on the pause count the run started with, so a retried write finds
 * its own earlier one and answers with it. `cap` when the run already paused
 * {@link BULK_RUN_MAX_PAUSES} times or would resume more than
 * {@link BULK_RUN_MAX_PAUSED_MS} after its first pause; `resumed` when a
 * retry finds the pause already taken back by a resume; `gone` when the row
 * is no longer this run's (deleted, or cancelled meanwhile).
 *
 * A retry that finds the run still waiting saves its own `resumeState` over
 * the earlier attempt's: the documents a batch or setup still holds can
 * change between attempts (Fizzy #2946), and the retry's set is the one it
 * schedules the resume with, so Run now reads the same list.
 */
export async function recordBulkRunPause(args: {
	kind: BulkRunKind;
	runId: string;
	expectedPauseCount: number;
	resumesAt: Date;
	resumeState: BulkRunResumeState;
	/** The scheduled resume run, recorded so a Cancel can stop it. */
	resumeWorkflowId: string;
	now?: Date;
}): Promise<RecordBulkRunPauseResult> {
	const now = args.now ?? new Date();
	const rows = delegate(args.kind);
	const row = await rows.findUnique({
		where: { id: args.runId },
		select: {
			status: true,
			pauseCount: true,
			firstPausedAt: true,
			resumesAt: true,
		},
	});
	const stage = pauseStageOf(row, args.expectedPauseCount);
	const savedResumesAt = row?.resumesAt;
	if (stage === "paused" && savedResumesAt instanceof Date) {
		const { count } = await rows.updateMany({
			where: {
				id: args.runId,
				pauseCount: args.expectedPauseCount + 1,
				status: BULK_RUN_WAITING_STATUS,
			},
			data: {
				resumeState:
					args.resumeState as unknown as Prisma.InputJsonValue,
			},
		});
		if (count === 1) {
			return {
				status: "paused",
				pauseCount: args.expectedPauseCount + 1,
				resumesAt: savedResumesAt,
			};
		}
		// A resume or a Cancel took the row between the read and the write.
		const moved = await rows.findUnique({
			where: { id: args.runId },
			select: { status: true, pauseCount: true },
		});
		return pauseStageOf(moved, args.expectedPauseCount) === "resumed"
			? { status: "resumed", pauseCount: moved?.pauseCount as number }
			: { status: "gone" };
	}
	if (stage === "resumed") {
		return { status: "resumed", pauseCount: row?.pauseCount as number };
	}
	if (!row || stage !== "pausing") {
		return { status: "gone" };
	}
	const pauseCount = row.pauseCount as number;
	const firstPausedAt =
		row.firstPausedAt instanceof Date ? row.firstPausedAt : now;
	if (
		pauseCount >= BULK_RUN_MAX_PAUSES ||
		args.resumesAt.getTime() - firstPausedAt.getTime() >
			BULK_RUN_MAX_PAUSED_MS
	) {
		return { status: "cap", pauseCount };
	}
	const { count } = await rows.updateMany({
		where: {
			id: args.runId,
			pauseCount: args.expectedPauseCount,
			status: { in: ["PENDING", "RUNNING"] },
		},
		data: {
			status: BULK_RUN_WAITING_STATUS,
			resumesAt: args.resumesAt,
			pauseCount: args.expectedPauseCount + 1,
			firstPausedAt,
			resumeState: args.resumeState as unknown as Prisma.InputJsonValue,
			apiOverrideAt: null,
			apiOverrideByUserId: null,
			workflowId: args.resumeWorkflowId,
		},
	});
	return count === 1
		? {
				status: "paused",
				pauseCount: args.expectedPauseCount + 1,
				resumesAt: args.resumesAt,
			}
		: { status: "gone" };
}

/**
 * The resume run takes its row back: `WAITING_FOR_PLAN` (the scheduled
 * resume) or `PENDING` with an API override (Run now), at the pause count it
 * was started for. Null when Cancel, the other resume or the sweep got there
 * first: the resume then ends without doing anything.
 */
export async function claimBulkRunResume(args: {
	kind: BulkRunKind;
	runId: string;
	pauseCount: number;
	viaApiOverride: boolean;
	now?: Date;
}): Promise<BulkRunResumeState | null> {
	const now = args.now ?? new Date();
	const rows = delegate(args.kind);
	const { count } = await rows.updateMany({
		where: {
			id: args.runId,
			pauseCount: args.pauseCount,
			...(args.viaApiOverride
				? { status: "PENDING", apiOverrideAt: { not: null } }
				: { status: BULK_RUN_WAITING_STATUS }),
		},
		data: {
			status: "RUNNING",
			resumesAt: null,
			...startedNow(args.kind, now),
		},
	});
	if (count !== 1) {
		return null;
	}
	const row = await rows.findUnique({
		where: { id: args.runId },
		select: { resumeState: true },
	});
	return (row?.resumeState as BulkRunResumeState | null | undefined) ?? null;
}

/**
 * The saved state of a paused batch or setup, without the documents its run
 * no longer holds (Fizzy #2946): every document it holds waits QUEUED under
 * its scheduled resume, and one that does not was taken since, by a newer
 * generation that found that resume never started. Other kinds' state as
 * saved.
 */
async function resumeStateOfHeldDocuments(
	kind: BulkRunKind,
	state: BulkRunResumeState,
	scheduledWorkflowId: string,
): Promise<BulkRunResumeState> {
	const documentIds = bulkRunResumeDocumentIds(kind, state);
	if (documentIds.length === 0) {
		return state;
	}
	const queued = await db.projectDocument.findMany({
		where: {
			id: { in: documentIds },
			status: "QUEUED",
			workflowId: scheduledWorkflowId,
		},
		select: { id: true },
	});
	const held = new Set(queued.map((doc) => doc.id));
	const released = new Set(documentIds.filter((id) => !held.has(id)));
	return released.size === 0
		? state
		: { ...state, ...withoutResumeDocuments(kind, state, released) };
}

/**
 * "Run now on API billing": a paused run leaves the wait for a resume that
 * starts at once and may use the organization's provider. Returns what that
 * resume starts from, or null when the run is no longer paused.
 *
 * A batch or setup starts from the documents its run still holds, saved in
 * the same write, so its resume reads the same list from the row.
 */
export async function approveBulkRunApiOverride(args: {
	kind: BulkRunKind;
	runId: string;
	userId: string;
	now?: Date;
}): Promise<{
	pauseCount: number;
	resumeState: BulkRunResumeState;
	/** The resume that starts now; recorded so a Cancel can stop it. */
	workflowId: string;
	/** The scheduled resume it replaces. */
	scheduledWorkflowId: string;
	/** When that one starts, for {@link revertBulkRunApiOverride}. */
	resumesAt: Date | null;
} | null> {
	const now = args.now ?? new Date();
	const rows = delegate(args.kind);
	const row = await rows.findUnique({
		where: { id: args.runId },
		select: {
			status: true,
			pauseCount: true,
			resumeState: true,
			resumesAt: true,
		},
	});
	if (!row || row.status !== BULK_RUN_WAITING_STATUS || !row.resumeState) {
		return null;
	}
	const pauseCount = row.pauseCount as number;
	const savedState = row.resumeState as BulkRunResumeState;
	const workflowId = bulkRunApiResumeWorkflowId(
		savedState.workflowIdBase,
		pauseCount,
	);
	const scheduledWorkflowId = bulkRunResumeWorkflowId(
		savedState.workflowIdBase,
		pauseCount,
	);
	const resumeState = await resumeStateOfHeldDocuments(
		args.kind,
		savedState,
		scheduledWorkflowId,
	);
	const { count } = await rows.updateMany({
		where: {
			id: args.runId,
			pauseCount,
			status: BULK_RUN_WAITING_STATUS,
		},
		data: {
			status: "PENDING",
			resumesAt: null,
			apiOverrideAt: now,
			apiOverrideByUserId: args.userId,
			workflowId,
			...startedNow(args.kind, now),
			...(resumeState !== savedState && {
				resumeState: resumeState as unknown as Prisma.InputJsonValue,
			}),
		},
	});
	return count === 1
		? {
				pauseCount,
				resumeState,
				workflowId,
				scheduledWorkflowId,
				resumesAt: row.resumesAt instanceof Date ? row.resumesAt : null,
			}
		: null;
}

/**
 * Undo an approval whose resume never started: the run waits for its
 * scheduled resume again, which still claims it on time. A no-op once that
 * resume, or anything else, has moved the row on.
 */
export async function revertBulkRunApiOverride(args: {
	kind: BulkRunKind;
	runId: string;
	pauseCount: number;
	resumesAt: Date | null;
	scheduledWorkflowId: string;
}): Promise<boolean> {
	const { count } = await delegate(args.kind).updateMany({
		where: {
			id: args.runId,
			pauseCount: args.pauseCount,
			status: "PENDING",
			apiOverrideAt: { not: null },
		},
		data: {
			status: BULK_RUN_WAITING_STATUS,
			resumesAt: args.resumesAt,
			workflowId: args.scheduledWorkflowId,
			apiOverrideAt: null,
			apiOverrideByUserId: null,
		},
	});
	return count === 1;
}

/**
 * Whether the organization has an LLM provider of its own with a usable
 * credential — what "Run now on API billing" bills. Never a member's personal
 * key or the platform's gateway key; an embeddings-only key does not count.
 */
export async function organizationHasLlmApiProvider(
	organizationId: string,
): Promise<boolean> {
	const rows = await db.cloudProviderConfig.findMany({
		where: {
			organizationId,
			enabled: true,
			...LLM_PROVIDER_PURPOSE_FILTER,
		},
		select: {
			encryptedApiKey: true,
			clientId: true,
			encryptedClientSecret: true,
			config: true,
		},
	});
	return rows.some((row) => readProviderRowCredentials(row).hasCredentials);
}

export interface PausedDocumentBatch {
	id: string;
	resumesAt: Date | null;
	pauseCount: number;
	/** Documents the resume still has to generate. */
	pendingDocumentCount: number;
}

/**
 * The project's batch document generation paused for a ChatGPT plan reset,
 * if one is: its run row is the batch's `AgentTask`. Scoped to the project's
 * own tenant.
 */
export async function getPausedDocumentBatch(args: {
	projectId: string;
	organizationId: string | null;
	userId: string;
}): Promise<PausedDocumentBatch | null> {
	const task = await db.agentTask.findFirst({
		where: {
			agentId: "project_document_generator",
			status: BULK_RUN_WAITING_STATUS,
			...(args.organizationId
				? { organizationId: args.organizationId }
				: { organizationId: null, userId: args.userId }),
			input: { path: ["projectId"], equals: args.projectId },
		},
		orderBy: { updatedAt: "desc" },
		select: {
			id: true,
			resumesAt: true,
			pauseCount: true,
			resumeState: true,
		},
	});
	if (!task) {
		return null;
	}
	const state = task.resumeState as BulkRunResumeState | null;
	const documents = state?.input.documents;
	return {
		id: task.id,
		resumesAt: task.resumesAt,
		pauseCount: task.pauseCount,
		pendingDocumentCount: Array.isArray(documents) ? documents.length : 0,
	};
}

/**
 * A paused batch's queued documents follow its resume to a new run (Run now),
 * so the stale-generation sweep asks about the run that will write them.
 */
export async function moveQueuedDocumentsToRun(args: {
	fromWorkflowId: string;
	toWorkflowId: string;
}): Promise<number> {
	const { count } = await db.projectDocument.updateMany({
		where: { status: "QUEUED", workflowId: args.fromWorkflowId },
		data: { workflowId: args.toWorkflowId },
	});
	return count;
}

/** A cancelled batch's queued documents end FAILED with the reason. */
export async function failQueuedDocumentsOfRun(args: {
	workflowId: string;
	message: string;
}): Promise<number> {
	const { count } = await db.projectDocument.updateMany({
		where: { status: "QUEUED", workflowId: args.workflowId },
		data: { status: "FAILED", generationError: args.message },
	});
	return count;
}

/**
 * Cancel a paused run: it ends FAILED with `message`. Returns what it was
 * waiting to resume, or null when it is no longer paused.
 */
export async function cancelPausedBulkRun(args: {
	kind: BulkRunKind;
	runId: string;
	message: string;
	now?: Date;
}): Promise<{ pauseCount: number; resumeState: BulkRunResumeState } | null> {
	const now = args.now ?? new Date();
	const rows = delegate(args.kind);
	const row = await rows.findUnique({
		where: { id: args.runId },
		select: { status: true, pauseCount: true, resumeState: true },
	});
	if (!row || row.status !== BULK_RUN_WAITING_STATUS) {
		return null;
	}
	const pauseCount = row.pauseCount as number;
	const { count } = await rows.updateMany({
		where: {
			id: args.runId,
			pauseCount,
			status: BULK_RUN_WAITING_STATUS,
		},
		data: {
			status: "FAILED",
			error: args.message,
			resumesAt: null,
			completedAt: now,
		},
	});
	return count === 1
		? {
				pauseCount,
				resumeState: row.resumeState as BulkRunResumeState,
			}
		: null;
}

/**
 * How long past `resumesAt` a paused run may still be waiting before the sweep
 * calls its resume lost: the start delay is exact, so this only has to cover a
 * busy worker and the sweep's own cadence.
 */
export const PAUSED_RUN_RESUME_GRACE_MINUTES = 30;

export const BULK_RUN_RESUME_NEVER_STARTED_MESSAGE =
	"This run was waiting for a ChatGPT plan reset, but its resume never started. Run it again.";

/**
 * Fail paused runs whose resume should have started more than `graceMinutes`
 * ago: the waiting rows the stall sweeps skip, caught when the resume itself
 * was lost. Optionally one project's scans only. Each row is failed by its
 * own compare-and-set, so a resume that claims it meanwhile wins, and only
 * the runs this sweep failed are announced as stopped (Fizzy #3050).
 */
export async function failOverdueBulkRunResumes(args: {
	kind: BulkRunKind;
	graceMinutes: number;
	projectId?: string;
	now?: Date;
}): Promise<number> {
	const now = args.now ?? new Date();
	const threshold = new Date(now.getTime() - args.graceMinutes * 60_000);
	const rows = delegate(args.kind);
	const overdueWhere = {
		...rowsOfKind(args.kind),
		...(args.projectId ? { projectId: args.projectId } : {}),
		status: BULK_RUN_WAITING_STATUS,
		resumesAt: { lt: threshold },
	};
	const overdue = await rows.findMany({
		where: overdueWhere,
		select: { id: true },
	});
	let failed = 0;
	for (const { id } of overdue) {
		const { count } = await rows.updateMany({
			where: { ...overdueWhere, id },
			data: {
				status: "FAILED",
				error: BULK_RUN_RESUME_NEVER_STARTED_MESSAGE,
				resumesAt: null,
				completedAt: now,
			},
		});
		if (count !== 1) {
			continue;
		}
		failed++;
		await notifyBulkRunPlanStopped({
			kind: args.kind,
			runId: id as string,
			reason: "RESUME_LOST",
		});
	}
	return failed;
}
/** Which run a resume continues, carried on the resume run's input. */
export interface BulkRunResumeOf {
	runId: string;
	/** How often the run has paused; the resume claims the row at this count. */
	pauseCount: number;
	/** The run's first workflow id, which every resume id derives from. */
	workflowIdBase: string;
}

/** The id of the resume run scheduled after pause `pauseCount`. */
export function bulkRunResumeWorkflowId(
	workflowIdBase: string,
	pauseCount: number,
): string {
	return `${workflowIdBase}-resume-${pauseCount}`;
}

/** The id of the resume a person started at once on API billing. */
export function bulkRunApiResumeWorkflowId(
	workflowIdBase: string,
	pauseCount: number,
): string {
	return `${bulkRunResumeWorkflowId(workflowIdBase, pauseCount)}-api`;
}
