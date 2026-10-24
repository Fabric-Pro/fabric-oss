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
import { parlumeLog } from "@repo/api/modules/projects/lib/parlume-log";
import { db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
	callbackSecret,
	constantTimeEqual,
	MAX_PARLUME_SEGMENT_CHARS,
} from "../lib";

const envelopeSchema = z.object({
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

// Attendee retries a rejected webhook. Naming the trigger and the missing
// piece is what lets an operator tell a stale bot from a wrong token; the token
// value itself is never logged.
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
		select: { id: true },
	});
	const settings = getParlumeBridgeSettings();
	if (!session || !settings) {
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
	if (outcome === "failed" && !requestedLeave) {
		await db.parlumeMeetingSession.updateMany({
			where: { id: session.id, status: { not: "ENDED" } },
			data: {
				status: "FAILED",
				endReason: session.endReason ?? "PROVIDER_FAILED",
				lastError: "Parlume meeting bot failed.",
				endedAt: new Date(),
			},
		});
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
		// stop claim finalization after those segments have reached Fabric.
		if (!session.streamClosedAt) {
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
	if (!session.streamClosedAt) {
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

/**
 * Attendee's webhook. It cannot sign per bot, so the URL Fabric registered for
 * the bot carries the session's own secret in `token`.
 */
export async function POST(request: NextRequest) {
	const sessionId = request.nextUrl.searchParams.get("sessionId");
	const token = request.nextUrl.searchParams.get("token");
	const raw = await request.text();
	const expected = sessionId ? callbackSecret(sessionId) : null;
	if (!sessionId || !expected || !constantTimeEqual(token, expected)) {
		parlumeLog("warn", "callback.rejected", {
			sessionId,
			...describeRejected(raw),
			hasToken: token !== null,
		});
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		json = null;
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
	const { trigger, bot_id: botId, data } = envelope.data;
	if (trigger === "participant_events.speech_start_stop") {
		const event = speechEventSchema.safeParse(data);
		if (event.success) {
			await forwardSpeechEvent(sessionId, botId, event.data);
		}
		return NextResponse.json({ accepted: true });
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
