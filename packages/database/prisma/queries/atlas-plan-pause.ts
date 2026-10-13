/**
 * An Atlas analysis run paused for a ChatGPT plan reset (Fizzy #2770).
 *
 * The run's `AtlasAnalysisRun` row is the pause row (`ATLAS_ANALYSIS` in
 * `bulk-run-pause.ts`); the analysis row mirrors it, because the page, the
 * in-flight guard and the stale-run sweep all read the analysis. Its
 * `activeRunStatus` reads WAITING_FOR_PLAN while the run waits, and so does
 * its served `status` unless a READY snapshot keeps serving.
 */

import { db } from "../client";
import {
	BULK_RUN_RESUME_NEVER_STARTED_MESSAGE,
	BULK_RUN_WAITING_STATUS,
} from "./bulk-run-pause";

const WAITING = "WAITING_FOR_PLAN" as const;
const RUNNING_STATUSES = ["PENDING", "ANALYZING"] as const;

/**
 * Moves the analysis's run markers to `to`, keeping a served READY snapshot.
 * Only while the markers read one of `from`, so a write that lost a race to
 * a Cancel (which clears them) changes nothing.
 */
async function moveAnalysisRun(args: {
	analysisId: string;
	from: ReadonlyArray<"PENDING" | "ANALYZING" | typeof WAITING>;
	to: "PENDING" | "ANALYZING" | typeof WAITING;
	data?: { workflowId?: string; activeRunStartedAt?: Date };
}): Promise<boolean> {
	const from = [...args.from];
	const [served, background] = await db.$transaction([
		db.atlasAnalysis.updateMany({
			where: {
				id: args.analysisId,
				status: { in: from },
			},
			data: { status: args.to, activeRunStatus: args.to, ...args.data },
		}),
		db.atlasAnalysis.updateMany({
			where: {
				id: args.analysisId,
				status: { notIn: from },
				activeRunStatus: { in: from },
			},
			data: { activeRunStatus: args.to, ...args.data },
		}),
	]);
	return served.count + background.count > 0;
}

/** The run paused: the analysis reads WAITING_FOR_PLAN until it resumes. */
export function markAtlasAnalysisWaitingForPlan(
	analysisId: string,
): Promise<boolean> {
	return moveAnalysisRun({
		analysisId,
		from: RUNNING_STATUSES,
		to: WAITING,
	});
}

/**
 * "Run now on API billing" was approved: the analysis reads PENDING under the
 * resume that starts now. A no-op once that resume has claimed the run.
 */
export function markAtlasAnalysisResumeApproved(args: {
	analysisId: string;
	workflowId: string;
	now?: Date;
}): Promise<boolean> {
	return moveAnalysisRun({
		analysisId: args.analysisId,
		from: [WAITING],
		to: "PENDING",
		data: {
			workflowId: args.workflowId,
			activeRunStartedAt: args.now ?? new Date(),
		},
	});
}

/**
 * A resume claimed the run: the analysis reads ANALYZING again under the
 * resume's workflow (what "Cancel analysis" stops), and the run's clock
 * restarts, since the stale-run sweep measures the resumed leg, not the wait.
 */
export async function markAtlasAnalysisResumed(args: {
	analysisId: string;
	workflowId: string;
	now?: Date;
}): Promise<void> {
	await moveAnalysisRun({
		analysisId: args.analysisId,
		from: [WAITING, ...RUNNING_STATUSES],
		to: "ANALYZING",
		data: {
			workflowId: args.workflowId,
			activeRunStartedAt: args.now ?? new Date(),
		},
	});
}

export interface PausedAtlasRun {
	id: string;
	analysisId: string;
	resumesAt: Date | null;
	pauseCount: number;
}

/**
 * The analysis run paused for a ChatGPT plan reset, if one is. Scoped to the
 * project and its own tenant.
 */
export async function getPausedAtlasRun(args: {
	analysisId: string;
	projectId: string;
	organizationId: string | null;
	userId: string;
}): Promise<PausedAtlasRun | null> {
	return db.atlasAnalysisRun.findFirst({
		where: {
			analysisId: args.analysisId,
			projectId: args.projectId,
			status: BULK_RUN_WAITING_STATUS,
			...(args.organizationId
				? { organizationId: args.organizationId }
				: { organizationId: null, userId: args.userId }),
		},
		orderBy: { startedAt: "desc" },
		select: {
			id: true,
			analysisId: true,
			resumesAt: true,
			pauseCount: true,
		},
	});
}

/**
 * Analyses left reading WAITING_FOR_PLAN with no run that could still resume
 * them — the watchdog failed the run because its resume never started. The
 * failure clears the run markers and keeps a served READY snapshot, as any
 * failed re-run does.
 */
export async function failAtlasAnalysesLeftWaiting(): Promise<number> {
	const orphaned = await db.atlasAnalysis.findMany({
		where: {
			OR: [{ status: WAITING }, { activeRunStatus: WAITING }],
			runs: {
				none: {
					status: {
						in: [BULK_RUN_WAITING_STATUS, "PENDING", "RUNNING"],
					},
				},
			},
		},
		select: { id: true },
	});
	if (orphaned.length === 0) {
		return 0;
	}
	const ids = orphaned.map((row) => row.id);
	const markers = {
		activeRunStatus: null,
		activeRunStartedAt: null,
		error: BULK_RUN_RESUME_NEVER_STARTED_MESSAGE,
	};
	const [withSnapshot, withoutSnapshot] = await db.$transaction([
		db.atlasAnalysis.updateMany({
			where: { id: { in: ids }, analyzedCommitSha: { not: null } },
			data: {
				...markers,
				status: "READY",
			},
		}),
		db.atlasAnalysis.updateMany({
			where: { id: { in: ids }, analyzedCommitSha: null },
			data: { ...markers, status: "FAILED" },
		}),
	]);
	return withSnapshot.count + withoutSnapshot.count;
}
