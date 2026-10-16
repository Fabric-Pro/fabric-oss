import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	armParlumeMeetingBridge,
	closeParlumeMeetingBridge,
	deleteParlumeMeetingBotData,
	getParlumeBridgeSettings,
	isTeamsMeetingUrl,
	leaveParlumeMeetingBot,
	sendParlumeMeetingChat,
	sendParlumeSpeakerUpdates,
	startParlumeMeetingBot,
} from "../parlume-attendee";

const settings = {
	apiKey: "operator-key",
	bridgeUrl: "wss://bridge.fabric.example/live",
	callbackUrl: "https://fabric.example/api/internal/parlume/callback",
	serviceSecret: "service-secret",
};

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
});

afterEach(() => {
	fetchMock.mockReset();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

function requestBody(call: number): unknown {
	return JSON.parse(String(fetchMock.mock.calls[call]?.[1]?.body));
}

describe("getParlumeBridgeSettings", () => {
	function configure() {
		vi.stubEnv("PARLUME_ATTENDEE_API_KEY", "operator-key");
		vi.stubEnv("AGENT_SERVICE_SECRET", "service-secret");
		vi.stubEnv("NEXT_PUBLIC_PARTYKIT_HOST", "bridge.fabric.example");
		vi.stubEnv("APP_URL", "https://staging.fabric.example");
	}

	it("derives public bridge and callback endpoints from Fabric's canonical staging URLs", () => {
		configure();

		expect(getParlumeBridgeSettings()).toEqual({
			apiKey: "operator-key",
			bridgeUrl: "wss://bridge.fabric.example/parties/parlume",
			callbackUrl:
				"https://staging.fabric.example/api/internal/parlume/callback",
			serviceSecret: "service-secret",
		});
	});

	it("is not ready without the Attendee API key", () => {
		configure();
		vi.stubEnv("PARLUME_ATTENDEE_API_KEY", "");

		expect(getParlumeBridgeSettings()).toBeNull();
	});

	it("is not ready when the bridge or callback is not served over TLS", () => {
		configure();
		// A refusal fixture: the settings must reject it, and nothing connects to it.
		// nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
		vi.stubEnv("PARLUME_BRIDGE_WS_URL", "ws://bridge.fabric.example/live");
		expect(getParlumeBridgeSettings()).toBeNull();

		vi.stubEnv("PARLUME_BRIDGE_WS_URL", "");
		vi.stubEnv(
			"PARLUME_CALLBACK_URL",
			"http://fabric.example/api/internal/parlume/callback",
		);
		expect(getParlumeBridgeSettings()).toBeNull();
	});
});

describe("startParlumeMeetingBot", () => {
	const hardStopAt = new Date("2030-01-01T04:00:00.000Z");

	function start() {
		return startParlumeMeetingBot({
			settings,
			sessionId: "session-1",
			meetingUrl: "https://teams.microsoft.com/meet/123456?p=abc",
			streamToken: "stream-token",
			callbackSecret: "callback-secret",
			hardStopAt,
		});
	}

	it("creates an Attendee bot that streams audio both ways and reports back by webhook", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ id: "bot_abc123", state: "ready" }), {
				status: 201,
			}),
		);

		await expect(start()).resolves.toBe("bot_abc123");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://app.attendee.dev/api/v1/bots");
		expect(init).toMatchObject({
			method: "POST",
			headers: {
				Authorization: "Token operator-key",
				"content-type": "application/json",
			},
		});
		expect(requestBody(0)).toEqual({
			bot_name: "Fabric Parlume",
			meeting_url: "https://teams.microsoft.com/meet/123456?p=abc",
			metadata: { parlume_session_id: "session-1" },
			deduplication_key: "parlume-session-1",
			recording_settings: {
				format: "none",
				record_participant_speech_start_stop_events: true,
			},
			websocket_settings: {
				audio: {
					url: "wss://bridge.fabric.example/live/session-1?token=stream-token",
					sample_rate: 16_000,
				},
			},
			webhooks: [
				{
					url: "https://fabric.example/api/internal/parlume/callback?sessionId=session-1&token=callback-secret",
					triggers: [
						"bot.state_change",
						"participant_events.speech_start_stop",
					],
				},
			],
			automatic_leave_settings: {
				waiting_room_timeout_seconds: 180,
				only_participant_in_meeting_timeout_seconds: 180,
				// Four hours to the hard stop, plus the two-minute backstop.
				max_uptime_seconds: 4 * 60 * 60 + 120,
			},
		});
	});

	it("never asks Attendee for a non-positive uptime", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ id: "bot_abc123" }), { status: 201 }),
		);

		await startParlumeMeetingBot({
			settings,
			sessionId: "session-1",
			meetingUrl: "https://teams.microsoft.com/meet/123456?p=abc",
			streamToken: "stream-token",
			callbackSecret: "callback-secret",
			hardStopAt: new Date("2029-12-31T00:00:00.000Z"),
		});

		expect(requestBody(0)).toMatchObject({
			automatic_leave_settings: { max_uptime_seconds: 121 },
		});
	});

	it("relays the field Attendee rejected without echoing the request", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					bot_name: ["Bot name cannot contain emojis."],
				}),
				{ status: 400 },
			),
		);

		const failure = await start().catch((error: Error) => error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe(
			'Attendee request failed with HTTP 400. {"bot_name":["Bot name cannot contain emojis."]}',
		);
		expect((failure as Error).message).not.toContain("meet/123456");
	});

	it("relays Attendee's error message when it sends one", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({ error: "Deduplication key already in use." }),
				{ status: 400 },
			),
		);

		await expect(start()).rejects.toThrow(
			"Attendee request failed with HTTP 400. Deduplication key already in use.",
		);
	});

	it("fails when the response carries no bot id", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ state: "ready" }), { status: 201 }),
		);

		await expect(start()).rejects.toThrow("Attendee returned no bot id.");
	});
});

describe("media bridge control", () => {
	it("arms the session watchdog before a billable bot is created", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

		await expect(
			armParlumeMeetingBridge({
				settings,
				sessionId: "session-1",
				hardStopAt: new Date("2030-01-01T00:00:00.000Z"),
			}),
		).resolves.toBeUndefined();

		expect(fetchMock).toHaveBeenCalledWith(
			"https://bridge.fabric.example/live/session-1",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer service-secret",
				}),
			}),
		);
	});

	it("tells the bridge to close the stream of a bot that is gone", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

		await closeParlumeMeetingBridge({ settings, sessionId: "session-1" });

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://bridge.fabric.example/live/session-1?action=close",
		);
		expect(init.headers).toEqual({
			Authorization: "Bearer service-secret",
		});
	});

	it("hands the bridge who started and stopped speaking", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

		await sendParlumeSpeakerUpdates({
			settings,
			sessionId: "session-1",
			updates: [
				{
					name: "Dev One",
					id: "participant-1",
					timestamp: 1_700_000_000_000,
					isSpeaking: true,
				},
			],
		});

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://bridge.fabric.example/live/session-1?action=speakers",
		);
		expect(init.headers).toMatchObject({
			Authorization: "Bearer service-secret",
		});
		expect(requestBody(0)).toEqual({
			updates: [
				{
					name: "Dev One",
					id: "participant-1",
					timestamp: 1_700_000_000_000,
					isSpeaking: true,
				},
			],
		});
	});

	it("reports a bridge that refuses a speaker update", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

		await expect(
			sendParlumeSpeakerUpdates({
				settings,
				sessionId: "session-1",
				updates: [],
			}),
		).rejects.toThrow("Parlume media bridge is unavailable.");
	});
});

describe("deleteParlumeMeetingBotData", () => {
	it("deletes provider artifacts only through the operator credential", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

		await deleteParlumeMeetingBotData({
			settings,
			providerBotId: "bot_abc123",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://app.attendee.dev/api/v1/bots/bot_abc123/delete_data",
			expect.objectContaining({
				method: "POST",
				headers: { Authorization: "Token operator-key" },
			}),
		);
	});

	it("reports a refusal so finalization retries the deletion", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: "Cannot delete data for a bot in state joined_recording",
				}),
				{ status: 400 },
			),
		);

		await expect(
			deleteParlumeMeetingBotData({
				settings,
				providerBotId: "bot_abc123",
			}),
		).rejects.toThrow("HTTP 400");
	});
});

describe("sendParlumeMeetingChat", () => {
	it("posts to everyone without characters Attendee refuses", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

		await sendParlumeMeetingChat({
			settings,
			providerBotId: "bot_abc123",
			message: "The project is on track \u{1F680} for release.",
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://app.attendee.dev/api/v1/bots/bot_abc123/send_chat_message",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Token operator-key",
				}),
			}),
		);
		expect(requestBody(0)).toEqual({
			to: "everyone",
			message: "The project is on track  for release.",
		});
	});

	it("cuts a long message after stripping, so the cut cannot split a pair", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

		await sendParlumeMeetingChat({
			settings,
			providerBotId: "bot_abc123",
			message: `${"a".repeat(4_095)}\u{1F680}${"b".repeat(10)}`,
		});

		const body = requestBody(0) as { message: string };
		expect(body.message).toBe(`${"a".repeat(4_095)}b`);
	});

	it("reports a meeting that refuses chat", async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: "Bot is in state ended and cannot send chat messages",
				}),
				{ status: 400 },
			),
		);

		await expect(
			sendParlumeMeetingChat({
				settings,
				providerBotId: "bot_abc123",
				message: "Hello",
			}),
		).rejects.toThrow("HTTP 400");
	});
});

describe("leaveParlumeMeetingBot", () => {
	function stateResponse(state: string, id = "bot_abc123") {
		return new Response(JSON.stringify({ id, state }), { status: 200 });
	}

	it("asks the bot to leave", async () => {
		fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

		await expect(
			leaveParlumeMeetingBot({ settings, providerBotId: "bot_abc123" }),
		).resolves.toEqual({ kind: "LEAVE_REQUESTED" });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://app.attendee.dev/api/v1/bots/bot_abc123/leave",
			expect.objectContaining({
				method: "POST",
				headers: { Authorization: "Token operator-key" },
			}),
		);
	});

	it.each([
		["post_processing", { kind: "TERMINAL", status: "completed" }],
		["ended", { kind: "TERMINAL", status: "completed" }],
		["data_deleted", { kind: "TERMINAL", status: "completed" }],
		["fatal_error", { kind: "TERMINAL", status: "failed" }],
		["leaving", { kind: "LEAVE_REQUESTED" }],
	])(
		"recovers a bot Attendee refuses to leave from its %s state",
		async (state, expected) => {
			fetchMock
				.mockResolvedValueOnce(new Response("{}", { status: 400 }))
				.mockResolvedValueOnce(stateResponse(state));

			await expect(
				leaveParlumeMeetingBot({
					settings,
					providerBotId: "bot_abc123",
				}),
			).resolves.toEqual(expected);

			expect(fetchMock).toHaveBeenNthCalledWith(
				2,
				"https://app.attendee.dev/api/v1/bots/bot_abc123",
				expect.objectContaining({
					headers: { Authorization: "Token operator-key" },
				}),
			);
		},
	);

	it("fails when the refusal is not explained by a bot that is leaving or gone", async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "Cannot leave" }), {
					status: 400,
				}),
			)
			.mockResolvedValueOnce(stateResponse("ready"));

		await expect(
			leaveParlumeMeetingBot({ settings, providerBotId: "bot_abc123" }),
		).rejects.toThrow("HTTP 400. Cannot leave");
	});

	it("fails closed when the state read back names a different bot", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response("{}", { status: 400 }))
			.mockResolvedValueOnce(stateResponse("ended", "bot_other"));

		await expect(
			leaveParlumeMeetingBot({ settings, providerBotId: "bot_abc123" }),
		).rejects.toThrow("HTTP 400");
	});

	it("fails when the state cannot be read back", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response("{}", { status: 400 }))
			.mockResolvedValueOnce(new Response("{}", { status: 500 }));

		await expect(
			leaveParlumeMeetingBot({ settings, providerBotId: "bot_abc123" }),
		).rejects.toThrow("HTTP 400");
	});

	it("does not look for a terminal bot behind any other refusal", async () => {
		fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));

		await expect(
			leaveParlumeMeetingBot({ settings, providerBotId: "bot_abc123" }),
		).rejects.toThrow("HTTP 404");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("isTeamsMeetingUrl", () => {
	it("accepts Teams meeting links over HTTPS only", () => {
		expect(
			isTeamsMeetingUrl("https://teams.microsoft.com/meet/123456?p=abc"),
		).toBe(true);
		expect(
			isTeamsMeetingUrl(
				"https://teams.microsoft.com/l/meetup-join/example",
			),
		).toBe(true);
		expect(isTeamsMeetingUrl("http://teams.microsoft.com/meet/1")).toBe(
			false,
		);
		expect(isTeamsMeetingUrl("https://zoom.example/j/123")).toBe(false);
	});
});
