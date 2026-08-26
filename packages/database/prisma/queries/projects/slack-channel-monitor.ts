/**
 * Database queries for ProjectLinkedSlackChannel and its seen-message dedup table.
 *
 * NOTE: These queries are called from Temporal activities which handle tenant
 * context separately, so tenant filtering is not applied here. API procedures
 * apply tenant filters before calling these functions.
 *
 * Mirrors `teams-channel-monitor.ts`. Differences from Teams:
 *  - cursor is a string (Slack `ts`, "seconds.microseconds") rather than a Date
 *  - no `scanPageToken` — Slack ingestion is signal-driven (events) rather
 *    than poll-driven, so the backfill activity tracks its own cursor via
 *    Temporal heartbeats.
 */

import { db } from "../../client";

// ---------------------------------------------------------------------------
// Channel linking (project settings)
// ---------------------------------------------------------------------------

export async function linkSlackChannelToProject(params: {
	projectId: string;
	slackTeamId: string;
	channelId: string;
	channelName?: string;
	teamName?: string;
	channelWebUrl?: string;
	monitorEnabled?: boolean;
	userId?: string;
	organizationId?: string;
}) {
	return await db.projectLinkedSlackChannel.upsert({
		where: {
			projectId_slackTeamId_channelId: {
				projectId: params.projectId,
				slackTeamId: params.slackTeamId,
				channelId: params.channelId,
			},
		},
		create: {
			projectId: params.projectId,
			slackTeamId: params.slackTeamId,
			channelId: params.channelId,
			channelName: params.channelName,
			teamName: params.teamName,
			channelWebUrl: params.channelWebUrl,
			monitorEnabled: params.monitorEnabled ?? false,
			monitorEnabledAt: params.monitorEnabled ? new Date() : null,
			userId: params.userId,
			organizationId: params.organizationId,
		},
		update: {
			channelName: params.channelName,
			teamName: params.teamName,
			channelWebUrl: params.channelWebUrl,
		},
	});
}

export async function unlinkSlackChannelFromProject(
	projectId: string,
	linkedChannelId: string,
) {
	return await db.projectLinkedSlackChannel.delete({
		where: {
			id: linkedChannelId,
			projectId,
		},
	});
}

export async function getLinkedSlackChannels(projectId: string) {
	return await db.projectLinkedSlackChannel.findMany({
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
 * Minimal per-channel state used by the monitor workflow for backfill kick-off
 * and webhook-fanout lookups. Re-read at workflow start (or backfill activity
 * start) so add/remove channel ops propagate.
 */
export async function getLinkedSlackChannelsForMonitor(projectId: string) {
	return await db.projectLinkedSlackChannel.findMany({
		where: { projectId, monitorEnabled: true },
		select: {
			id: true,
			slackTeamId: true,
			channelId: true,
			channelName: true,
			teamName: true,
			channelWebUrl: true,
			monitorEnabledAt: true,
			backfillCompleteAt: true,
			lastMessageTs: true,
		},
	});
}

// ---------------------------------------------------------------------------
// Cursor + failure state (mirror of Teams's helpers)
// ---------------------------------------------------------------------------

export async function updateSlackChannelCursor(
	linkedChannelId: string,
	cursor: { lastMessageTs: string | null },
) {
	return await db.projectLinkedSlackChannel.update({
		where: { id: linkedChannelId },
		data: {
			lastMessageTs: cursor.lastMessageTs,
			consecutiveFailures: 0,
			lastErrorMessage: null,
			lastErrorAt: null,
		},
	});
}

export async function markSlackChannelBackfillComplete(
	linkedChannelId: string,
	lastMessageTs: string | null,
) {
	return await db.projectLinkedSlackChannel.update({
		where: { id: linkedChannelId },
		data: {
			backfillCompleteAt: new Date(),
			lastMessageTs,
			consecutiveFailures: 0,
			lastErrorMessage: null,
			lastErrorAt: null,
		},
	});
}

export async function recordSlackChannelFailure(
	linkedChannelId: string,
	errorMessage: string,
) {
	return await db.projectLinkedSlackChannel.update({
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
 * Try to claim a Slack thread root for analysis via INSERT-as-lock. Returns
 * `true` when the row was newly inserted (we now own the analysis) and
 * `false` when another worker already claimed it (skip the LLM call).
 *
 * Slack `ts` is a zero-padded "seconds.microseconds" string; it's unique
 * within a channel and sorts lexicographically by chronological order.
 */
export async function claimSlackMessageForAnalysis(
	linkedChannelId: string,
	messageTs: string,
): Promise<boolean> {
	const result = await db.projectLinkedSlackChannelSeenMessage.createMany({
		data: [{ linkedChannelId, messageTs, pendingProposalId: null }],
		skipDuplicates: true,
	});
	return result.count === 1;
}

/**
 * Attach a `pendingProposalId` to a previously-claimed seen-message row. Used
 * after a successful LLM extraction so the inbox UI can deep-link back to the
 * source thread.
 */
export async function attachProposalToSeenSlackMessage(
	linkedChannelId: string,
	messageTs: string,
	pendingProposalId: string,
) {
	return await db.projectLinkedSlackChannelSeenMessage.updateMany({
		where: { linkedChannelId, messageTs },
		data: { pendingProposalId },
	});
}

export async function getSeenSlackMessageTimestamps(
	linkedChannelId: string,
	candidateTimestamps: string[],
): Promise<Set<string>> {
	if (candidateTimestamps.length === 0) {
		return new Set();
	}
	const rows = await db.projectLinkedSlackChannelSeenMessage.findMany({
		where: {
			linkedChannelId,
			messageTs: { in: candidateTimestamps },
		},
		select: { messageTs: true },
	});
	return new Set(rows.map((r) => r.messageTs));
}

// ---------------------------------------------------------------------------
// Project-level monitor state
// ---------------------------------------------------------------------------

export async function updateSlackChannelMonitorLastRun(projectId: string) {
	return await db.project.update({
		where: { id: projectId },
		data: {
			slackChannelMonitorLastRun: new Date(),
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
export async function getSlackLinkedChannelJobContext(linkedChannelId: string) {
	const row = await db.projectLinkedSlackChannel.findUnique({
		where: { id: linkedChannelId },
		select: {
			id: true,
			projectId: true,
			userId: true,
			organizationId: true,
			channelName: true,
			teamName: true,
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
		channelName: row.channelName,
		teamName: row.teamName,
	};
}
