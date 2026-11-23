import { db, recordAudit } from "@repo/database";
import type { ParlumeMeetingReplyChannel } from "@repo/database/prisma/generated/enums";
import { PARLUME_ACTOR_NAME } from "../lib/fabric-mcp-service-headers";
import { parlumeActivityLog } from "./parlume-log";

/** How the request was asked: aloud, typed in the meeting chat, or on the Parlume page. */
function requestSource(
	replyChannel: ParlumeMeetingReplyChannel,
): "spoken" | "typed" | "page" {
	switch (replyChannel) {
		case "VOICE":
			return "spoken";
		case "CHAT":
			return "typed";
		case "PAGE":
			return "page";
		default: {
			const unreachable: never = replyChannel;
			return unreachable;
		}
	}
}

/**
 * Records that Parlume answered a request asked in a meeting, reading project
 * data with the access of the participant who asked. A turn whose asker
 * Fabric could not place read nothing, so its row names no member. The
 * inviter is kept as `invitedBy`. The write that ended the turn calls it, and
 * only when that write changed the turn, so a turn has one row: the worker for
 * a turn that completed or failed, the interrupt route for a turn it stopped.
 * Never the question, the answer or a tool's arguments, which are meeting
 * content. Like `recordAudit` it never throws, so a failed lookup cannot undo
 * the end of the turn.
 */
export async function recordParlumeTurnAnswered(input: {
	turnId: string;
	status: "COMPLETED" | "FAILED" | "STOPPED";
	/** The tools the turn called, by name, when the worker saw them. */
	toolNames?: string[];
}): Promise<void> {
	try {
		const turn = await db.parlumeMeetingTurn.findUnique({
			where: { id: input.turnId },
			select: {
				sessionId: true,
				projectId: true,
				organizationId: true,
				replyChannel: true,
				userId: true,
				requesterUserId: true,
			},
		});
		if (!turn) {
			return;
		}
		const requester = turn.requesterUserId
			? await db.user.findUnique({
					where: { id: turn.requesterUserId },
					select: { email: true },
				})
			: null;
		recordAudit({
			action: "project.parlume.request_answered",
			category: "project",
			outcome: input.status === "COMPLETED" ? "success" : "failure",
			actor: {
				type: "agent",
				userId: turn.requesterUserId,
				nameSnapshot: PARLUME_ACTOR_NAME,
				emailSnapshot: requester?.email ?? null,
			},
			organizationId: turn.organizationId,
			projectId: turn.projectId,
			resource: { type: "parlume_meeting_turn", id: input.turnId },
			metadata: {
				status: input.status,
				sessionId: turn.sessionId,
				source: requestSource(turn.replyChannel),
				invitedBy: turn.userId,
				...(input.toolNames && { toolNames: input.toolNames }),
			},
		});
	} catch (error) {
		parlumeActivityLog("warn", "turn.audit_failed", {
			turnId: input.turnId,
			status: input.status,
			error:
				error instanceof Error
					? error.message.slice(0, 300)
					: "Unknown error",
		});
	}
}
