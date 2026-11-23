import {
	getParlumeBridgeSettings,
	sendParlumeGuestUpdates,
} from "@repo/api/modules/projects/lib/parlume-attendee";
import {
	confirmParlumeAttendee,
	isParlumeChannelMeeting,
} from "@repo/api/modules/projects/lib/parlume-attendee-access";
import { parlumeDepartureNotice } from "@repo/api/modules/projects/lib/parlume-attendee-standing";
import { recordParlumeAttendee } from "@repo/api/modules/projects/lib/parlume-confidential";
import { isParlumeExternalParticipant } from "@repo/api/modules/projects/lib/parlume-guests";
import { requestParlumeLeave } from "@repo/api/modules/projects/lib/parlume-leave";
import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import { recordParlumeSpeakerMark } from "@repo/api/modules/projects/lib/parlume-speaker-marks";
import { db } from "@repo/database";
import { NextResponse } from "next/server";
import { z } from "zod";

// Attendee's `participant_events.join_leave` data. Only the fields Parlume
// uses are read, each bounded.
export const participantEventSchema = z.object({
	participant_name: z.string().max(256).nullish(),
	participant_uuid: z.string().min(1).max(256),
	participant_user_uuid: z.string().max(256).nullish(),
	event_type: z.enum(["join", "leave"]),
	timestamp_ms: z.number().finite().nullish(),
});

type GuestRelay = Pick<
	Parameters<typeof sendParlumeGuestUpdates>[0],
	"updates" | "placing"
>;

/**
 * Someone joined or left the meeting. Before Fabric checks someone who joined
 * (`confirmParlumeAttendee`), the bridge is told they are being checked, so
 * Parlume says nothing while the lookup runs; then it is told the outcome.
 * Parlume does not stay in front of anyone it cannot confirm, nor in a
 * channel meeting, whose chat people outside the meeting read: the bridge
 * stops speaking at once, the chat is told why, and Parlume leaves. The first
 * external guest is also recorded on the session, which keeps the meeting on
 * the classic voice, and everyone who joined is marked a member or a guest
 * for the transcript. A failed relay asks Attendee to redeliver: a lost join
 * would leave Parlume speaking in front of someone it must not.
 */
export async function forwardParticipantEvent(
	sessionId: string,
	botId: string,
	event: z.infer<typeof participantEventSchema>,
): Promise<NextResponse> {
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: sessionId,
			providerBotId: botId,
			status: { in: ["JOINING", "ACTIVE", "LEAVING"] },
		},
		select: {
			id: true,
			status: true,
			projectId: true,
			organizationId: true,
			userId: true,
			providerBotId: true,
			streamGeneration: true,
			guestJoinedAt: true,
			meetingUrl: true,
			channelId: true,
			channelRootMessageId: true,
			channelChatStatus: true,
		},
	});
	const settings = getParlumeBridgeSettings();
	if (!session?.providerBotId || !settings) {
		return NextResponse.json({ accepted: true });
	}
	const participant = {
		id: event.participant_uuid,
		userId: event.participant_user_uuid ?? null,
		name: event.participant_name ?? null,
	};
	const { id } = participant;
	// The bridge ignores a check for a join seen before this participant's
	// last leave: a delivery repeated after it.
	const at = event.timestamp_ms ?? undefined;
	const relay = async (guests: GuestRelay): Promise<boolean> => {
		try {
			await sendParlumeGuestUpdates({
				settings,
				sessionId: session.id,
				...guests,
			});
			return true;
		} catch (error) {
			parlumeLog("warn", "callback.guest_forward_failed", {
				sessionId: session.id,
				botId,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	};
	const retry = () =>
		NextResponse.json(
			{ error: "Guest relay retry required" },
			{ status: 503 },
		);

	if (event.event_type === "leave") {
		parlumeLog("info", "callback.participant", {
			sessionId: session.id,
			botId,
			joined: false,
		});
		const left = await relay({
			updates: [{ id, joined: false }],
			placing: [{ id, pending: false, at }],
		});
		return left ? NextResponse.json({ accepted: true }) : retry();
	}
	const channel = isParlumeChannelMeeting(session);
	// Parlume falls silent before the lookup, which can take seconds.
	const checking: GuestRelay = {
		updates: [],
		placing: [{ id, pending: true, at }],
	};
	if (!channel && !(await relay(checking))) {
		return retry();
	}
	const userId = channel
		? null
		: await confirmParlumeAttendee({ session, participant });
	// Recorded before the bridge hears of them, so a turn they ask, and the
	// confidential discussion they are present for, find them on the session.
	if (userId) {
		await recordParlumeAttendee({ sessionId: session.id, userId });
	}
	// The transcript and the Parlume page mark them by the outcome the bridge
	// is told next: it takes no request from a guest.
	await recordParlumeSpeakerMark({
		sessionId: session.id,
		participantId: id,
		mark: userId ? "member" : "guest",
	});
	if (!session.guestJoinedAt && isParlumeExternalParticipant(participant)) {
		await db.parlumeMeetingSession.updateMany({
			where: { id: session.id, guestJoinedAt: null },
			data: { guestJoinedAt: new Date() },
		});
	}
	parlumeLog("info", "callback.participant", {
		sessionId: session.id,
		botId,
		joined: true,
		confirmed: userId !== null,
	});
	let relayed = await relay(
		userId
			? { updates: [], placing: [{ id, pending: false, userId, at }] }
			: {
					updates: [{ id, joined: true }],
					placing: [{ id, pending: false, at }],
				},
	);
	if (!userId && session.status !== "LEAVING") {
		try {
			await requestParlumeLeave({
				session: {
					id: session.id,
					providerBotId: session.providerBotId,
					streamGeneration: session.streamGeneration,
				},
				reason: "ATTENDEE_NOT_AUTHORIZED",
				lastError: null,
				captureStopped: true,
				notice: parlumeDepartureNotice(
					channel
						? { kind: "channel" }
						: { kind: "attendee", name: participant.name },
				),
			});
		} catch {
			relayed = false;
		}
	}
	return relayed ? NextResponse.json({ accepted: true }) : retry();
}
