import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	update: vi.fn(),
	updateMany: vi.fn(),
	finalize: vi.fn(),
	cleanup: vi.fn(),
	settings: vi.fn(),
	closeBridge: vi.fn(),
	sendSpeakers: vi.fn(),
	sendChat: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: (...args: unknown[]) => mocks.findFirst(...args),
			update: (...args: unknown[]) => mocks.update(...args),
			updateMany: (...args: unknown[]) => mocks.updateMany(...args),
		},
	},
}));

vi.mock("../../lib", () => ({
	callbackSecret: () => "callback-secret",
	constantTimeEqual: (provided: string | null, expected: string) =>
		provided === expected,
	MAX_PARLUME_SEGMENT_CHARS: 20_000,
}));

vi.mock("@repo/api/modules/projects/lib/parlume-finalization", () => ({
	finalizeParlumeSession: (...args: unknown[]) => mocks.finalize(...args),
	cleanupParlumeProviderData: (...args: unknown[]) => mocks.cleanup(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-attendee", () => ({
	getParlumeBridgeSettings: () => mocks.settings(),
	closeParlumeMeetingBridge: (...args: unknown[]) =>
		mocks.closeBridge(...args),
	sendParlumeSpeakerUpdates: (...args: unknown[]) =>
		mocks.sendSpeakers(...args),
	sendParlumeChatMessage: (...args: unknown[]) => mocks.sendChat(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

import { POST } from "../route";

function webhook(payload: Record<string, unknown>, token: string | null) {
	const url = new URL(
		"https://fabric.example/api/internal/parlume/callback?sessionId=session-1",
	);
	if (token !== null) {
		url.searchParams.set("token", token);
	}
	return new NextRequest(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			idempotency_key: "delivery-1",
			bot_id: "bot-1",
			bot_metadata: { parlume_session_id: "session-1" },
			...payload,
		}),
	});
}

function stateChange(
	newState: string,
	token: string | null = "callback-secret",
) {
	return webhook(
		{
			trigger: "bot.state_change",
			data: {
				event_type: "post_processing_completed",
				event_sub_type: null,
				old_state: "post_processing",
				new_state: newState,
				created_at: "2026-10-01T18:00:00.000000Z",
			},
		},
		token,
	);
}

const ended = () => stateChange("ended");
const fatalError = () => stateChange("fatal_error");

function speech(
	eventType: string,
	overrides: Record<string, unknown> = {},
	token: string | null = "callback-secret",
) {
	return webhook(
		{
			trigger: "participant_events.speech_start_stop",
			data: {
				id: "evt_1",
				participant_name: "Dev One",
				participant_uuid: "participant-1",
				participant_user_uuid: null,
				participant_is_host: false,
				event_type: eventType,
				event_data: {},
				timestamp_ms: 1_700_000_000_123,
				...overrides,
			},
		},
		token,
	);
}

const active = {
	id: "session-1",
	status: "ACTIVE",
	endReason: null,
	leaveRequestedAt: null,
	terminalCallbackAt: null,
	finalizedAt: null,
	streamClosedAt: null,
	streamGeneration: 2,
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.findFirst.mockResolvedValue(active);
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.update.mockResolvedValue(undefined);
	mocks.settings.mockReturnValue({ bridgeUrl: "wss://bridge.example" });
	mocks.closeBridge.mockResolvedValue(undefined);
	mocks.sendSpeakers.mockResolvedValue(undefined);
});

describe("Parlume callback authentication", () => {
	it("rejects a wrong token and logs the trigger without the token", async () => {
		const response = await POST(stateChange("ended", "stale-token"));

		expect(response.status).toBe(401);
		expect(mocks.findFirst).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"callback.rejected",
			expect.objectContaining({
				sessionId: "session-1",
				trigger: "bot.state_change",
				hasToken: true,
			}),
		);
		const logged = JSON.stringify(mocks.log.mock.calls);
		expect(logged).not.toContain("stale-token");
		expect(logged).not.toContain("callback-secret");
	});

	it("rejects a delivery with no token", async () => {
		const response = await POST(stateChange("ended", null));

		expect(response.status).toBe(401);
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"callback.rejected",
			expect.objectContaining({ hasToken: false }),
		);
	});

	it("does not accept the callback secret in a header in place of the URL token", async () => {
		const retired = new NextRequest(
			"https://fabric.example/api/internal/parlume/callback?sessionId=session-1",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-callback-secret": "callback-secret",
				},
				body: JSON.stringify({
					trigger: "bot.state_change",
					bot_id: "bot-1",
					data: { new_state: "ended" },
				}),
			},
		);

		const response = await POST(retired);

		expect(response.status).toBe(401);
		expect(mocks.findFirst).not.toHaveBeenCalled();
	});

	it("rejects an authenticated body that is not an Attendee webhook", async () => {
		const response = await POST(
			new NextRequest(
				"https://fabric.example/api/internal/parlume/callback?sessionId=session-1&token=callback-secret",
				{ method: "POST", body: "not json" },
			),
		);

		expect(response.status).toBe(400);
		expect(mocks.findFirst).not.toHaveBeenCalled();
	});

	it("rejects a state change that names no state", async () => {
		const response = await POST(
			webhook(
				{ trigger: "bot.state_change", data: {} },
				"callback-secret",
			),
		);

		expect(response.status).toBe(400);
		expect(mocks.findFirst).not.toHaveBeenCalled();
	});
});

describe("Parlume callback for states and triggers Fabric does not act on", () => {
	it.each([
		"joining",
		"waiting_room",
		"joined_recording",
		"leaving",
		"post_processing",
		"data_deleted",
	])("accepts the %s state without touching the session", async (state) => {
		const response = await POST(stateChange(state));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.findFirst).not.toHaveBeenCalled();
		expect(mocks.updateMany).not.toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
		expect(mocks.closeBridge).not.toHaveBeenCalled();
	});

	it("ignores a trigger it did not subscribe to", async () => {
		const response = await POST(
			webhook(
				{ trigger: "transcript.update", data: { transcription: {} } },
				"callback-secret",
			),
		);

		expect(response.status).toBe(200);
		expect(mocks.findFirst).not.toHaveBeenCalled();
	});

	it("reports a terminal state for a bot Fabric has no session for", async () => {
		mocks.findFirst.mockResolvedValue(null);

		const response = await POST(ended());

		expect(response.status).toBe(404);
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "session-1", providerBotId: "bot-1" },
			}),
		);
		expect(mocks.finalize).not.toHaveBeenCalled();
	});
});

describe("Parlume fatal_error callback after a leave Fabric requested", () => {
	it("records a normal end with the requested reason instead of a failure", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "LEAVING",
			endReason: "IDLE",
			leaveRequestedAt: new Date("2026-10-01T18:07:20Z"),
		});

		const response = await POST(fatalError());

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "session-1", streamGeneration: 2 },
			data: {
				status: "LEAVING",
				endReason: "IDLE",
				terminalCallbackAt: expect.any(Date),
			},
		});
		expect(mocks.updateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
	});
});

describe("Parlume fatal_error callback", () => {
	it("keeps the failure visible, closes the bridge, and defers finalization until buffered segments drain", async () => {
		const response = await POST(fatalError());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "session-1", status: { not: "ENDED" } },
			data: expect.objectContaining({
				status: "FAILED",
				endReason: "PROVIDER_FAILED",
			}),
		});
		expect(mocks.closeBridge).toHaveBeenCalledWith({
			settings: { bridgeUrl: "wss://bridge.example" },
			sessionId: "session-1",
		});
		expect(mocks.finalize).not.toHaveBeenCalled();
	});

	it("logs the event type and sub type Attendee reported", async () => {
		await POST(
			webhook(
				{
					trigger: "bot.state_change",
					data: {
						event_type: "could_not_join_meeting",
						event_sub_type:
							"could_not_join_meeting_waiting_room_timed_out",
						old_state: "waiting_room",
						new_state: "fatal_error",
					},
				},
				"callback-secret",
			),
		);

		expect(mocks.log).toHaveBeenCalledWith(
			"info",
			"callback.received",
			expect.objectContaining({
				outcome: "failed",
				eventType: "could_not_join_meeting",
				eventSubType: "could_not_join_meeting_waiting_room_timed_out",
			}),
		);
	});

	it("finalizes a failed bot before stream verification because no bridge drain can follow", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "JOINING",
			streamGeneration: 0,
		});

		const response = await POST(fatalError());

		expect(response.status).toBe(200);
		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			preserveFailure: true,
		});
		expect(mocks.closeBridge).not.toHaveBeenCalled();
	});

	it("keeps an earlier stop reason on a failure that follows it", async () => {
		mocks.findFirst.mockResolvedValue({ ...active, endReason: "STOPPED" });

		await POST(fatalError());

		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ endReason: "STOPPED" }),
			}),
		);
	});

	it("asks Attendee to redeliver when finalization cannot complete", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "JOINING",
			streamGeneration: 0,
		});
		mocks.finalize.mockRejectedValue(new Error("already in progress"));

		const response = await POST(fatalError());

		expect(response.status).toBe(503);
	});
});

describe("Parlume ended callback", () => {
	it("marks a bot that left an active meeting as removed and closes the bridge", async () => {
		const response = await POST(ended());

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "session-1", streamGeneration: 2 },
			data: {
				status: "LEAVING",
				endReason: "REMOVED",
				terminalCallbackAt: expect.any(Date),
			},
		});
		expect(mocks.closeBridge).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session-1" }),
		);
		expect(mocks.finalize).not.toHaveBeenCalled();
	});

	it("finalizes at once when the stream already closed", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "LEAVING",
			endReason: "STOPPED",
			streamClosedAt: new Date("2026-09-30T18:00:00Z"),
		});

		await POST(ended());

		expect(mocks.closeBridge).not.toHaveBeenCalled();
		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			expectedStreamGeneration: 2,
		});
	});

	it("still accepts the callback when the bridge cannot be reached", async () => {
		mocks.closeBridge.mockRejectedValue(new Error("bridge down"));

		const response = await POST(ended());

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"callback.bridge_close_failed",
			expect.objectContaining({ sessionId: "session-1" }),
		);
	});

	it("fails a bot that ended before the stream was ever verified", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "JOINING",
			streamGeneration: 0,
		});
		mocks.cleanup.mockResolvedValue(undefined);

		await POST(ended());

		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "FAILED",
					endReason: "START_FAILED",
				}),
			}),
		);
		expect(mocks.cleanup).toHaveBeenCalledWith("session-1");
	});
});

describe("Parlume repeated terminal callbacks", () => {
	const finalized = {
		...active,
		status: "ENDED",
		endReason: "REMOVED",
		terminalCallbackAt: new Date("2026-10-01T18:00:00Z"),
		finalizedAt: new Date("2026-10-01T18:00:05Z"),
		streamClosedAt: new Date("2026-10-01T18:00:02Z"),
	};

	it("does not finalize a session that already finalized", async () => {
		mocks.findFirst.mockResolvedValue(finalized);
		mocks.cleanup.mockResolvedValue(undefined);

		const response = await POST(ended());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			accepted: true,
			duplicate: true,
		});
		expect(mocks.finalize).not.toHaveBeenCalled();
		expect(mocks.updateMany).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("ignores an ended delivery that follows a handled fatal_error", async () => {
		mocks.findFirst.mockResolvedValue({
			...finalized,
			status: "FAILED",
			endReason: "PROVIDER_FAILED",
			terminalCallbackAt: null,
		});
		mocks.cleanup.mockResolvedValue(undefined);

		const response = await POST(ended());

		expect(response.status).toBe(200);
		expect(mocks.finalize).not.toHaveBeenCalled();
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("keeps retrying provider data deletion that an earlier delivery could not finish", async () => {
		mocks.findFirst.mockResolvedValue(finalized);
		mocks.cleanup.mockRejectedValue(new Error("Attendee outage"));

		const response = await POST(ended());

		expect(response.status).toBe(503);
		expect(mocks.cleanup).toHaveBeenCalledWith("session-1");
		expect(mocks.finalize).not.toHaveBeenCalled();
	});

	it("keeps the first terminal time when the same delivery repeats before finalization", async () => {
		const first = new Date("2026-10-01T18:00:00Z");
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "LEAVING",
			endReason: "REMOVED",
			terminalCallbackAt: first,
		});

		await POST(ended());

		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "session-1", streamGeneration: 2 },
			data: {
				status: "LEAVING",
				endReason: "REMOVED",
				terminalCallbackAt: first,
			},
		});
	});
});

describe("Parlume speech events", () => {
	it("forwards who started speaking to the session's bridge", async () => {
		const response = await POST(speech("speech_start"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.findFirst).toHaveBeenCalledWith({
			where: {
				id: "session-1",
				providerBotId: "bot-1",
				status: { in: ["JOINING", "ACTIVE", "LEAVING"] },
			},
			select: { id: true },
		});
		expect(mocks.sendSpeakers).toHaveBeenCalledWith({
			settings: { bridgeUrl: "wss://bridge.example" },
			sessionId: "session-1",
			updates: [
				{
					name: "Dev One",
					id: "participant-1",
					timestamp: 1_700_000_000_123,
					isSpeaking: true,
				},
			],
		});
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("forwards who stopped speaking", async () => {
		await POST(speech("speech_stop"));

		expect(mocks.sendSpeakers).toHaveBeenCalledWith(
			expect.objectContaining({
				updates: [expect.objectContaining({ isSpeaking: false })],
			}),
		);
	});

	it("drops the event of a bot whose session is over", async () => {
		mocks.findFirst.mockResolvedValue(null);

		const response = await POST(speech("speech_start"));

		expect(response.status).toBe(200);
		expect(mocks.sendSpeakers).not.toHaveBeenCalled();
	});

	it("accepts the event even when the bridge cannot be reached", async () => {
		mocks.sendSpeakers.mockRejectedValue(new Error("bridge down"));

		const response = await POST(speech("speech_start"));

		expect(response.status).toBe(200);
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"callback.speaker_forward_failed",
			expect.objectContaining({ sessionId: "session-1" }),
		);
		expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("Dev One");
	});

	it("accepts an event it cannot read without forwarding it", async () => {
		const response = await POST(speech("speech_pause"));

		expect(response.status).toBe(200);
		expect(mocks.sendSpeakers).not.toHaveBeenCalled();
	});

	it("rejects a speech event with the wrong token", async () => {
		const response = await POST(speech("speech_start", {}, "stale-token"));

		expect(response.status).toBe(401);
		expect(mocks.sendSpeakers).not.toHaveBeenCalled();
	});
});

function chatMessage(
	overrides: Record<string, unknown> = {},
	token: string | null = "callback-secret",
) {
	return webhook(
		{
			trigger: "chat_messages.update",
			data: {
				id: "msg_1",
				to: "everyone",
				text: "@Fabric Parlume what changed?",
				timestamp: 1_700_000_000,
				timestamp_ms: 1_700_000_000_000,
				sender_name: "Dev One",
				sender_uuid: "participant-1",
				sender_user_uuid: null,
				additional_data: {},
				...overrides,
			},
		},
		token,
	);
}

describe("Parlume meeting chat messages", () => {
	beforeEach(() => {
		mocks.sendChat.mockResolvedValue(undefined);
	});

	it("relays a chat message to the session's bridge", async () => {
		const response = await POST(chatMessage());

		expect(response.status).toBe(200);
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "session-1",
					providerBotId: "bot-1",
					status: { in: ["JOINING", "ACTIVE", "LEAVING"] },
				},
			}),
		);
		expect(mocks.sendChat).toHaveBeenCalledWith({
			settings: { bridgeUrl: "wss://bridge.example" },
			sessionId: "session-1",
			message: {
				id: "msg_1",
				text: "@Fabric Parlume what changed?",
				senderName: "Dev One",
				senderId: "participant-1",
				toBot: false,
				timestampMs: 1_700_000_000_000,
			},
		});
	});

	it("marks a private message to the bot", async () => {
		await POST(chatMessage({ to: "only_bot" }));

		expect(mocks.sendChat).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.objectContaining({ toBot: true }),
			}),
		);
	});

	it.each([
		["no id", { id: "" }],
		["an over-long text", { text: "x".repeat(20_001) }],
		["no timestamp", { timestamp_ms: "soon" }],
		["an over-long sender", { sender_name: "x".repeat(257) }],
	])("accepts and drops a message with %s", async (_label, overrides) => {
		const response = await POST(chatMessage(overrides));

		expect(response.status).toBe(200);
		expect(mocks.sendChat).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith("warn", "callback.invalid", {
			sessionId: "session-1",
			trigger: "chat_messages.update",
		});
	});

	it("asks Attendee to redeliver when the bridge cannot take it, without logging the text", async () => {
		mocks.sendChat.mockRejectedValue(new Error("bridge down"));

		const response = await POST(chatMessage());

		expect(response.status).toBe(503);
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"callback.chat_forward_failed",
			expect.objectContaining({ sessionId: "session-1" }),
		);
		expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(
			"what changed",
		);
	});

	it("drops a message for a session that is over", async () => {
		mocks.findFirst.mockResolvedValue(null);

		const response = await POST(chatMessage());

		expect(response.status).toBe(200);
		expect(mocks.sendChat).not.toHaveBeenCalled();
	});

	it("rejects a chat message with the wrong token", async () => {
		const response = await POST(chatMessage({}, "stale-token"));

		expect(response.status).toBe(401);
		expect(mocks.sendChat).not.toHaveBeenCalled();
	});
});
