/**
 * Agent-reply-ready notification dispatch.
 *
 * Mirrors `fanOut.agentReplyReady` in `@repo/api/lib/notification-service`, but
 * lives in `@repo/database` so it can be invoked from `@repo/temporal`
 * activities (`@repo/api` depends on `@repo/temporal`, so the activity cannot
 * import the API-side helper without a circular dependency).
 *
 * Keep this in lock-step with `fanOut.agentReplyReady`:
 * - same payload shape (`AGENT_REPLY_READY` schema in `payloads.ts`)
 * - same dedupe key: `agentReply:${runId}`
 * - same title/snippet/link conventions
 */
import { db } from "../client";
import {
	getNotificationPreferences,
	isCategoryEnabled,
} from "./notification-preferences";

const SNIPPET_MAX_LENGTH = 140;

function collapseWhitespace(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

export type CreateAgentReplyReadyNotificationArgs = {
	/**
	 * Stable identifier for the run / chat reply. Used as the dedupe key so
	 * completion firing twice (e.g. workflow replay or late save) produces at
	 * most one unread row.
	 */
	runId: string;
	/** Initiating user of the run — the single recipient. */
	recipientUserId: string;
	organizationId: string | null;
	agentName: string;
	/** Full final assistant message; truncated + whitespace-collapsed here. */
	finalMessage: string;
	link: string;
	projectId: string;
	storyId?: string;
	taskId?: string;
};

/**
 * Write one AGENT_REPLY_READY notification for the run's initiating user.
 *
 * - Never throws — failures are swallowed so the calling activity (and the
 *   agent run) is not blocked by notification dispatch.
 * - Uses the live-unread partial-unique index for dedupe; ignores P2002.
 *
 * Presence suppression is intentionally NOT implemented here: this helper is
 * invoked from a Temporal activity that has no direct access to a chat-focus
 * presence signal. The API-side `fanOut.agentReplyReady` accepts an
 * `isUserPresent` callback for in-process callers that do have it.
 *
 * If a presence channel is later wired into the Temporal worker (e.g. via a
 * Redis-backed signal), gate the body of this function on it.
 */
export async function createAgentReplyReadyNotifications(
	args: CreateAgentReplyReadyNotificationArgs,
): Promise<void> {
	if (!args.recipientUserId) {
		return;
	}

	// Write-time preference filter (Notification Center Preferences, AC-4):
	// skip when the recipient disabled the AI/Agent category (AGENT →
	// `aiAgent` toggle). Default-on when no preference row exists.
	const flags = await getNotificationPreferences(args.recipientUserId);
	if (!isCategoryEnabled(flags, "AGENT")) {
		return;
	}

	const snippet = collapseWhitespace(args.finalMessage).slice(
		0,
		SNIPPET_MAX_LENGTH,
	);
	const title = `${args.agentName} finished a reply`;
	const dedupeKey = `agentReply:${args.runId}`;
	const payload = {
		projectId: args.projectId,
		storyId: args.storyId,
		taskId: args.taskId,
		commentId: args.runId,
		snippet,
	};

	try {
		await db.notification.create({
			data: {
				userId: args.recipientUserId,
				organizationId: args.organizationId,
				type: "AGENT_REPLY_READY",
				category: "AGENT",
				title,
				snippet,
				link: args.link,
				projectId: args.projectId,
				storyId: args.storyId,
				taskId: args.taskId,
				payload,
				dedupeKey,
			},
		});
	} catch (error) {
		// Coalesce on dedupe-key collision; swallow other errors so the
		// calling activity is never blocked by notification writes.
		const code = (error as { code?: string } | null)?.code;
		if (code === "P2002") {
			return;
		}
		// Intentionally silent: notification dispatch is best-effort.
	}
}
