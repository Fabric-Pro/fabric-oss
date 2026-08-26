/**
 * Database queries for ProjectLinkedTeamsChannel and its seen-message dedup table.
 *
 * NOTE: These queries are called from Temporal activities which handle tenant
 * context separately, so tenant filtering is not applied here. API procedures
 * apply tenant filters before calling these functions.
 */

import { db } from "../../client";

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
		where: { projectId },
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
 */
export async function markTeamsMessagesAsSeen(
	linkedChannelId: string,
	messageIds: string[],
	pendingProposalId?: string | null,
) {
	if (messageIds.length === 0) {
		return { count: 0 };
	}
	return await db.projectLinkedTeamsChannelSeenMessage.createMany({
		data: messageIds.map((messageId) => ({
			linkedChannelId,
			messageId,
			pendingProposalId: pendingProposalId ?? null,
		})),
		skipDuplicates: true,
	});
}

/**
 * Return the subset of candidate IDs that have already been seen (for pre-filtering).
 */
export async function getSeenMessageIds(
	linkedChannelId: string,
	candidateMessageIds: string[],
): Promise<Set<string>> {
	if (candidateMessageIds.length === 0) {
		return new Set();
	}
	const rows = await db.projectLinkedTeamsChannelSeenMessage.findMany({
		where: {
			linkedChannelId,
			messageId: { in: candidateMessageIds },
		},
		select: { messageId: true },
	});
	return new Set(rows.map((r) => r.messageId));
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
