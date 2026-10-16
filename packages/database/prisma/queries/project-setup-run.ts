/**
 * A project setup (code analysis, backlog ingest and the first documents)
 * that pauses for a ChatGPT plan reset (Fizzy #2770). Its run row is an
 * `AgentTask` with agentId {@link PROJECT_SETUP_AGENT_ID}, paused and resumed
 * like every other bulk run (`bulk-run-pause.ts`).
 *
 * While the run waits, the project's `codeAnalysisStatus` stays SCANNING:
 * the setup is still under way. Every exit that ends a paused run without its
 * workflow — Cancel and the lost-resume sweep — must close the project's
 * analysis too, or it reads SCANNING forever.
 */

import { db } from "../client";
import {
	BULK_RUN_RESUME_NEVER_STARTED_MESSAGE,
	BULK_RUN_WAITING_STATUS,
	type BulkRunResumeState,
	bulkRunResumeWorkflowId,
	failQueuedDocumentsOfRun,
	PROJECT_SETUP_AGENT_ID,
} from "./bulk-run-pause";
import { notifyBulkRunPlanStopped } from "./chatgpt-plan-work-notifications";

/**
 * What a paused setup saved, as the setup workflow writes it. Read here only
 * for how many documents the resume still has to write.
 */
interface ProjectSetupPauseProgress {
	documents?: unknown[];
	finishedDocumentIds?: unknown[];
}

export interface PausedProjectSetup {
	id: string;
	resumesAt: Date | null;
	pauseCount: number;
	/** Documents the resume still has to generate. */
	pendingDocumentCount: number;
}

interface ProjectSetupRunScope {
	projectId: string;
	organizationId: string | null;
	userId: string;
}

function tenantOf(scope: ProjectSetupRunScope) {
	return scope.organizationId
		? { organizationId: scope.organizationId }
		: { organizationId: null, userId: scope.userId };
}

function pendingDocumentCount(state: BulkRunResumeState | null): number {
	if (!state) {
		return 0;
	}
	const progress = state.progress as ProjectSetupPauseProgress | undefined;
	if (Array.isArray(progress?.documents)) {
		const finished = Array.isArray(progress.finishedDocumentIds)
			? progress.finishedDocumentIds.length
			: 0;
		return Math.max(progress.documents.length - finished, 0);
	}
	// Paused before its documents were created: all of them are still to do.
	const selected = state.input.selectedDocumentTypes;
	return Array.isArray(selected) ? selected.length : 0;
}

/**
 * The project's setup paused for a ChatGPT plan reset, if one is. Scoped to
 * the project's own tenant.
 */
export async function getPausedProjectSetup(
	scope: ProjectSetupRunScope,
): Promise<PausedProjectSetup | null> {
	const task = await db.agentTask.findFirst({
		where: {
			agentId: PROJECT_SETUP_AGENT_ID,
			status: BULK_RUN_WAITING_STATUS,
			...tenantOf(scope),
			input: { path: ["projectId"], equals: scope.projectId },
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
	return {
		id: task.id,
		resumesAt: task.resumesAt,
		pauseCount: task.pauseCount,
		pendingDocumentCount: pendingDocumentCount(
			task.resumeState as BulkRunResumeState | null,
		),
	};
}

/**
 * A setup run of this project in its tenant, whatever its status; null for a
 * run of another project, another tenant, or not a setup run at all.
 */
export async function getProjectSetupRun(
	scope: ProjectSetupRunScope & { runId: string },
): Promise<{ id: string; status: string } | null> {
	return db.agentTask.findFirst({
		where: {
			id: scope.runId,
			agentId: PROJECT_SETUP_AGENT_ID,
			...tenantOf(scope),
			input: { path: ["projectId"], equals: scope.projectId },
		},
		select: { id: true, status: true },
	});
}

/**
 * A setup that ended while it waited for a plan reset: the project's analysis
 * reads FAILED and the documents queued for its resume fail with `message`.
 * Only while the project's analysis is still this setup's — a newer setup
 * owns it otherwise.
 */
export async function closePausedProjectSetup(args: {
	resumeState: BulkRunResumeState;
	pauseCount: number;
	message: string;
}): Promise<void> {
	const projectId = args.resumeState.input.projectId;
	if (typeof projectId === "string") {
		await db.project.updateMany({
			where: {
				id: projectId,
				codeAnalysisStatus: "SCANNING",
				codeAnalysisWorkflowId: args.resumeState.workflowIdBase,
			},
			data: { codeAnalysisStatus: "FAILED" },
		});
	}
	await failQueuedDocumentsOfRun({
		workflowId: bulkRunResumeWorkflowId(
			args.resumeState.workflowIdBase,
			args.pauseCount,
		),
		message: args.message,
	});
}

/**
 * The lost-resume sweep for setups: a paused setup whose resume should have
 * started more than `graceMinutes` ago fails, and so do its project's
 * analysis and its queued documents.
 */
export async function failOverdueProjectSetupResumes(args: {
	graceMinutes: number;
	now?: Date;
}): Promise<number> {
	const now = args.now ?? new Date();
	const threshold = new Date(now.getTime() - args.graceMinutes * 60_000);
	const overdue = await db.agentTask.findMany({
		where: {
			agentId: PROJECT_SETUP_AGENT_ID,
			status: BULK_RUN_WAITING_STATUS,
			resumesAt: { lt: threshold },
		},
		select: { id: true, pauseCount: true, resumeState: true },
	});
	let failed = 0;
	for (const run of overdue) {
		const { count } = await db.agentTask.updateMany({
			where: {
				id: run.id,
				pauseCount: run.pauseCount,
				status: BULK_RUN_WAITING_STATUS,
			},
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
		const resumeState = run.resumeState as BulkRunResumeState | null;
		if (resumeState) {
			await closePausedProjectSetup({
				resumeState,
				pauseCount: run.pauseCount,
				message: BULK_RUN_RESUME_NEVER_STARTED_MESSAGE,
			});
		}
		await notifyBulkRunPlanStopped({
			kind: "PROJECT_SETUP",
			runId: run.id,
			reason: "RESUME_LOST",
		});
	}
	return failed;
}
