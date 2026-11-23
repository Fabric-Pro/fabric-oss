import {
	db,
	getDeliveryPreferences,
	NotificationCategory,
	NotificationType,
} from "@repo/database";
import type { ParlumeMeetingEndReason } from "@repo/database/prisma/generated/enums";
import { sendEmail } from "@repo/mail";
import { toAbsoluteUrl } from "@repo/utils";
import { PARLUME_BOT_NAME } from "@repo/utils/parlume-notes";
import {
	type CreateNotificationArgs,
	createNotification,
} from "../../../lib/notification-service";
import { PARLUME_LOBBY_WAIT_SECONDS } from "./parlume-lobby";
import { parlumeLog } from "./parlume-log";

/**
 * What Parlume tells the person a session runs for, the inviter or, for an
 * automatic join, whoever turned auto-join on, while the bot is not in the
 * meeting: that it waits in the lobby, or that it could not join. Each is an
 * in-app notification and an email, sent once per session. The email goes out
 * here unless the person's email channel is on, which already mails every
 * notification. Titles and email subjects are fixed text; the meeting's
 * calendar subject goes only in the snippet and the email body.
 *
 * Best effort: a notice that cannot be sent is logged, and never fails the
 * webhook or the start that asked for it.
 */

type ParlumeJoinFailure = Extract<
	ParlumeMeetingEndReason,
	"START_FAILED" | "NOT_ADMITTED"
>;

function isParlumeJoinFailure(
	reason: ParlumeMeetingEndReason | null,
): reason is ParlumeJoinFailure {
	return reason === "START_FAILED" || reason === "NOT_ADMITTED";
}

function joinFailureTitle(reason: ParlumeJoinFailure): string {
	switch (reason) {
		case "START_FAILED":
			return "Parlume could not join your meeting";
		case "NOT_ADMITTED":
			return "Parlume was not admitted to your meeting";
		default: {
			const unreachable: never = reason;
			return unreachable;
		}
	}
}

const noticeSessionSelect = {
	id: true,
	projectId: true,
	organizationId: true,
	userId: true,
	trigger: true,
	endReason: true,
	lastError: true,
	createdAt: true,
	linkedMeeting: { select: { subject: true } },
	organization: { select: { slug: true } },
	user: { select: { email: true, timezone: true } },
} as const;

function parlumePageUrl(session: {
	projectId: string;
	organization: { slug: string | null };
}): string {
	const base = session.organization.slug
		? `/app/${session.organization.slug}`
		: "/app";
	return toAbsoluteUrl(`${base}/projects/${session.projectId}/parlume`);
}

/** Writes the in-app row; true only for a new row, so its email goes once. */
async function writeNotice(args: CreateNotificationArgs): Promise<boolean> {
	const result = await createNotification(args);
	return result !== null && !("skipped" in result);
}

async function emailChannelOn(userId: string): Promise<boolean> {
	return (await getDeliveryPreferences(userId)).emailEnabled;
}

/**
 * A time of day in the recipient's time zone, with the zone's short name:
 * "14:10 UTC". A recipient without a time zone, or with one the runtime does
 * not know, reads it in UTC. Minutes are cut, not rounded, so the time is
 * never later than the bot waits.
 */
export function formatParlumeAdmitBy(
	at: Date,
	timeZone: string | null,
): string {
	const format = (zone: string) =>
		new Intl.DateTimeFormat("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZone: zone,
			timeZoneName: "short",
		}).format(at);
	if (timeZone) {
		try {
			return format(timeZone);
		} catch {
			// An unknown zone name reads as UTC below.
		}
	}
	return format("UTC");
}

/**
 * Tells the session's person that its bot could not join: the start failed
 * or nobody admitted it, with the reason the session row holds. Does nothing
 * for any other end reason.
 */
export async function notifyParlumeJoinFailure(
	sessionId: string,
): Promise<void> {
	try {
		const session = await db.parlumeMeetingSession.findUnique({
			where: { id: sessionId },
			select: noticeSessionSelect,
		});
		const endReason = session?.endReason ?? null;
		if (!session || !isParlumeJoinFailure(endReason)) {
			return;
		}
		const reason =
			session.lastError ?? "Parlume could not join the meeting.";
		const meetingName = session.linkedMeeting?.subject ?? null;
		const inserted = await writeNotice({
			userId: session.userId,
			organizationId: session.organizationId,
			type: NotificationType.PARLUME_JOIN_FAILED,
			category: NotificationCategory.SYSTEM,
			title: joinFailureTitle(endReason),
			snippet: meetingName ? `${meetingName}: ${reason}` : reason,
			link: `projects/${session.projectId}/parlume`,
			source: { projectId: session.projectId },
			payload: {
				sessionId: session.id,
				projectId: session.projectId,
				trigger: session.trigger,
				endReason,
			},
			dedupeKey: `parlume-join-failed:${session.id}`,
			dedupePolicy: "unreadOnly",
		});
		const emailed = inserted && !(await emailChannelOn(session.userId));
		if (emailed) {
			await sendEmail({
				to: session.user.email,
				templateId: "parlumeJoinFailed",
				idempotencyKey: `parlume-join-failed-${session.id}`,
				context: { meetingName, reason, url: parlumePageUrl(session) },
			});
		}
		parlumeLog("info", "notice.join_failed", {
			sessionId: session.id,
			endReason,
			inserted,
			emailed,
		});
	} catch (error) {
		parlumeLog("warn", "notice.failed", {
			sessionId,
			notice: "join_failed",
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Tells the session's person that its bot is not in the meeting yet and by
 * when someone must admit it from the lobby: the provider gives up
 * {@link PARLUME_LOBBY_WAIT_SECONDS} after it starts to join, so the time is
 * counted from the invite and is never later than the bot waits. Hosted
 * Attendee does not report a Teams lobby (its `waiting_room` state is off by
 * default), so the bridge asks for this when the bot's stream has not
 * connected a while after the invite; a self-hosted Attendee that reports
 * the state sends it from the webhook, with its bot. Only while the session's
 * bot is joining and has never streamed.
 */
export async function notifyParlumeWaitingInLobby(input: {
	sessionId: string;
	botId?: string;
}): Promise<void> {
	try {
		const session = await db.parlumeMeetingSession.findFirst({
			where: {
				id: input.sessionId,
				providerBotId: input.botId ?? { not: null },
				status: "JOINING",
				joinedAt: null,
			},
			select: noticeSessionSelect,
		});
		if (!session) {
			return;
		}
		const admitBy = formatParlumeAdmitBy(
			new Date(
				session.createdAt.getTime() + PARLUME_LOBBY_WAIT_SECONDS * 1000,
			),
			session.user.timezone,
		);
		const meetingName = session.linkedMeeting?.subject ?? null;
		const leaves = "If nobody admits it by then, it leaves the meeting.";
		const inserted = await writeNotice({
			userId: session.userId,
			organizationId: session.organizationId,
			type: NotificationType.PARLUME_WAITING_IN_LOBBY,
			category: NotificationCategory.SYSTEM,
			title: `Parlume is waiting to join: admit ${PARLUME_BOT_NAME} from the lobby by ${admitBy}`,
			snippet: meetingName ? `${meetingName}: ${leaves}` : leaves,
			link: `projects/${session.projectId}/parlume`,
			source: { projectId: session.projectId },
			payload: {
				sessionId: session.id,
				projectId: session.projectId,
				trigger: session.trigger,
				admitBy,
			},
			dedupeKey: `parlume-lobby:${session.id}`,
			dedupePolicy: "unreadOnly",
		});
		const emailed = inserted && !(await emailChannelOn(session.userId));
		if (emailed) {
			await sendEmail({
				to: session.user.email,
				templateId: "parlumeWaitingInLobby",
				idempotencyKey: `parlume-lobby-${session.id}`,
				context: { meetingName, admitBy, url: parlumePageUrl(session) },
			});
		}
		parlumeLog("info", "notice.waiting_in_lobby", {
			sessionId: session.id,
			botId: input.botId ?? null,
			inserted,
			emailed,
		});
	} catch (error) {
		parlumeLog("warn", "notice.failed", {
			sessionId: input.sessionId,
			botId: input.botId ?? null,
			notice: "waiting_in_lobby",
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
