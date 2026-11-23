import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	findFirst: vi.fn(),
	update: vi.fn(),
	updateMany: vi.fn(),
	receiptCreateMany: vi.fn(),
	receiptDeleteMany: vi.fn(),
	webhookSecret: vi.fn(),
	finalize: vi.fn(),
	cleanup: vi.fn(),
	settings: vi.fn(),
	closeBridge: vi.fn(),
	sendSpeakers: vi.fn(),
	sendChat: vi.fn(),
	sendGuests: vi.fn(),
	confirmAttendee: vi.fn(),
	recordAttendee: vi.fn(),
	recordSpeakerMark: vi.fn(),
	channelMeeting: vi.fn(),
	departureNotice: vi.fn(),
	leave: vi.fn(),
	log: vi.fn(),
	notifyJoinFailure: vi.fn(),
	notifyLobby: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findUnique: (...args: unknown[]) => mocks.findUnique(...args),
			findFirst: (...args: unknown[]) => mocks.findFirst(...args),
			update: (...args: unknown[]) => mocks.update(...args),
			updateMany: (...args: unknown[]) => mocks.updateMany(...args),
		},
		parlumeWebhookReceipt: {
			createMany: (...args: unknown[]) =>
				mocks.receiptCreateMany(...args),
			deleteMany: (...args: unknown[]) =>
				mocks.receiptDeleteMany(...args),
		},
	},
}));

vi.mock("@repo/api/modules/projects/lib/parlume-provider-settings", () => ({
	resolveParlumeWebhookSecret: (...args: unknown[]) =>
		mocks.webhookSecret(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-attendee-access", () => ({
	confirmParlumeAttendee: (...args: unknown[]) =>
		mocks.confirmAttendee(...args),
	isParlumeChannelMeeting: (...args: unknown[]) =>
		mocks.channelMeeting(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-confidential", () => ({
	recordParlumeAttendee: (...args: unknown[]) =>
		mocks.recordAttendee(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-speaker-marks", () => ({
	recordParlumeSpeakerMark: (...args: unknown[]) =>
		mocks.recordSpeakerMark(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-attendee-standing", () => ({
	parlumeDepartureNotice: (...args: unknown[]) =>
		mocks.departureNotice(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-leave", () => ({
	requestParlumeLeave: (...args: unknown[]) => mocks.leave(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-finalization", () => ({
	finalizeParlumeSession: (...args: unknown[]) => mocks.finalize(...args),
	cleanupParlumeProviderData: (...args: unknown[]) => mocks.cleanup(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-attendee", () => ({
	getParlumeBridgeSettings: () => mocks.settings(),
	sendParlumeGuestUpdates: (...args: unknown[]) => mocks.sendGuests(...args),
	closeParlumeMeetingBridge: (...args: unknown[]) =>
		mocks.closeBridge(...args),
	sendParlumeSpeakerUpdates: (...args: unknown[]) =>
		mocks.sendSpeakers(...args),
	sendParlumeChatMessage: (...args: unknown[]) => mocks.sendChat(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-notices", () => ({
	notifyParlumeJoinFailure: (...args: unknown[]) =>
		mocks.notifyJoinFailure(...args),
	notifyParlumeWaitingInLobby: (...args: unknown[]) =>
		mocks.notifyLobby(...args),
}));

import { POST } from "../route";

// Shaped like the base64 secret Attendee's dashboard shows; not a real one.
const WEBHOOK_SECRET = Buffer.from("example-webhook-secret-000000").toString(
	"base64",
);

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, field]) => [key, sortKeys(field)]),
		);
	}
	return value;
}

// As Attendee's own webhook guide signs a payload in JavaScript.
function attendeeSignature(body: unknown, secret = WEBHOOK_SECRET): string {
	return createHmac("sha256", Buffer.from(secret, "base64"))
		.update(JSON.stringify(sortKeys(body)), "utf8")
		.digest("base64");
}

function webhook(
	payload: Record<string, unknown>,
	token: string | null,
	sign: (body: unknown) => string | null = attendeeSignature,
) {
	const url = new URL(
		"https://fabric.example/api/internal/parlume/callback?sessionId=session-1",
	);
	if (token !== null) {
		url.searchParams.set("token", token);
	}
	const body = {
		idempotency_key: "delivery-1",
		bot_id: "bot-1",
		bot_metadata: { parlume_session_id: "session-1" },
		...payload,
	};
	const signature = sign(body);
	return new NextRequest(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(signature ? { "x-webhook-signature": signature } : {}),
		},
		body: JSON.stringify(body),
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

// The token Fabric put in this bot's webhook URL, stored only as a digest.
const tokenSession = {
	id: "session-1",
	projectId: "project-1",
	organizationId: "org-1",
	userId: "user-1",
	callbackTokenDigest: createHash("sha256")
		.update("callback-secret")
		.digest("hex"),
	attendeeSource: "ENVIRONMENT",
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.findUnique.mockResolvedValue(tokenSession);
	mocks.webhookSecret.mockResolvedValue(WEBHOOK_SECRET);
	mocks.receiptCreateMany.mockResolvedValue({ count: 1 });
	mocks.receiptDeleteMany.mockResolvedValue({ count: 1 });
	mocks.findFirst.mockResolvedValue(active);
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.update.mockResolvedValue(undefined);
	mocks.settings.mockReturnValue({ bridgeUrl: "wss://bridge.example" });
	mocks.closeBridge.mockResolvedValue(undefined);
	mocks.sendSpeakers.mockResolvedValue(undefined);
	mocks.notifyJoinFailure.mockResolvedValue(undefined);
	mocks.notifyLobby.mockResolvedValue(undefined);
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

	it("rejects an unsigned body with a valid token before reading it", async () => {
		const response = await POST(
			new NextRequest(
				"https://fabric.example/api/internal/parlume/callback?sessionId=session-1&token=callback-secret",
				{ method: "POST", body: "not json" },
			),
		);

		expect(response.status).toBe(401);
		expect(mocks.findFirst).not.toHaveBeenCalled();
	});

	it("rejects a signed body that is not an Attendee webhook", async () => {
		const body = { event: "something else" };
		const response = await POST(
			new NextRequest(
				"https://fabric.example/api/internal/parlume/callback?sessionId=session-1&token=callback-secret",
				{
					method: "POST",
					headers: { "x-webhook-signature": attendeeSignature(body) },
					body: JSON.stringify(body),
				},
			),
		);

		expect(response.status).toBe(400);
		expect(mocks.findFirst).not.toHaveBeenCalled();
		expect(mocks.receiptCreateMany).not.toHaveBeenCalled();
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

describe("Parlume callback signature, token and redelivery", () => {
	function rejectedFor(reason: string) {
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"callback.rejected",
			expect.objectContaining({ sessionId: "session-1", reason }),
		);
		expect(mocks.findFirst).not.toHaveBeenCalled();
		expect(mocks.receiptCreateMany).not.toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
		expect(mocks.sendChat).not.toHaveBeenCalled();
	}

	it("accepts a delivery signed with the bot's Attendee project secret", async () => {
		const response = await POST(ended());

		expect(response.status).toBe(200);
		expect(mocks.webhookSecret).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				attendeeSource: "ENVIRONMENT",
			}),
		);
		expect(mocks.findUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "session-1" } }),
		);
	});

	it("rejects an unsigned event when a secret is set, even with the session's token", async () => {
		const response = await POST(
			webhook(
				{ trigger: "bot.state_change", data: { new_state: "ended" } },
				"callback-secret",
				() => null,
			),
		);

		expect(response.status).toBe(401);
		rejectedFor("signature");
	});

	it("rejects a bad signature when a secret is set", async () => {
		const response = await POST(
			webhook(
				{
					trigger: "chat_messages.update",
					data: {
						id: "msg-1",
						text: "Parlume, go P1",
						timestamp_ms: 1_700_000_000_000,
						to: "everyone",
					},
				},
				"callback-secret",
				(body) =>
					attendeeSignature(
						body,
						"b3RoZXItcHJvamVjdC13ZWJob29rLXNlY3JldA==",
					),
			),
		);

		expect(response.status).toBe(401);
		rejectedFor("signature");
	});

	it("rejects a signed event whose body was changed", async () => {
		const original = {
			trigger: "bot.state_change",
			data: { new_state: "joining" },
		};
		const response = await POST(
			webhook(
				{ trigger: "bot.state_change", data: { new_state: "ended" } },
				"callback-secret",
				() =>
					attendeeSignature({
						idempotency_key: "delivery-1",
						bot_id: "bot-1",
						bot_metadata: { parlume_session_id: "session-1" },
						...original,
					}),
			),
		);

		expect(response.status).toBe(401);
		rejectedFor("signature");
	});

	it("accepts a token-only delivery when no secret is set and logs callback.unsigned", async () => {
		mocks.webhookSecret.mockResolvedValue(null);

		const response = await POST(
			speech("speech_start", {}, "callback-secret"),
		);

		expect(response.status).toBe(200);
		expect(mocks.log).toHaveBeenCalledWith("info", "callback.unsigned", {
			sessionId: "session-1",
			trigger: "participant_events.speech_start_stop",
		});
		expect(mocks.receiptCreateMany).toHaveBeenCalledOnce();
		expect(mocks.sendSpeakers).toHaveBeenCalledOnce();
	});

	it("still rejects a wrong token when no secret is set", async () => {
		mocks.webhookSecret.mockResolvedValue(null);

		const response = await POST(stateChange("ended", "stale-token"));

		expect(response.status).toBe(401);
		rejectedFor("token");
	});

	it("does not log a signed delivery as unsigned", async () => {
		await POST(ended());

		expect(mocks.log).not.toHaveBeenCalledWith(
			"info",
			"callback.unsigned",
			expect.anything(),
		);
	});

	it("rejects the token once the session finalized and revoked it", async () => {
		mocks.findUnique.mockResolvedValue({
			...tokenSession,
			callbackTokenDigest: null,
		});

		const response = await POST(ended());

		expect(response.status).toBe(401);
		rejectedFor("token");
		expect(mocks.cleanup).not.toHaveBeenCalled();
	});

	it("rejects another session's token", async () => {
		mocks.findUnique.mockResolvedValue({
			...tokenSession,
			callbackTokenDigest: createHash("sha256")
				.update("other-session-token")
				.digest("hex"),
		});

		const response = await POST(ended());

		expect(response.status).toBe(401);
		rejectedFor("token");
	});

	it("records each delivery once, with the session's tenant", async () => {
		await POST(speech("speech_start"));

		expect(mocks.receiptCreateMany).toHaveBeenCalledWith({
			data: {
				sessionId: "session-1",
				idempotencyKey: "delivery-1",
				projectId: "project-1",
				organizationId: "org-1",
				userId: "user-1",
				trigger: "participant_events.speech_start_stop",
			},
			skipDuplicates: true,
		});
		expect(mocks.receiptDeleteMany).not.toHaveBeenCalled();
	});

	it("ignores a repeated delivery of the same idempotency key", async () => {
		mocks.receiptCreateMany.mockResolvedValue({ count: 0 });

		const response = await POST(ended());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			accepted: true,
			duplicate: true,
		});
		expect(mocks.findFirst).not.toHaveBeenCalled();
		expect(mocks.updateMany).not.toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith("info", "callback.duplicate", {
			sessionId: "session-1",
			trigger: "bot.state_change",
		});
	});

	it("ignores a repeated chat delivery without relaying it again", async () => {
		mocks.receiptCreateMany.mockResolvedValue({ count: 0 });

		const response = await POST(
			webhook(
				{
					trigger: "chat_messages.update",
					data: {
						id: "msg-1",
						text: "Parlume, what is open?",
						timestamp_ms: 1_700_000_000_000,
						to: "everyone",
					},
				},
				"callback-secret",
			),
		);

		expect(response.status).toBe(200);
		expect(mocks.sendChat).not.toHaveBeenCalled();
	});

	it("handles a delivery without an idempotency key once, with no receipt", async () => {
		const response = await POST(
			webhook(
				{
					idempotency_key: undefined,
					trigger: "participant_events.speech_start_stop",
					data: {
						id: "evt_1",
						participant_name: "Dev One",
						participant_uuid: "participant-1",
						participant_user_uuid: null,
						participant_is_host: false,
						event_type: "speech_start",
						event_data: {},
						timestamp_ms: 1_700_000_000_123,
					},
				},
				"callback-secret",
			),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.sendSpeakers).toHaveBeenCalledOnce();
		expect(mocks.receiptCreateMany).not.toHaveBeenCalled();
		expect(mocks.receiptDeleteMany).not.toHaveBeenCalled();
	});

	it("releases the receipt of a delivery it asks Attendee to redeliver", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			streamClosedAt: new Date("2026-10-01T18:00:00Z"),
		});
		mocks.finalize.mockRejectedValue(new Error("database unavailable"));

		const response = await POST(ended());

		expect(response.status).toBe(503);
		expect(mocks.receiptDeleteMany).toHaveBeenCalledWith({
			where: { sessionId: "session-1", idempotencyKey: "delivery-1" },
		});
	});
});

describe("Parlume callback for states and triggers Fabric does not act on", () => {
	it.each([
		"joining",
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
		expect(mocks.notifyLobby).not.toHaveBeenCalled();
		expect(mocks.notifyJoinFailure).not.toHaveBeenCalled();
	});

	it("tells the inviter the bot is in the lobby, and changes nothing on the session", async () => {
		const response = await POST(stateChange("waiting_room"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.notifyLobby).toHaveBeenCalledOnce();
		expect(mocks.notifyLobby).toHaveBeenCalledWith({
			sessionId: "session-1",
			botId: "bot-1",
		});
		expect(mocks.updateMany).not.toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
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
						event_sub_type: "waiting_room_timeout_exceeded",
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
				eventSubType: "waiting_room_timeout_exceeded",
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

	function couldNotJoin(subType: string | null) {
		return webhook(
			{
				trigger: "bot.state_change",
				data: {
					event_type: "could_not_join_meeting",
					event_sub_type: subType,
					old_state: "waiting_room",
					new_state: "fatal_error",
				},
			},
			"callback-secret",
		);
	}

	it("ends a bot nobody admitted from the lobby as not admitted, in plain words", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "JOINING",
			streamGeneration: 0,
		});

		await POST(couldNotJoin("waiting_room_timeout_exceeded"));

		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "session-1", status: { not: "ENDED" } },
			data: expect.objectContaining({
				status: "FAILED",
				endReason: "NOT_ADMITTED",
				lastError:
					"Nobody admitted Parlume from the lobby within 5 minutes.",
			}),
		});
		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			preserveFailure: true,
		});
	});

	it("tells the inviter once that the bot was not admitted, after recording why", async () => {
		const order: string[] = [];
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "JOINING",
			streamGeneration: 0,
		});
		mocks.updateMany.mockImplementation(async () => {
			order.push("record");
			return { count: 1 };
		});
		mocks.notifyJoinFailure.mockImplementation(async () => {
			order.push("notify");
		});

		await POST(couldNotJoin("request_to_join_denied"));

		expect(mocks.notifyJoinFailure).toHaveBeenCalledOnce();
		expect(mocks.notifyJoinFailure).toHaveBeenCalledWith("session-1");
		expect(order).toEqual(["record", "notify"]);
	});

	it("does not tell the inviter again when the failure is delivered again", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "FAILED",
			endReason: "NOT_ADMITTED",
			streamGeneration: 0,
		});

		await POST(couldNotJoin("request_to_join_denied"));

		expect(mocks.notifyJoinFailure).not.toHaveBeenCalled();
	});

	it("tells nobody about a session that had already ended", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "JOINING",
			streamGeneration: 0,
		});
		mocks.updateMany.mockResolvedValue({ count: 0 });

		const response = await POST(couldNotJoin("request_to_join_denied"));

		expect(response.status).toBe(200);
		expect(mocks.notifyJoinFailure).not.toHaveBeenCalled();
	});

	it("explains a join the organizer declined", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "JOINING",
			streamGeneration: 0,
		});

		await POST(couldNotJoin("request_to_join_denied"));

		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					endReason: "NOT_ADMITTED",
					lastError:
						"The meeting organizer declined Parlume's request to join.",
				}),
			}),
		);
	});

	it("names the sub type of a join failure it does not know", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "JOINING",
			streamGeneration: 0,
		});

		await POST(couldNotJoin("some_new_reason"));

		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					endReason: "START_FAILED",
					lastError:
						"Parlume could not join the meeting (some_new_reason).",
				}),
			}),
		);
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
		expect(mocks.notifyJoinFailure).toHaveBeenCalledWith("session-1");
	});

	it("tells nobody that a bot which was in the meeting has left", async () => {
		await POST(ended());

		expect(mocks.notifyJoinFailure).not.toHaveBeenCalled();
	});
});

describe("Parlume terminal callback for a bot that never opened a stream", () => {
	// Staging: invited, left waiting in the lobby (JOINING), stopped there,
	// which set LEAVING/STOPPED; Attendee then reported the bot completed. No
	// media stream ever authenticated, so no stream close can follow and the
	// session must finalize on this callback instead of waiting for one.
	const stoppedInLobby = {
		...active,
		status: "LEAVING",
		endReason: "STOPPED",
		leaveRequestedAt: new Date("2026-10-26T17:54:05Z"),
		streamClosedAt: null,
		streamGeneration: 0,
	};

	it("finalizes a bot stopped in the lobby at once, keeping the stop reason", async () => {
		mocks.findFirst.mockResolvedValue(stoppedInLobby);
		mocks.finalize.mockResolvedValue(undefined);

		const response = await POST(ended());

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "session-1", streamGeneration: 0 },
			data: {
				status: "LEAVING",
				endReason: "STOPPED",
				terminalCallbackAt: expect.any(Date),
			},
		});
		expect(mocks.closeBridge).not.toHaveBeenCalled();
		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			expectedStreamGeneration: 0,
		});
	});

	it("finalizes the same way when Attendee reports the stopped bot as failed", async () => {
		mocks.findFirst.mockResolvedValue(stoppedInLobby);
		mocks.finalize.mockResolvedValue(undefined);

		await POST(fatalError());

		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "LEAVING",
					endReason: "STOPPED",
				}),
			}),
		);
		expect(mocks.closeBridge).not.toHaveBeenCalled();
		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			expectedStreamGeneration: 0,
		});
	});

	it("finalizes a failed bot that left the lobby on its own without waiting for a stream", async () => {
		mocks.findFirst.mockResolvedValue({
			...stoppedInLobby,
			endReason: null,
			leaveRequestedAt: null,
		});
		mocks.finalize.mockResolvedValue(undefined);

		await POST(fatalError());

		expect(mocks.closeBridge).not.toHaveBeenCalled();
		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			preserveFailure: true,
			expectedStreamGeneration: 0,
		});
	});

	it("asks Attendee to redeliver when that finalization fails", async () => {
		mocks.findFirst.mockResolvedValue(stoppedInLobby);
		mocks.finalize.mockRejectedValue(new Error("database unavailable"));

		const response = await POST(ended());

		expect(response.status).toBe(503);
	});

	it("still waits for a stream that opened and has not closed", async () => {
		mocks.findFirst.mockResolvedValue({
			...stoppedInLobby,
			streamGeneration: 1,
		});

		await POST(ended());

		expect(mocks.closeBridge).toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
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
	it.each(["PENDING", "READY", "UNAVAILABLE"])(
		"leaves known channel messages to Graph while routing is %s",
		async (channelChatStatus) => {
			mocks.findFirst.mockResolvedValue({
				id: "session-1",
				channelChatStatus,
				meetingUrl:
					"https://teams.microsoft.com/l/meetup-join/19%3Aexample%40thread.tacv2/1700000000000",
			});
			const response = await POST(chatMessage());
			expect(response.status).toBe(200);
			expect(mocks.sendChat).not.toHaveBeenCalled();
		},
	);
	it.each(["ATTENDEE", "UNRESOLVED"])(
		"keeps signed provider chat for %s fallback",
		async (channelChatStatus) => {
			mocks.findFirst.mockResolvedValue({
				id: "session-1",
				channelChatStatus,
				meetingUrl: "https://teams.microsoft.com/meet/1234567890123",
			});
			await POST(chatMessage());
			expect(mocks.sendChat).toHaveBeenCalledTimes(1);
		},
	);
	it("keeps provider chat while an unproven numeric short link is initially resolving", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "session-1",
			channelChatStatus: "PENDING",
			meetingUrl: "https://teams.microsoft.com/meet/1234567890123",
		});
		await POST(chatMessage());
		expect(mocks.sendChat).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ channelId: "19:example@thread.tacv2" },
		{ channelRootMessageId: "1700000000000" },
	])(
		"uses persisted channel binding when the invitation URL is absent: %j",
		async (binding) => {
			mocks.findFirst.mockResolvedValue({
				id: "session-1",
				channelChatStatus: "UNRESOLVED",
				meetingUrl: null,
				...binding,
			});
			await POST(chatMessage());
			expect(mocks.sendChat).not.toHaveBeenCalled();
		},
	);
	it.each([
		"https://teams.microsoft.com/l/meetup-join/19%3Aexample%40thread.v2/0",
		"https://example.com/l/meetup-join/19%3Aexample%40thread.tacv2/1700000000000",
	])(
		"does not infer channel ownership from an ordinary or foreign URL: %s",
		async (meetingUrl) => {
			mocks.findFirst.mockResolvedValue({
				id: "session-1",
				channelChatStatus: "PENDING",
				meetingUrl,
			});
			await POST(chatMessage());
			expect(mocks.sendChat).toHaveBeenCalledTimes(1);
		},
	);

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
				senderExternal: false,
				toBot: false,
				timestampMs: 1_700_000_000_000,
			},
		});
	});

	it("marks a message from an external guest, so the bridge takes no command from it", async () => {
		await POST(
			chatMessage({
				sender_name: "Visitor (Guest)",
				sender_uuid: "8:teamsvisitor:guest-1",
			}),
		);

		expect(mocks.sendChat).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.objectContaining({ senderExternal: true }),
			}),
		);
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

function participantEvent(
	eventType: "join" | "leave",
	overrides: Record<string, unknown> = {},
) {
	return webhook(
		{
			trigger: "participant_events.join_leave",
			data: {
				id: "evt_2",
				participant_name: "Visitor (Guest)",
				participant_uuid: "8:teamsvisitor:guest-1",
				participant_user_uuid: null,
				participant_is_host: false,
				event_type: eventType,
				event_data: {},
				timestamp_ms: 1_700_000_000_123,
				...overrides,
			},
		},
		"callback-secret",
	);
}

describe("Parlume participant joins and leaves", () => {
	const live = {
		id: "session-1",
		status: "ACTIVE",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "inviter-1",
		providerBotId: "bot-1",
		streamGeneration: 2,
		guestJoinedAt: null,
		meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
		channelId: null,
		channelRootMessageId: null,
		channelChatStatus: "ATTENDEE",
	};
	const member = {
		participant_name: "Dev One",
		participant_uuid: "8:orgid:00000000-0000-4000-8000-000000000001",
	};
	// When Attendee saw the join or leave, as `participantEvent` sends it.
	const seen = 1_700_000_000_123;

	const relays = () =>
		mocks.sendGuests.mock.calls.map(([relay]) => ({
			updates: relay.updates,
			placing: relay.placing,
		}));

	beforeEach(() => {
		mocks.findFirst.mockResolvedValue(live);
		mocks.sendGuests.mockResolvedValue(undefined);
		mocks.confirmAttendee.mockResolvedValue(null);
		mocks.channelMeeting.mockReturnValue(false);
		mocks.departureNotice.mockReturnValue("I'm leaving: example.");
		mocks.leave.mockResolvedValue({ kind: "left" });
	});

	it("silences the bridge before the lookup, then refuses someone it cannot confirm, says why and leaves", async () => {
		const response = await POST(participantEvent("join"));

		expect(response.status).toBe(200);
		expect(mocks.confirmAttendee).toHaveBeenCalledWith({
			session: live,
			participant: {
				id: "8:teamsvisitor:guest-1",
				userId: null,
				name: "Visitor (Guest)",
			},
		});
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "session-1", guestJoinedAt: null },
			data: { guestJoinedAt: expect.any(Date) },
		});
		expect(mocks.sendGuests).toHaveBeenCalledWith(
			expect.objectContaining({
				settings: { bridgeUrl: "wss://bridge.example" },
				sessionId: "session-1",
			}),
		);
		expect(relays()).toEqual([
			{
				updates: [],
				placing: [
					{ id: "8:teamsvisitor:guest-1", pending: true, at: seen },
				],
			},
			{
				updates: [{ id: "8:teamsvisitor:guest-1", joined: true }],
				placing: [
					{ id: "8:teamsvisitor:guest-1", pending: false, at: seen },
				],
			},
		]);
		expect(mocks.sendGuests.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.confirmAttendee.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.departureNotice).toHaveBeenCalledWith({
			kind: "attendee",
			name: "Visitor (Guest)",
		});
		expect(mocks.leave).toHaveBeenCalledWith({
			session: {
				id: "session-1",
				providerBotId: "bot-1",
				streamGeneration: 2,
			},
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice: "I'm leaving: example.",
		});
		expect(mocks.sendGuests.mock.invocationCallOrder[1]).toBeLessThan(
			mocks.leave.mock.invocationCallOrder[0] ?? 0,
		);
		// Marked a guest by the same outcome the bridge is told next.
		expect(mocks.recordSpeakerMark).toHaveBeenCalledWith({
			sessionId: "session-1",
			participantId: "8:teamsvisitor:guest-1",
			mark: "guest",
		});
		expect(
			mocks.recordSpeakerMark.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.sendGuests.mock.invocationCallOrder[1] ?? 0);
	});

	it("marks a signed-in participant Fabric could not confirm a guest, and relays them as one", async () => {
		const outside = {
			participant_name: "Pat Example",
			participant_uuid: "8:orgid:00000000-0000-4000-8000-000000000002",
		};

		await POST(participantEvent("join", outside));

		expect(mocks.recordSpeakerMark).toHaveBeenCalledWith({
			sessionId: "session-1",
			participantId: outside.participant_uuid,
			mark: "guest",
		});
		expect(relays()[1]?.updates).toEqual([
			{ id: outside.participant_uuid, joined: true },
		]);
		expect(mocks.recordAttendee).not.toHaveBeenCalled();
	});

	it("tells the bridge a confirmed project reader joined, by their Fabric account, and stays", async () => {
		mocks.confirmAttendee.mockResolvedValue("user-2");

		const response = await POST(participantEvent("join", member));

		expect(response.status).toBe(200);
		expect(relays()[1]).toEqual({
			updates: [],
			placing: [
				{
					id: member.participant_uuid,
					pending: false,
					userId: "user-2",
					at: seen,
				},
			],
		});
		expect(mocks.updateMany).not.toHaveBeenCalled();
		expect(mocks.leave).not.toHaveBeenCalled();
		// A verified attendee: a reader of the meeting's confidential part.
		expect(mocks.recordAttendee).toHaveBeenCalledWith({
			sessionId: "session-1",
			userId: "user-2",
		});
		expect(mocks.recordAttendee.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.sendGuests.mock.invocationCallOrder[1] ?? 0,
		);
		expect(mocks.recordSpeakerMark).toHaveBeenCalledWith({
			sessionId: "session-1",
			participantId: member.participant_uuid,
			mark: "member",
		});
	});

	it("tells the bridge someone left, without checking them or recording a join", async () => {
		await POST(participantEvent("leave"));

		expect(mocks.confirmAttendee).not.toHaveBeenCalled();
		expect(mocks.updateMany).not.toHaveBeenCalled();
		expect(mocks.recordSpeakerMark).not.toHaveBeenCalled();
		expect(relays()).toEqual([
			{
				updates: [{ id: "8:teamsvisitor:guest-1", joined: false }],
				placing: [
					{ id: "8:teamsvisitor:guest-1", pending: false, at: seen },
				],
			},
		]);
		expect(mocks.leave).not.toHaveBeenCalled();
	});

	it("relays an event Attendee sent without a time without one", async () => {
		await POST(participantEvent("leave", { timestamp_ms: undefined }));

		expect(relays()[0]?.placing).toEqual([
			{ id: "8:teamsvisitor:guest-1", pending: false },
		]);
	});

	// No scope lists a channel's members, so its chat cannot be checked.
	it("leaves a channel meeting at the first join, without looking anyone up", async () => {
		mocks.channelMeeting.mockReturnValue(true);

		await POST(participantEvent("join", member));

		expect(mocks.confirmAttendee).not.toHaveBeenCalled();
		expect(mocks.recordSpeakerMark).toHaveBeenCalledWith({
			sessionId: "session-1",
			participantId: member.participant_uuid,
			mark: "guest",
		});
		expect(relays()).toEqual([
			{
				updates: [{ id: member.participant_uuid, joined: true }],
				placing: [
					{ id: member.participant_uuid, pending: false, at: seen },
				],
			},
		]);
		expect(mocks.departureNotice).toHaveBeenCalledWith({ kind: "channel" });
		expect(mocks.leave).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "ATTENDEE_NOT_AUTHORIZED" }),
		);
	});

	it("does not ask to leave again once Parlume is leaving", async () => {
		mocks.findFirst.mockResolvedValue({ ...live, status: "LEAVING" });

		await POST(participantEvent("join"));

		expect(mocks.sendGuests).toHaveBeenCalled();
		expect(mocks.leave).not.toHaveBeenCalled();
	});

	it("asks Attendee to redeliver, without a lookup, when the bridge cannot be silenced first", async () => {
		mocks.sendGuests.mockRejectedValue(new Error("bridge down"));

		const response = await POST(participantEvent("join"));

		expect(response.status).toBe(503);
		expect(mocks.confirmAttendee).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"callback.guest_forward_failed",
			expect.objectContaining({ sessionId: "session-1" }),
		);
	});

	it("asks Attendee to redeliver when the bridge cannot take the outcome", async () => {
		mocks.sendGuests
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("bridge down"));

		const response = await POST(participantEvent("join", member));

		expect(response.status).toBe(503);
	});
});
