import {
	closeParlumeMeetingBridge,
	getParlumeBridgeSettings,
	sendParlumeChatMessage,
	sendParlumeSpeakerUpdates,
} from "@repo/api/modules/projects/lib/parlume-attendee";
import {
	cleanupParlumeProviderData,
	finalizeParlumeSession,
} from "@repo/api/modules/projects/lib/parlume-finalization";
import { isParlumeExternalParticipant } from "@repo/api/modules/projects/lib/parlume-guests";
import { describeParlumeProviderFailure } from "@repo/api/modules/projects/lib/parlume-join-failure";
import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import {
	notifyParlumeJoinFailure,
	notifyParlumeWaitingInLobby,
} from "@repo/api/modules/projects/lib/parlume-notices";
import { resolveParlumeWebhookSecret } from "@repo/api/modules/projects/lib/parlume-provider-settings";
import { db } from "@repo/database";
import { parseChannelMeetingUrl } from "@repo/integrations/microsoft/parlume-channel";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
	constantTimeEqual,
	isAttendeeWebhookSigned,
	MAX_PARLUME_SEGMENT_CHARS,
	sessionTokenDigest,
} from "../lib";
import { forwardParticipantEvent, participantEventSchema } from "./guests";

// A leave for someone seen as the bot comes in waits up to 30 seconds for the
// bot to be in the call, and up to 15 more for its chat to settle, to post
// why it leaves; its Attendee calls take up to 18 seconds more.
export const maxDuration = 90;

const envelopeSchema = z.object({
	idempotency_key: z.string().min(1).max(128).optional(),
	trigger: z.string().max(128),
	bot_id: z.string().min(1).max(256),
	data: z.unknown(),
});

const stateChangeSchema = z.object({
	new_state: z.string().max(64),
	event_type: z.string().max(128).nullish(),
	event_sub_type: z.string().max(128).nullish(),
});

const speechEventSchema = z.object({
	participant_name: z.string().max(256),
	participant_uuid: z.string().min(1).max(256),
	event_type: z.enum(["speech_start", "speech_stop"]),
	timestamp_ms: z.number(),
});

// Attendee's `chat_messages.update` data. Only the fields Parlume uses are
// read, each bounded; `to` is "only_bot" for a private message to the bot.
const chatMessageSchema = z.object({
	id: z.string().min(1).max(128),
	text: z.string().max(MAX_PARLUME_SEGMENT_CHARS),
	timestamp_ms: z.number().finite(),
	to: z.string().max(32).nullish(),
	sender_name: z.string().max(256).nullish(),
	sender_uuid: z.string().max(256).nullish(),
});

type TerminalOutcome = "completed" | "failed";
type Envelope = z.infer<typeof envelopeSchema>;

// Attendee retries a rejected webhook. Naming the trigger and the missing
// piece is what lets an operator tell a stale bot from a wrong token or a
// bad signature; the token value itself is never logged.
function describeRejected(raw: string): { trigger: string | null } {
	try {
		const body: unknown = JSON.parse(raw);
		return {
			trigger:
				typeof body === "object" &&
				body !== null &&
				"trigger" in body &&
				typeof body.trigger === "string"
					? body.trigger
					: null,
		};
	} catch {
		return { trigger: null };
	}
}

// Best effort: the alarm-driven access check closes the stream within a
// minute anyway once the terminal callback is recorded.
async function closeBridge(sessionId: string): Promise<void> {
	const settings = getParlumeBridgeSettings();
	if (!settings) {
		return;
	}
	try {
		await closeParlumeMeetingBridge({ settings, sessionId });
	} catch (error) {
		parlumeLog("warn", "callback.bridge_close_failed", {
			sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

// Best effort and unlogged on success: speech events arrive for every turn of
// every participant. A lost one only costs a transcript turn its speaker label.
async function forwardSpeechEvent(
	sessionId: string,
	botId: string,
	event: z.infer<typeof speechEventSchema>,
): Promise<void> {
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: sessionId,
			providerBotId: botId,
			status: { in: ["JOINING", "ACTIVE", "LEAVING"] },
		},
		select: { id: true },
	});
	const settings = getParlumeBridgeSettings();
	if (!session || !settings) {
		return;
	}
	try {
		await sendParlumeSpeakerUpdates({
			settings,
			sessionId: session.id,
			updates: [
				{
					name: event.participant_name,
					id: event.participant_uuid,
					timestamp: event.timestamp_ms,
					isSpeaking: event.event_type === "speech_start",
				},
			],
		});
	} catch (error) {
		parlumeLog("warn", "callback.speaker_forward_failed", {
			sessionId: session.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Relays one meeting chat message to the bridge, which stores it and acts on
 * it. Unlike a speech event, a lost message can be a participant's request or
 * Parlume's own delivery receipt, so a failed relay asks Attendee to redeliver;
 * the bridge ignores a message id it has already seen.
 */
async function forwardChatMessage(
	sessionId: string,
	botId: string,
	message: z.infer<typeof chatMessageSchema>,
): Promise<NextResponse> {
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: sessionId,
			providerBotId: botId,
			status: { in: ["JOINING", "ACTIVE", "LEAVING"] },
		},
		select: {
			id: true,
			channelChatStatus: true,
			channelId: true,
			channelRootMessageId: true,
			meetingUrl: true,
		},
	});
	const settings = getParlumeBridgeSettings();
	if (!session || !settings) {
		return NextResponse.json({ accepted: true });
	}
	const hasChannelBinding = session.channelId || session.channelRootMessageId;
	if (
		hasChannelBinding ||
		(parseChannelMeetingUrl(session.meetingUrl ?? "") &&
			session.channelChatStatus !== "ATTENDEE" &&
			session.channelChatStatus !== "UNRESOLVED")
	) {
		return NextResponse.json({ accepted: true });
	}
	try {
		await sendParlumeChatMessage({
			settings,
			sessionId: session.id,
			message: {
				id: message.id,
				text: message.text,
				senderName: message.sender_name ?? null,
				senderId: message.sender_uuid ?? null,
				senderExternal: isParlumeExternalParticipant({
					id: message.sender_uuid ?? "",
					name: message.sender_name ?? null,
				}),
				toBot: message.to === "only_bot",
				timestampMs: message.timestamp_ms,
			},
		});
	} catch (error) {
		parlumeLog("warn", "callback.chat_forward_failed", {
			sessionId: session.id,
			botId,
			error: error instanceof Error ? error.message : String(error),
		});
		return NextResponse.json(
			{ error: "Chat relay retry required" },
			{ status: 503 },
		);
	}
	return NextResponse.json({ accepted: true });
}

async function handleTerminalState(input: {
	sessionId: string;
	botId: string;
	outcome: TerminalOutcome;
	state: { eventType: string | null; eventSubType: string | null };
}): Promise<NextResponse> {
	const { sessionId, botId, outcome } = input;
	const session = await db.parlumeMeetingSession.findFirst({
		where: { id: sessionId, providerBotId: botId },
		select: {
			id: true,
			status: true,
			endReason: true,
			leaveRequestedAt: true,
			terminalCallbackAt: true,
			finalizedAt: true,
			streamClosedAt: true,
			streamGeneration: true,
		},
	});
	if (!session) {
		parlumeLog("warn", "callback.unknown_session", {
			sessionId,
			botId,
			outcome,
		});
		return NextResponse.json({ error: "Unknown session" }, { status: 404 });
	}
	parlumeLog("info", "callback.received", {
		sessionId: session.id,
		botId,
		outcome,
		eventType: input.state.eventType,
		eventSubType: input.state.eventSubType,
		status: session.status,
		streamClosed: session.streamClosedAt !== null,
	});
	// Attendee redelivers a webhook it could not confirm, and a bot can report
	// more than one terminal state. Once the session is finalized nothing more
	// is owed except the provider's data deletion, which a failed attempt leaves
	// for the next delivery to retry.
	if (session.finalizedAt) {
		try {
			await cleanupParlumeProviderData(session.id);
		} catch {
			return NextResponse.json(
				{ error: "Provider data deletion retry required" },
				{ status: 503 },
			);
		}
		return NextResponse.json({ accepted: true, duplicate: true });
	}
	// A leave Fabric asked for (stop, idle, revoked access, hard stop) is a
	// normal end with the reason already recorded, even if the provider reports
	// the bot as failed.
	const requestedLeave =
		session.leaveRequestedAt !== null && session.endReason !== null;
	// Only an authenticated media stream can still be draining segments: the
	// bridge bumps `streamGeneration` when it verifies one. A bot stopped or
	// refused in the lobby never opened one, so no stream close will ever
	// arrive, and the bridge alarm that drives the watchdog may not exist for
	// it either. Waiting would leave the session LEAVING for good, so such a
	// session finalizes on its terminal callback.
	const streamMayDrain =
		session.streamGeneration > 0 && session.streamClosedAt === null;
	if (outcome === "failed" && !requestedLeave) {
		// A bot nobody admitted, or one the meeting refused, gets its own
		// reason and words; anything Attendee does not explain stays generic
		// and names its sub type.
		const failure = describeParlumeProviderFailure(input.state);
		const marked = await db.parlumeMeetingSession.updateMany({
			where: { id: session.id, status: { not: "ENDED" } },
			data: {
				status: "FAILED",
				endReason: session.endReason ?? failure.endReason,
				lastError: failure.message,
				endedAt: new Date(),
			},
		});
		// The first failure the session records tells its inviter, if the bot
		// never got in; a redelivery finds the session FAILED already.
		if (marked.count > 0 && session.status !== "FAILED") {
			await notifyParlumeJoinFailure(session.id);
		}
		if (session.status === "PENDING" || session.status === "JOINING") {
			try {
				await finalizeParlumeSession(session.id, {
					preserveFailure: true,
				});
			} catch {
				return NextResponse.json(
					{ error: "Finalization retry required" },
					{ status: 503 },
				);
			}
			return NextResponse.json({ accepted: true });
		}
		// The bridge can still be draining final segments that were buffered during
		// an outage. Keep the failure visible, then let stream close or the hard
		// stop claim finalization after those segments have reached Fabric. A
		// stream that never opened has nothing to drain (see below).
		if (streamMayDrain) {
			await closeBridge(session.id);
			return NextResponse.json({ accepted: true });
		}
		try {
			await finalizeParlumeSession(session.id, {
				preserveFailure: true,
				expectedStreamGeneration: session.streamGeneration,
			});
		} catch {
			return NextResponse.json(
				{ error: "Provider data deletion retry required" },
				{ status: 503 },
			);
		}
		return NextResponse.json({ accepted: true });
	}
	if (session.status === "PENDING" || session.status === "JOINING") {
		await db.parlumeMeetingSession.update({
			where: { id: session.id },
			data: {
				status: "FAILED",
				endReason: session.endReason ?? "START_FAILED",
				lastError:
					"Parlume completed without an authenticated transcription stream.",
				endedAt: new Date(),
			},
		});
		await notifyParlumeJoinFailure(session.id);
		try {
			await cleanupParlumeProviderData(session.id);
		} catch {
			return NextResponse.json(
				{ error: "Provider data deletion retry required" },
				{ status: 503 },
			);
		}
		return NextResponse.json({ accepted: true });
	}
	const callbackRecorded = await db.parlumeMeetingSession.updateMany({
		where: { id: session.id, streamGeneration: session.streamGeneration },
		data: {
			status: session.status === "ACTIVE" ? "LEAVING" : session.status,
			// A completed bot that Fabric never asked to leave was removed by
			// the host or outlived the meeting.
			endReason: session.endReason ?? "REMOVED",
			// The first terminal delivery is the exact time the bot stopped costing
			// provider time; a later one must not move it.
			terminalCallbackAt: session.terminalCallbackAt ?? new Date(),
		},
	});
	if (callbackRecorded.count === 0) {
		return NextResponse.json({ accepted: true, stale: true });
	}
	if (streamMayDrain) {
		await closeBridge(session.id);
		return NextResponse.json({ accepted: true });
	}
	try {
		await finalizeParlumeSession(session.id, {
			expectedStreamGeneration: session.streamGeneration,
		});
		return NextResponse.json({ accepted: true });
	} catch {
		return NextResponse.json(
			{ error: "Finalization retry required" },
			{ status: 503 },
		);
	}
}

async function handleDelivery(
	sessionId: string,
	envelope: Envelope,
): Promise<NextResponse> {
	const { trigger, bot_id: botId, data } = envelope;
	if (trigger === "participant_events.speech_start_stop") {
		const event = speechEventSchema.safeParse(data);
		if (event.success) {
			await forwardSpeechEvent(sessionId, botId, event.data);
		}
		return NextResponse.json({ accepted: true });
	}
	if (trigger === "participant_events.join_leave") {
		const event = participantEventSchema.safeParse(data);
		if (!event.success) {
			parlumeLog("warn", "callback.invalid", { sessionId, trigger });
			return NextResponse.json({ accepted: true });
		}
		return forwardParticipantEvent(sessionId, botId, event.data);
	}
	if (trigger === "chat_messages.update") {
		const message = chatMessageSchema.safeParse(data);
		if (!message.success) {
			parlumeLog("warn", "callback.invalid", { sessionId, trigger });
			return NextResponse.json({ accepted: true });
		}
		return forwardChatMessage(sessionId, botId, message.data);
	}
	if (trigger !== "bot.state_change") {
		return NextResponse.json({ accepted: true });
	}
	const change = stateChangeSchema.safeParse(data);
	if (!change.success) {
		parlumeLog("warn", "callback.invalid", { sessionId, trigger });
		return NextResponse.json(
			{ error: "Invalid callback" },
			{ status: 400 },
		);
	}
	const outcome: TerminalOutcome | null =
		change.data.new_state === "ended"
			? "completed"
			: change.data.new_state === "fatal_error"
				? "failed"
				: null;
	if (change.data.new_state === "waiting_room") {
		await notifyParlumeWaitingInLobby({ sessionId, botId });
		return NextResponse.json({ accepted: true });
	}
	if (!outcome) {
		return NextResponse.json({ accepted: true });
	}
	return handleTerminalState({
		sessionId,
		botId,
		outcome,
		state: {
			eventType: change.data.event_type ?? null,
			eventSubType: change.data.event_sub_type ?? null,
		},
	});
}

function rejected(input: {
	sessionId: string | null;
	raw: string;
	reason: "token" | "signature";
	hasToken: boolean;
}): NextResponse {
	parlumeLog("warn", "callback.rejected", {
		sessionId: input.sessionId,
		...describeRejected(input.raw),
		reason: input.reason,
		hasToken: input.hasToken,
	});
	return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Attendee's webhook. A delivery is accepted only with the session's own
 * random token in the URL, which stops working once Attendee's data for the
 * bot is deleted. When Fabric has the webhook secret of the project the bot
 * was created on (recorded on the session, so a key the organization saves
 * mid-meeting does not change it), Attendee's signature is required too;
 * without one the token alone is accepted and the delivery logged as unsigned. A delivery whose
 * idempotency key the session already handled is acknowledged and not acted
 * on again.
 */
export async function POST(request: NextRequest) {
	const sessionId = request.nextUrl.searchParams.get("sessionId");
	const token = request.nextUrl.searchParams.get("token");
	const raw = await request.text();
	if (!sessionId || !token) {
		return rejected({
			sessionId,
			raw,
			reason: "token",
			hasToken: token !== null,
		});
	}
	const session = await db.parlumeMeetingSession.findUnique({
		where: { id: sessionId },
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			callbackTokenDigest: true,
			attendeeSource: true,
		},
	});
	if (
		!session ||
		!constantTimeEqual(
			sessionTokenDigest(token),
			session.callbackTokenDigest ?? undefined,
		)
	) {
		return rejected({ sessionId, raw, reason: "token", hasToken: true });
	}
	const webhookSecret = await resolveParlumeWebhookSecret(session);
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		json = null;
	}
	if (
		webhookSecret &&
		!isAttendeeWebhookSigned(
			json,
			request.headers.get("x-webhook-signature"),
			webhookSecret,
		)
	) {
		return rejected({
			sessionId,
			raw,
			reason: "signature",
			hasToken: true,
		});
	}
	const envelope = envelopeSchema.safeParse(json);
	if (!envelope.success) {
		parlumeLog("warn", "callback.invalid", {
			sessionId,
			...describeRejected(raw),
		});
		return NextResponse.json(
			{ error: "Invalid callback" },
			{ status: 400 },
		);
	}
	if (!webhookSecret) {
		parlumeLog("info", "callback.unsigned", {
			sessionId,
			trigger: envelope.data.trigger,
		});
	}
	const idempotencyKey = envelope.data.idempotency_key;
	if (!idempotencyKey) {
		return handleDelivery(sessionId, envelope.data);
	}
	const receipt = { sessionId: session.id, idempotencyKey };
	const claimed = await db.parlumeWebhookReceipt.createMany({
		data: {
			...receipt,
			projectId: session.projectId,
			organizationId: session.organizationId,
			userId: session.userId,
			trigger: envelope.data.trigger,
		},
		skipDuplicates: true,
	});
	if (claimed.count === 0) {
		parlumeLog("info", "callback.duplicate", {
			sessionId,
			trigger: envelope.data.trigger,
		});
		return NextResponse.json({ accepted: true, duplicate: true });
	}
	// A refused delivery is redelivered under the same key, and the
	// redelivery must be acted on.
	let response: NextResponse | null = null;
	try {
		response = await handleDelivery(sessionId, envelope.data);
		return response;
	} finally {
		if (!response?.ok) {
			await db.parlumeWebhookReceipt.deleteMany({ where: receipt });
		}
	}
}
