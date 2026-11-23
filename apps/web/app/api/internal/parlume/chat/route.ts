import {
	isParlumeChannelChatSession,
	sendParlumeMeetingChat,
} from "@repo/api/modules/projects/lib/parlume-attendee";
import {
	ParlumeChannelPostOutcomeUnknownError,
	sendParlumeChannelPost,
} from "@repo/api/modules/projects/lib/parlume-channel-chat";
import {
	recordParlumeChatTag,
	recordParlumeRecapTag,
} from "@repo/api/modules/projects/lib/parlume-chat-tags";
import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import { resolveParlumeAttendeeSettings } from "@repo/api/modules/projects/lib/parlume-provider-settings";
import { db } from "@repo/database";
import type { ParlumeMeetingTurnStatus } from "@repo/database/prisma/zod";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isParlumeServiceRequestAuthorized } from "../lib";

const bodySchema = z.object({
	sessionId: z.string().min(1).max(128),
	botId: z.string().min(1).max(256),
	message: z.string().trim().min(1).max(4_096),
	/** A suggestion or the recap, which keep their one-paragraph form. */
	plain: z.boolean().optional(),
	/** The recap, whose tag the Parlume page shows once it is sent. */
	recap: z.boolean().optional(),
	/** The request a post belongs to; it goes out only while that runs. */
	turnId: z.string().min(1).max(128).optional(),
	/** The post says that request failed. */
	turnFailed: z.boolean().optional(),
});

/**
 * Whether a request's post may still go out. A request someone stopped posts
 * nothing more, whatever was being prepared for it; a failed one posts only
 * the line that says it failed. A completed one keeps its posts: the realtime
 * voice's answer and its rest go out after the turn is recorded.
 */
function turnMayPost(status: ParlumeMeetingTurnStatus, failed: boolean) {
	switch (status) {
		case "PENDING":
		case "RUNNING":
		case "COMPLETED":
			return !failed;
		case "FAILED":
			return failed;
		case "STOPPED":
			return false;
		default: {
			const unreachable: never = status;
			return unreachable;
		}
	}
}

/**
 * Records a sent recap's tag. The post is already out, so a failure here is
 * logged, never answered as a failed post the bridge would send again.
 */
async function recordRecapTag(sessionId: string, message: string) {
	try {
		await recordParlumeRecapTag(sessionId, message);
	} catch (error) {
		parlumeLog("warn", "chat.recap_tag_failed", {
			sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Sends a Parlume post to the meeting chat. Called by the bridge, which tags
 * each post and confirms delivery when the post shows up in the chat; only an
 * active session's own bot may send. Graph channel replies are read back before
 * acceptance; Attendee's response confirms only that the message was queued.
 * A channel post that failed after Graph may have created it is answered with
 * `outcome: "unknown"`, so the bridge keeps it as possibly in the thread.
 */
export async function POST(request: NextRequest) {
	if (
		!isParlumeServiceRequestAuthorized(
			request.headers.get("X-Agent-Service-Token"),
		)
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const parsed = bodySchema.safeParse(await request.json());
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: parsed.data.sessionId,
			providerBotId: parsed.data.botId,
			status: "ACTIVE",
		},
		select: {
			id: true,
			providerBotId: true,
			organizationId: true,
			channelChatStatus: true,
			channelChatError: true,
			channelId: true,
			channelRootMessageId: true,
		},
	});
	if (!session?.providerBotId) {
		return NextResponse.json(
			{ error: "Session not active" },
			{ status: 409 },
		);
	}
	const { turnId } = parsed.data;
	if (turnId) {
		const turn = await db.parlumeMeetingTurn.findFirst({
			where: { id: turnId, sessionId: session.id },
			select: { status: true },
		});
		if (
			!turn ||
			!turnMayPost(turn.status, parsed.data.turnFailed === true)
		) {
			parlumeLog("info", "chat.turn_ended", {
				sessionId: session.id,
				turnId,
				status: turn?.status ?? null,
			});
			return NextResponse.json(
				{ error: "Request no longer running" },
				{ status: 409 },
			);
		}
	}
	await recordParlumeChatTag(session.id, parsed.data.message);
	if (isParlumeChannelChatSession(session)) {
		if (session.channelChatStatus !== "READY") {
			return NextResponse.json(
				{
					error:
						session.channelChatError ??
						"Channel chat is not ready.",
				},
				{ status: 409 },
			);
		}
		try {
			await sendParlumeChannelPost(
				session.id,
				parsed.data.message,
				parsed.data.plain === true,
			);
		} catch (error) {
			return NextResponse.json(
				{
					error: "Channel chat delivery could not be confirmed. Check the meeting thread before retrying.",
					outcome:
						error instanceof ParlumeChannelPostOutcomeUnknownError
							? "unknown"
							: "not_sent",
				},
				{ status: 502 },
			);
		}
		if (parsed.data.recap) {
			await recordRecapTag(session.id, parsed.data.message);
		}
		return NextResponse.json({ sent: true, delivery: "observed" });
	}
	const attendee = await resolveParlumeAttendeeSettings(
		session.organizationId,
	);
	if (!attendee) {
		return NextResponse.json({ error: "Unavailable" }, { status: 503 });
	}
	try {
		await sendParlumeMeetingChat({
			attendee,
			providerBotId: session.providerBotId,
			message: parsed.data.message,
			plain: parsed.data.plain,
		});
	} catch (error) {
		parlumeLog("warn", "chat.failed", {
			sessionId: session.id,
			botId: session.providerBotId,
			error: error instanceof Error ? error.message : String(error),
		});
		return NextResponse.json(
			{ error: "Chat delivery failed" },
			{ status: 502 },
		);
	}
	if (parsed.data.recap) {
		await recordRecapTag(session.id, parsed.data.message);
	}
	parlumeLog("info", "chat.posted", {
		sessionId: session.id,
		botId: session.providerBotId,
		chars: parsed.data.message.length,
		delivery: "queued",
	});
	return NextResponse.json({ sent: true, delivery: "queued" });
}
