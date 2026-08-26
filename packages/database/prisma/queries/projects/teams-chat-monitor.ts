/**
 * Database queries for ProjectLinkedTeamsChat and its seen-message dedup table.
 *
 * Mirrors `teams-channel-monitor.ts` 1:1, but anchored to a chatId rather than
 * a (teamId, channelId) tuple. Microsoft Teams group chats have no native
 * thread/reply hierarchy so each message is its own dedup unit.
 *
 * NOTE: These queries are called from Temporal activities which handle tenant
 * context separately, so tenant filtering is not applied here. API procedures
 * apply tenant filters before calling these functions.
 */

import { db } from "../../client";
import type { BackfillMode } from "./teams-channel-monitor";

// ---------------------------------------------------------------------------
// Chat linking (project settings)
// ---------------------------------------------------------------------------

/**
 * Link a Teams chat to a project. Idempotent on (projectId, chatId).
 *
 * When backfillMode is "from-now", lastMessageCreatedAt is seeded to now() so
 * the first poll tick only picks up messages posted after linking.
 */
export async function linkTeamsChatToProject(params: {
	projectId: string;
	chatId: string;
	chatTopic?: string;
	chatWebUrl?: string;
	backfillMode?: BackfillMode;
	userId?: string;
	organizationId?: string;
}) {
	const initialCursor =
		params.backfillMode === "from-now" ? new Date() : null;

	return await db.projectLinkedTeamsChat.upsert({
		where: {
			projectId_chatId: {
				projectId: params.projectId,
				chatId: params.chatId,
			},
		},
		create: {
			projectId: params.projectId,
			chatId: params.chatId,
			chatTopic: params.chatTopic,
			chatWebUrl: params.chatWebUrl,
			lastMessageCreatedAt: initialCursor,
			userId: params.userId,
			organizationId: params.organizationId,
		},
		update: {
			chatTopic: params.chatTopic,
			chatWebUrl: params.chatWebUrl,
		},
	});
}

/**
 * Unlink a Teams chat from a project. Cascade deletes seen-message markers.
 */
export async function unlinkTeamsChatFromProject(
	projectId: string,
	linkedChatId: string,
) {
	return await db.projectLinkedTeamsChat.delete({
		where: {
			id: linkedChatId,
			projectId,
		},
	});
}

/**
 * List linked Teams chats for a project, with seen-message counts + failure state.
 */
export async function getLinkedTeamsChats(projectId: string) {
	return await db.projectLinkedTeamsChat.findMany({
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
 * Minimal per-chat state used by the monitor workflow each tick.
 */
export async function getLinkedTeamsChatsForMonitor(projectId: string) {
	return await db.projectLinkedTeamsChat.findMany({
		where: { projectId },
		select: {
			id: true,
			chatId: true,
			chatTopic: true,
			chatWebUrl: true,
			lastMessageCreatedAt: true,
			lastMessageId: true,
			scanPageToken: true,
		},
	});
}

/**
 * Persist (or clear) the Graph @odata.nextLink resume token for a chat.
 */
export async function setTeamsChatScanPageToken(
	linkedChatId: string,
	token: string | null,
) {
	return await db.projectLinkedTeamsChat.update({
		where: { id: linkedChatId },
		data: { scanPageToken: token },
	});
}

// ---------------------------------------------------------------------------
// Cursor + failure state
// ---------------------------------------------------------------------------

export async function updateTeamsChatCursor(
	linkedChatId: string,
	cursor: { lastMessageCreatedAt: Date | null; lastMessageId: string | null },
) {
	return await db.projectLinkedTeamsChat.update({
		where: { id: linkedChatId },
		data: {
			lastMessageCreatedAt: cursor.lastMessageCreatedAt,
			lastMessageId: cursor.lastMessageId,
			consecutiveFailures: 0,
			lastErrorMessage: null,
			lastErrorAt: null,
		},
	});
}

export async function recordTeamsChatFailure(
	linkedChatId: string,
	errorMessage: string,
) {
	return await db.projectLinkedTeamsChat.update({
		where: { id: linkedChatId },
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
 * Insert seen-message markers for the given message IDs.
 * Idempotent — duplicates are skipped.
 */
export async function markTeamsChatMessagesAsSeen(
	linkedChatId: string,
	messageIds: string[],
	pendingProposalId?: string | null,
) {
	if (messageIds.length === 0) {
		return { count: 0 };
	}
	return await db.projectLinkedTeamsChatSeenMessage.createMany({
		data: messageIds.map((messageId) => ({
			linkedChatId,
			messageId,
			pendingProposalId: pendingProposalId ?? null,
		})),
		skipDuplicates: true,
	});
}

/**
 * Return the subset of candidate IDs that have already been seen (for pre-filtering).
 */
export async function getSeenChatMessageIds(
	linkedChatId: string,
	candidateMessageIds: string[],
): Promise<Set<string>> {
	if (candidateMessageIds.length === 0) {
		return new Set();
	}
	const rows = await db.projectLinkedTeamsChatSeenMessage.findMany({
		where: {
			linkedChatId,
			messageId: { in: candidateMessageIds },
		},
		select: { messageId: true },
	});
	return new Set(rows.map((r) => r.messageId));
}

// ---------------------------------------------------------------------------
// Project-level monitor state
// ---------------------------------------------------------------------------

export async function updateTeamsChatMonitorLastRun(projectId: string) {
	return await db.project.update({
		where: { id: projectId },
		data: {
			teamsChatMonitorLastRun: new Date(),
		},
	});
}

/**
 * Tenant + display context for a linked chat, for Job Hub rows written from
 * activities whose input carries only the linked-chat id (failure recording).
 *
 * The row's own tenant columns are nullable (rows linked before they were
 * introduced), so the owning project is joined as a fallback — a failure on a
 * legacy chat must still surface in the Job Hub.
 */
export async function getTeamsLinkedChatJobContext(linkedChatId: string) {
	const row = await db.projectLinkedTeamsChat.findUnique({
		where: { id: linkedChatId },
		select: {
			id: true,
			projectId: true,
			userId: true,
			organizationId: true,
			chatTopic: true,
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
		chatTopic: row.chatTopic,
	};
}
