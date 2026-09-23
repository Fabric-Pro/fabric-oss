import {
	db,
	failBackgroundJob,
	openExclusiveBackgroundJob,
} from "@repo/database";
import { STALL_MINUTES_BY_SOURCE } from "../../capabilities/thresholds";

/**
 * The durable "a PM story pull/push is running" fact (FR54).
 *
 * The API opens one `PM_STORY_SYNC` row just BEFORE the story-sync workflow
 * starts; the workflow closes it in a `finally`. The Roadmap reads it to show
 * Processing across reloads, and the capability engine reads it to refuse a
 * second sync while one is running.
 *
 * Why before, not after: a run that ends at once (preflight failure, nothing
 * to push) can reach its closer before an after-start write lands. That
 * closer matches nothing, and the late row then reads as a running sync for
 * the whole stall window, refusing every pull. A failed start is closed with
 * `failPmStorySyncJob` instead.
 *
 * The open is also the guard: the check for a live run and the open happen
 * under one per-project advisory lock, so two near-simultaneous requests
 * cannot both pass the capability gate's read and both start a sync.
 */

type PmStorySyncDirection = "pull" | "push";

const SOURCE_BY_DIRECTION = {
	pull: "pmStoryPull",
	push: "pmStoryPush",
} as const satisfies Record<PmStorySyncDirection, string>;

interface OpenPmStorySyncJobArgs {
	workflowId: string;
	projectId: string;
	userId: string;
	organizationId: string | null;
	direction: PmStorySyncDirection;
}

/**
 * Open the project's PM_STORY_SYNC row unless a live sync already holds it.
 * Returns the run in the way, or null once this caller's row is open. Throws
 * on a database failure: without the guard the caller would risk exactly the
 * duplicate run it exists to refuse.
 */
export async function openPmStorySyncJob(
	args: OpenPmStorySyncJobArgs,
): Promise<ActivePmStorySync | null> {
	const result = await openExclusiveBackgroundJob({
		lockKey: `pm-story-sync:${args.projectId}`,
		liveSince: liveHeartbeatCutoff(),
		job: {
			kind: "PM_STORY_SYNC",
			title:
				args.direction === "pull"
					? "Pull from project management"
					: "Push to project management",
			projectId: args.projectId,
			userId: args.userId,
			organizationId: args.organizationId,
			workflowId: args.workflowId,
			sourceType: SOURCE_BY_DIRECTION[args.direction],
			sourceId: args.projectId,
		},
	});
	return result.opened ? null : toActiveSync(result.active);
}

/** Close the row a start that threw had opened. Best-effort, never throws. */
export async function failPmStorySyncJob(args: {
	workflowId: string;
	projectId: string;
	error: string;
}): Promise<void> {
	await failBackgroundJob(
		{ workflowId: args.workflowId, sourceId: args.projectId },
		{ error: args.error, errorClass: "StartFailed" },
	);
}

interface ActivePmStorySync {
	workflowId: string;
	direction: PmStorySyncDirection;
	startedAt: Date;
}

/** A RUNNING row whose heartbeat is older than this is treated as dead. */
function liveHeartbeatCutoff(): Date {
	return new Date(
		Date.now() - STALL_MINUTES_BY_SOURCE.backgroundJob * 60_000,
	);
}

function toActiveSync(row: {
	workflowId: string;
	sourceType: string | null;
	createdAt: Date;
}): ActivePmStorySync {
	return {
		workflowId: row.workflowId,
		direction:
			row.sourceType === SOURCE_BY_DIRECTION.push ? "push" : "pull",
		startedAt: row.createdAt,
	};
}

/**
 * The newest running sync whose heartbeat is inside the stall window. A row
 * past the window is treated as dead, so a crashed run never re-seeds polling
 * on every page load.
 */
export async function findActivePmStorySync(
	projectId: string,
): Promise<ActivePmStorySync | null> {
	const row = await db.backgroundJob.findFirst({
		where: {
			projectId,
			kind: "PM_STORY_SYNC",
			status: "RUNNING",
			heartbeatAt: { gte: liveHeartbeatCutoff() },
		},
		orderBy: { createdAt: "desc" },
		select: { workflowId: true, sourceType: true, createdAt: true },
	});
	return row ? toActiveSync(row) : null;
}
