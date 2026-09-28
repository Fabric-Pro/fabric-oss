/**
 * Database queries for ProjectLinkedTeamsChannel and its seen-message dedup table.
 *
 * NOTE: These queries are called from Temporal activities which handle tenant
 * context separately, so tenant filtering is not applied here. API procedures
 * apply tenant filters before calling these functions.
 */

import { db } from "../../client";
import type { Prisma } from "../../generated/client";

// ---------------------------------------------------------------------------
// Channel linking (project settings)
// ---------------------------------------------------------------------------

export type BackfillMode = "from-now" | "latest-30";

/**
 * Link a Teams channel to a project. Idempotent on (projectId, teamId, channelId).
 *
 * When backfillMode is "from-now", lastMessageCreatedAt is seeded to now() so
 * the first poll tick only picks up messages posted after linking.
 */
export async function linkTeamsChannelToProject(params: {
	projectId: string;
	teamId: string;
	channelId: string;
	teamName?: string;
	channelName?: string;
	channelWebUrl?: string;
	backfillMode?: BackfillMode;
	userId?: string;
	organizationId?: string;
}) {
	const initialCursor =
		params.backfillMode === "from-now" ? new Date() : null;

	return await db.projectLinkedTeamsChannel.upsert({
		where: {
			projectId_teamId_channelId: {
				projectId: params.projectId,
				teamId: params.teamId,
				channelId: params.channelId,
			},
		},
		create: {
			projectId: params.projectId,
			teamId: params.teamId,
			channelId: params.channelId,
			teamName: params.teamName,
			channelName: params.channelName,
			channelWebUrl: params.channelWebUrl,
			lastMessageCreatedAt: initialCursor,
			userId: params.userId,
			organizationId: params.organizationId,
		},
		update: {
			teamName: params.teamName,
			channelName: params.channelName,
			channelWebUrl: params.channelWebUrl,
		},
	});
}

/**
 * Unlink a Teams channel from a project. Cascade deletes seen-message markers.
 */
export async function unlinkTeamsChannelFromProject(
	projectId: string,
	linkedChannelId: string,
) {
	return await db.projectLinkedTeamsChannel.delete({
		where: {
			id: linkedChannelId,
			projectId,
		},
	});
}

/**
 * List linked Teams channels for a project, with seen-thread counts + failure state.
 */
export async function getLinkedTeamsChannels(projectId: string) {
	return await db.projectLinkedTeamsChannel.findMany({
		where: { projectId },
		include: {
			_count: {
				select: { seenMessages: true },
			},
		},
		orderBy: { linkedAt: "desc" },
	});
}

/**
 * Minimal per-channel state used by the monitor workflow each tick.
 */
export async function getLinkedTeamsChannelsForMonitor(projectId: string) {
	return await db.projectLinkedTeamsChannel.findMany({
		// Paused conversations are excluded HERE and only here: this is the
		// monitor's own lookup, so filtering it is what makes pausing stop the
		// scanning without touching the row, its cursor, its seen-message
		// ledger or the context it already produced (Fizzy #2355).
		where: { projectId, deactivatedAt: null },
		select: {
			id: true,
			teamId: true,
			channelId: true,
			teamName: true,
			channelName: true,
			channelWebUrl: true,
			lastMessageCreatedAt: true,
			lastMessageId: true,
			scanPageToken: true,
		},
	});
}

/**
 * Stop scanning one linked channel without touching anything it has already
 * captured.
 *
 * Deliberately an `update` with a `projectId` guard rather than a bare update by
 * id: the id alone would let a caller in one project pause a channel linked to
 * another.
 */
export async function deactivateLinkedTeamsChannel(params: {
	projectId: string;
	linkedChannelId: string;
	userId: string;
}) {
	return await db.projectLinkedTeamsChannel.update({
		where: { id: params.linkedChannelId, projectId: params.projectId },
		data: {
			deactivatedAt: new Date(),
			deactivatedById: params.userId,
		},
	});
}

/** Resume scanning a previously paused channel. */
export async function reactivateLinkedTeamsChannel(params: {
	projectId: string;
	linkedChannelId: string;
}) {
	return await db.projectLinkedTeamsChannel.update({
		where: { id: params.linkedChannelId, projectId: params.projectId },
		data: {
			deactivatedAt: null,
			deactivatedById: null,
		},
	});
}

/**
 * Persist (or clear) the Graph @odata.nextLink resume token for a channel.
 * Used when the per-tick scan budget runs out before reaching unseen threads
 * so the next tick resumes pagination from that point instead of rescanning
 * the same already-seen window.
 */
export async function setTeamsChannelScanPageToken(
	linkedChannelId: string,
	token: string | null,
) {
	return await db.projectLinkedTeamsChannel.update({
		where: { id: linkedChannelId },
		data: { scanPageToken: token },
	});
}

// ---------------------------------------------------------------------------
// Cursor + failure state
// ---------------------------------------------------------------------------

export async function updateTeamsChannelCursor(
	linkedChannelId: string,
	cursor: { lastMessageCreatedAt: Date | null; lastMessageId: string | null },
) {
	return await db.projectLinkedTeamsChannel.update({
		where: { id: linkedChannelId },
		data: {
			lastMessageCreatedAt: cursor.lastMessageCreatedAt,
			lastMessageId: cursor.lastMessageId,
			consecutiveFailures: 0,
			lastErrorMessage: null,
			lastErrorAt: null,
		},
	});
}

/**
 * Clear a channel's failure state after a tick that succeeded without moving
 * the cursor.
 *
 * `updateTeamsChannelCursor` already resets these, but the workflow only calls
 * it when the tick found new threads — so a channel that recovers while quiet
 * kept its banner and its "please re-link this channel" prompt forever
 * (Fizzy #2311). Recovery is a property of the tick succeeding, not of the
 * cursor moving.
 */
export async function clearTeamsChannelFailureState(linkedChannelId: string) {
	return await db.projectLinkedTeamsChannel.update({
		where: { id: linkedChannelId },
		data: {
			consecutiveFailures: 0,
			lastErrorMessage: null,
			lastErrorAt: null,
		},
	});
}

export async function recordTeamsChannelFailure(
	linkedChannelId: string,
	errorMessage: string,
) {
	return await db.projectLinkedTeamsChannel.update({
		where: { id: linkedChannelId },
		data: {
			consecutiveFailures: { increment: 1 },
			lastErrorMessage: errorMessage.slice(0, 4000),
			lastErrorAt: new Date(),
		},
	});
}

// ---------------------------------------------------------------------------
// Seen-message dedup
// ---------------------------------------------------------------------------

/**
 * Insert seen-thread markers for the given root message IDs.
 * Idempotent — duplicates are skipped.
 *
 * `analyzedThroughAt` is the thread's Graph `threadLastActivity` as of this
 * analysis; it is written on insert only. An existing row keeps its value —
 * moving a watermark forward is `advanceTeamsThreadWatermark`'s job. Because
 * this never overwrites a row, a NULL `analyzedThroughAt` can only ever be the
 * value a row was inserted with, never a value written over an advanced one.
 */
export async function markTeamsMessagesAsSeen(
	linkedChannelId: string,
	messageIds: string[],
	pendingProposalId?: string | null,
	analyzedThroughAt?: Date | null,
) {
	if (messageIds.length === 0) {
		return { count: 0 };
	}
	return await db.projectLinkedTeamsChannelSeenMessage.createMany({
		data: messageIds.map((messageId) => ({
			linkedChannelId,
			messageId,
			pendingProposalId: pendingProposalId ?? null,
			analyzedThroughAt: analyzedThroughAt ?? null,
		})),
		skipDuplicates: true,
	});
}

/**
 * Effective watermark for each already-seen thread root among the candidates:
 * `analyzedThroughAt` when set, otherwise the row's `createdAt`.
 *
 * NULL rows were written before the column existed, or by a not-yet-upgraded
 * worker during a rollout. A NULL row does not record what its analysis
 * observed, so no boundary derived from the row alone is exact; `createdAt`
 * is the one that can never re-propose or mass re-analyze, because every
 * reply the old analyzer saw predates the row it inserted afterwards.
 *
 * Documented legacy limit: a reply that arrived while such a row's original
 * analysis was running (after its fetch, before its insert) is older than
 * `createdAt` and stays unanalyzed — exactly as before this column existed,
 * so it is not a regression. It applies only to legacy rows; a row written
 * with `analyzedThroughAt` records the thread's `threadLastActivity` and so
 * catches such replies on the next pass.
 *
 * Roots with no seen row are absent from the map (never analyzed).
 */
export async function getSeenThreadWatermarks(
	linkedChannelId: string,
	rootIds: string[],
): Promise<Map<string, Date>> {
	if (rootIds.length === 0) {
		return new Map();
	}
	const rows = await db.projectLinkedTeamsChannelSeenMessage.findMany({
		where: {
			linkedChannelId,
			messageId: { in: rootIds },
		},
		select: { messageId: true, analyzedThroughAt: true, createdAt: true },
	});
	return new Map(
		rows.map((row) => [
			row.messageId,
			row.analyzedThroughAt ?? row.createdAt,
		]),
	);
}

/**
 * Compare-and-swap one thread's watermark from `expectedPrevious` (the value
 * `getSeenThreadWatermarks` returned when the thread was fetched) to `next`.
 *
 * Matches only while the row still holds what the caller read: either
 * `analyzedThroughAt = expectedPrevious`, or a still-NULL `analyzedThroughAt`
 * (a legacy row, whose `expectedPrevious` was its `createdAt` fallback). The
 * NULL arm deliberately has no `createdAt` comparison: it is not needed, since
 * the fetch only sends a revisit when a reply is strictly newer than the
 * effective watermark and `next > expectedPrevious` is enforced below, so
 * there is no way for it to loop. It is still a CAS: NULL is only ever
 * written on insert and never over an advanced value, so the NULL arm cannot
 * match a row another revisit already moved.
 *
 * Two overlapping runs that both read the same watermark therefore cannot
 * both advance it: the first to commit wins, the other matches nothing. Any
 * reply newer than the winner's `next` is still newer on the next tick, so it
 * is revisited then rather than lost.
 *
 * `next` must be strictly later than `expectedPrevious` (the fetch activity
 * only sends a revisit when a reply is newer than the watermark it read);
 * otherwise nothing is written and 0 is returned. Pass a transaction client to
 * use this as the idempotency fence for a write that must commit with it.
 *
 * Returns the number of rows updated (0 or 1).
 */
export async function advanceTeamsThreadWatermark(
	linkedChannelId: string,
	rootId: string,
	expectedPrevious: Date,
	next: Date,
	client: Prisma.TransactionClient = db,
): Promise<number> {
	if (!(next.getTime() > expectedPrevious.getTime())) {
		return 0;
	}
	const result = await client.projectLinkedTeamsChannelSeenMessage.updateMany(
		{
			where: {
				linkedChannelId,
				messageId: rootId,
				OR: [
					{ analyzedThroughAt: expectedPrevious },
					{ analyzedThroughAt: null },
				],
			},
			data: { analyzedThroughAt: next },
		},
	);
	return result.count;
}

// ---------------------------------------------------------------------------
// Project-level monitor state
// ---------------------------------------------------------------------------

export async function updateTeamsChannelMonitorLastRun(projectId: string) {
	return await db.project.update({
		where: { id: projectId },
		data: {
			teamsChannelMonitorLastRun: new Date(),
		},
	});
}

/**
 * Tenant + display context for a linked channel, for Job Hub rows written from
 * activities whose input carries only the linked-channel id (failure recording).
 *
 * The row's own tenant columns are nullable (rows linked before they were
 * introduced), so the owning project is joined as a fallback — a failure on a
 * legacy channel must still surface in the Job Hub.
 */
export async function getTeamsLinkedChannelJobContext(linkedChannelId: string) {
	const row = await db.projectLinkedTeamsChannel.findUnique({
		where: { id: linkedChannelId },
		select: {
			id: true,
			projectId: true,
			userId: true,
			organizationId: true,
			teamName: true,
			channelName: true,
			project: { select: { userId: true, organizationId: true } },
		},
	});
	if (!row) {
		return null;
	}
	return {
		id: row.id,
		projectId: row.projectId,
		userId: row.userId ?? row.project.userId,
		organizationId: row.organizationId ?? row.project.organizationId,
		teamName: row.teamName,
		channelName: row.channelName,
	};
}
