import { db } from "@repo/database";
import type { ParlumeMeetingEndReason } from "@repo/database/prisma/generated/enums";
import {
	getParlumeBridgeSettings,
	isParlumeChannelChatSession,
	leaveParlumeMeetingBot,
	noteParlumeLeaving,
	PARLUME_IN_CALL_WAIT_MS,
	type ParlumeAttendeeSettings,
	type ParlumeMeetingBotLeaveResult,
	sendParlumeMeetingChat,
	waitForParlumeBotInCall,
} from "./parlume-attendee";
import { parlumeLog } from "./parlume-log";
import { resolveParlumeAttendeeSettingsForSession } from "./parlume-provider-settings";

/**
 * Has the bridge tell the meeting chat that this session's posts can no
 * longer be played, after `notice` when there is one. Called while the
 * session is still ACTIVE: the chat route posts only for an active session.
 * Why the meeting did not get `notice`, or the bridge could not be reached;
 * null when neither went wrong. `known` is false when the bridge did not
 * answer, so it may still have posted.
 */
async function bridgeLeavingFailure(
	sessionId: string,
	notice?: string,
): Promise<{ error: string; known: boolean } | null> {
	try {
		const settings = getParlumeBridgeSettings();
		if (!settings) {
			return notice
				? { error: "No media bridge is configured.", known: true }
				: null;
		}
		const noticed = await noteParlumeLeaving({
			settings,
			sessionId,
			...(notice ? { notice } : {}),
		});
		return notice && !noticed
			? { error: "The bridge could not post the notice.", known: true }
			: null;
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : String(error),
			known: false,
		};
	}
}

/**
 * How long a bot is in the call before its chat posts show. The join notice,
 * posted 11 to 15 seconds after the stream is verified, showed in every
 * staging session; a notice posted 1.4 seconds after the stream was verified,
 * and one posted as the bot came into the call, never did, although Attendee
 * took both.
 */
export const PARLUME_CHAT_SETTLE_MS = 15_000;

/**
 * The meeting chat has not shown Parlume's join notice yet: the bot has only
 * just come into the call, or not yet. A post the bridge made now would be
 * lost, so the notice is posted later, through Attendee. A channel thread
 * that is open takes the bridge's posts from the start.
 */
async function findSessionBeforeChat(sessionId: string) {
	const session = await db.parlumeMeetingSession.findFirst({
		where: { id: sessionId, joinNoticeAt: null },
		select: {
			joinedAt: true,
			channelId: true,
			channelRootMessageId: true,
			channelChatStatus: true,
		},
	});
	return session &&
		!(session.joinedAt && isParlumeChannelChatSession(session))
		? session
		: null;
}

/**
 * Before Fabric has the bot leave a meeting it is still in, the bridge tells
 * the meeting chat that this session's posts can no longer be played. Best
 * effort: the leave goes ahead whatever happens here.
 */
export async function announceParlumeLeaving(sessionId: string): Promise<void> {
	const failure = await bridgeLeavingFailure(sessionId);
	if (failure) {
		parlumeLog("warn", "leave.notice_failed", {
			sessionId,
			error: failure.error,
		});
	}
}

/**
 * The notice of a session leaving before the meeting chat showed its join
 * notice. The leave is claimed first, so the chat route takes no post: it
 * goes to the meeting chat through Attendee. Attendee takes a chat message
 * only once the bot is in the call, so the leave waits for that, bounded by
 * {@link PARLUME_IN_CALL_WAIT_MS}, and then until the bot has been in the
 * call for {@link PARLUME_CHAT_SETTLE_MS}. A channel thread opens only once
 * the stream is verified, so there the notice cannot be given.
 */
async function postNoticeBeforeChat(input: {
	attendee: ParlumeAttendeeSettings;
	session: Parameters<typeof isParlumeChannelChatSession>[0] & {
		id: string;
		providerBotId: string;
		joinedAt: Date | null;
	};
	notice: string;
}): Promise<void> {
	const meta = {
		sessionId: input.session.id,
		botId: input.session.providerBotId,
	};
	if (isParlumeChannelChatSession(input.session)) {
		parlumeLog("warn", "leave.notice_failed", {
			...meta,
			error: "The channel chat opens only once the meeting stream is verified.",
		});
		return;
	}
	const inCall = await waitForParlumeBotInCall({
		attendee: input.attendee,
		providerBotId: input.session.providerBotId,
	});
	if (inCall !== "in_call") {
		parlumeLog("warn", "leave.notice_failed", {
			...meta,
			error:
				inCall === "gone"
					? "The bot left the meeting before it could post the notice."
					: `The bot was not in the call within ${PARLUME_IN_CALL_WAIT_MS / 1_000} seconds, so it could not post the notice.`,
		});
		return;
	}
	// The stream is verified as the bot comes into the call; one that was
	// not yet came in at most a poll ago.
	const inCallAt = input.session.joinedAt?.getTime() ?? Date.now();
	const settle = inCallAt + PARLUME_CHAT_SETTLE_MS - Date.now();
	if (settle > 0) {
		await new Promise((resolve) => setTimeout(resolve, settle));
	}
	try {
		await sendParlumeMeetingChat({
			attendee: input.attendee,
			providerBotId: input.session.providerBotId,
			message: input.notice,
			plain: true,
		});
		parlumeLog("info", "leave.notice_posted", { ...meta, via: "attendee" });
	} catch (error) {
		parlumeLog("warn", "leave.notice_failed", {
			...meta,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

const leavableStatuses = [
	"JOINING",
	"ACTIVE",
	"LEAVING",
	"STOP_FAILED",
] as const;

/**
 * How long a session whose chat has not shown the join notice stays with the
 * request that claimed its early notice: that request waits for the bot to be
 * in the call and for its chat to settle, posts the notice, then has it
 * leave. Its Attendee calls get the margin.
 */
const EARLY_NOTICE_HOLD_MS =
	PARLUME_IN_CALL_WAIT_MS + PARLUME_CHAT_SETTLE_MS + 30_000;

/**
 * Fabric decided the meeting is over (idle, access revoked, stream failure):
 * record why, then ask the provider to leave. The terminal callback and the
 * stream close still finalize the session; on a provider error the session
 * stays STOP_FAILED for the bridge watchdog to retry.
 */
export async function requestParlumeLeave(input: {
	session: {
		id: string;
		providerBotId: string;
		streamGeneration: number;
	};
	reason: ParlumeMeetingEndReason;
	lastError: string | null;
	captureStopped: boolean;
	/** Why Parlume is leaving, posted in the meeting chat first. */
	notice?: string;
}): Promise<ParlumeMeetingBotLeaveResult | null> {
	// Someone Parlume cannot confirm was in the meeting as the bot came in:
	// the notice goes out through Attendee once this call has claimed the
	// leave and the bot's chat has settled, not through the bridge now.
	const early = input.notice
		? await findSessionBeforeChat(input.session.id)
		: null;
	const failure = await bridgeLeavingFailure(
		input.session.id,
		early ? undefined : input.notice,
	);
	const noticeFailed = (error: string) =>
		parlumeLog("warn", "leave.notice_failed", {
			sessionId: input.session.id,
			error,
		});
	if (failure) {
		noticeFailed(failure.error);
	}
	const now = new Date();
	const where = {
		id: input.session.id,
		streamGeneration: input.session.streamGeneration,
		status: { in: [...leavableStatuses] },
		finalizedAt: null,
	};
	const data = {
		status: "LEAVING" as const,
		endReason: input.reason,
		leaveRequestedAt: now,
		...(input.lastError === null ? {} : { lastError: input.lastError }),
		...(input.captureStopped ? { captureStoppedAt: now } : {}),
	};
	// Only the first request to leave gives the early notice: a retry, or a
	// request at the same time, finds the leave already requested.
	const first = early
		? await db.parlumeMeetingSession.updateMany({
				where: { ...where, leaveRequestedAt: null },
				data,
			})
		: null;
	// Nor does it have the bot leave while the request that claimed the
	// notice waits to post it: a leave now would leave the meeting with no
	// explanation. The bridge's access check asks for one once the welcome is
	// due, 15 seconds after the stream is verified. A leave that failed
	// (STOP_FAILED) can be retried at once.
	const claimed = first?.count
		? first
		: await db.parlumeMeetingSession.updateMany({
				where: {
					...where,
					OR: [
						{ status: { not: "LEAVING" } },
						{ joinNoticeAt: { not: null } },
						{ leaveRequestedAt: null },
						{
							leaveRequestedAt: {
								lte: new Date(
									now.getTime() - EARLY_NOTICE_HOLD_MS,
								),
							},
						},
					],
				},
				data,
			});
	if (early && !first?.count) {
		// Another participant's check, or a retry: the request that claimed
		// the leave posts the notice.
		parlumeLog("info", "leave.notice_claimed_elsewhere", {
			sessionId: input.session.id,
		});
	}
	if (claimed.count === 0) {
		return null;
	}
	// The early notice this call claimed, until it is posted.
	let owed = Boolean(early && first?.count);
	try {
		const attendee = await resolveParlumeAttendeeSettingsForSession(
			input.session.id,
		);
		if (!attendee) {
			throw new Error("Parlume provider configuration is unavailable.");
		}
		if (early && owed && input.notice) {
			owed = false;
			await postNoticeBeforeChat({
				attendee,
				session: { ...early, ...input.session },
				notice: input.notice,
			});
		}
		const result = await leaveParlumeMeetingBot({
			attendee,
			providerBotId: input.session.providerBotId,
		});
		parlumeLog("info", "leave.requested", {
			sessionId: input.session.id,
			botId: input.session.providerBotId,
			reason: input.reason,
			result: result.kind,
		});
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (owed) {
			noticeFailed(message);
		}
		await db.parlumeMeetingSession.updateMany({
			where: { id: input.session.id, status: "LEAVING" },
			data: { status: "STOP_FAILED" },
		});
		parlumeLog("error", "leave.failed", {
			sessionId: input.session.id,
			botId: input.session.providerBotId,
			reason: input.reason,
			error: message,
		});
		throw error;
	}
}
