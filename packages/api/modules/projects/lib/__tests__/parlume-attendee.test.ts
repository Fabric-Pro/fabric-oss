import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	armParlumeMeetingBridge,
	checkAttendeeConnection,
	closeParlumeMeetingBridge,
	deleteParlumeMeetingBotData,
	getAttendeeBaseUrlBlockReason,
	getEnvironmentAttendeeSettings,
	getParlumeBridgeSettings,
	isTeamsMeetingUrl,
	leaveParlumeMeetingBot,
	normalizeAttendeeBaseUrl,
	noteParlumeLeaving,
	PARLUME_ATTENDEE_ALLOWED_HOSTS_ENV,
	type ParlumeAttendeeSettings,
	ParlumeBridgeUnavailableError,
	ParlumeProviderError,
	purgeParlumeBridgeStorage,
	sendParlumeChatMessage,
	sendParlumeGuestUpdates,
	sendParlumeLiveControl,
	sendParlumeMeetingChat,
	sendParlumeSpeakerUpdates,
	startParlumeMeetingBot,
	waitForParlumeBotInCall,
} from "../parlume-attendee";

const settings = {
	bridgeUrl: "wss://bridge.fabric.example/live",
	callbackUrl: "https://fabric.example/api/internal/parlume/callback",
	serviceSecret: "service-secret",
};

const attendee: ParlumeAttendeeSettings = {
	apiKey: "operator-key",
	baseUrl: "https://app.attendee.dev",
	teamsLoginMode: null,
	teamsLoginGroup: null,
	webhookSecret: null,
	source: "environment",
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
			bridgeUrl: "wss://bridge.fabric.example/parties/parlume",
			callbackUrl:
				"https://staging.fabric.example/api/internal/parlume/callback",
			serviceSecret: "service-secret",
		});
	});

	it("needs no Attendee key: the bridge is the operator's alone", () => {
		configure();
		vi.stubEnv("PARLUME_ATTENDEE_API_KEY", "");

		expect(getParlumeBridgeSettings()).not.toBeNull();
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

	function start(overrides: Partial<ParlumeAttendeeSettings> = {}) {
		return startParlumeMeetingBot({
			settings,
			attendee: { ...attendee, ...overrides },
			sessionId: "session-1",
			meetingUrl: "https://teams.microsoft.com/meet/123456?p=abc",
			streamToken: "stream-token",
			callbackToken: "callback-token",
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
			transcription_settings: { enabled: false },
			websocket_settings: {
				audio: {
					url: "wss://bridge.fabric.example/live/session-1?token=stream-token",
					sample_rate: 16_000,
				},
			},
			webhooks: [
				{
					url: "https://fabric.example/api/internal/parlume/callback?sessionId=session-1&token=callback-token",
					triggers: [
						"bot.state_change",
						"participant_events.speech_start_stop",
						"participant_events.join_leave",
						"chat_messages.update",
					],
				},
			],
			automatic_leave_settings: {
				// Five minutes in the lobby; three alone.
				waiting_room_timeout_seconds: 300,
				only_participant_in_meeting_timeout_seconds: 180,
				// Four hours to the hard stop, plus the two-minute backstop.
				max_uptime_seconds: 4 * 60 * 60 + 120,
			},
		});
	});

	it("asks Attendee to transcribe nothing, so it keeps no captions of the meeting", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ id: "bot_abc123" }), { status: 201 }),
		);

		await start();

		const body = requestBody(0);
		expect(body).toMatchObject({
			transcription_settings: { enabled: false },
		});
		// Parlume's own transcript still needs the audio and the speech events.
		expect(body).toMatchObject({
			recording_settings: {
				record_participant_speech_start_stop_events: true,
			},
			websocket_settings: { audio: { sample_rate: 16_000 } },
		});
	});

	it.each(["always", "only_if_required"] as const)(
		"signs the bot in to Teams when the settings say %s",
		async (mode) => {
			fetchMock.mockResolvedValue(
				new Response(JSON.stringify({ id: "bot_abc123" }), {
					status: 201,
				}),
			);

			await start({ teamsLoginMode: mode });

			expect(requestBody(0)).toMatchObject({
				teams_settings: { use_login: true, login_mode: mode },
			});
			// Without a group, Attendee uses the project's oldest one.
			expect(requestBody(0)).not.toHaveProperty(
				"teams_settings.login_group_name",
			);
		},
	);

	it("signs the bot in with the organization's own Teams login group", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ id: "bot_abc123" }), { status: 201 }),
		);

		await start({
			teamsLoginMode: "always",
			teamsLoginGroup: "example-org bot",
			source: "organization",
		});

		expect(requestBody(0)).toMatchObject({
			teams_settings: {
				use_login: true,
				login_mode: "always",
				login_group_name: "example-org bot",
			},
		});
	});

	it("sends no login group for an anonymous bot", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ id: "bot_abc123" }), { status: 201 }),
		);

		await start({ teamsLoginGroup: "example-org bot" });

		expect(requestBody(0)).not.toHaveProperty("teams_settings");
	});

	it("joins as an anonymous guest when no Teams login is configured", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ id: "bot_abc123" }), { status: 201 }),
		);

		await start();

		expect(requestBody(0)).not.toHaveProperty("teams_settings");
	});

	it("creates the bot on a self-hosted Attendee with that instance's key", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ id: "bot_abc123" }), { status: 201 }),
		);

		await start({
			apiKey: "organization-key",
			baseUrl: "https://attendee.example.com/proxy",
			source: "organization",
		});

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://attendee.example.com/proxy/api/v1/bots");
		expect(init).toMatchObject({
			headers: { Authorization: "Token organization-key" },
			// The key must not follow a redirect somewhere nobody declared.
			redirect: "error",
		});
	});

	it("refuses an internal Attendee address before the key leaves Fabric", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv(PARLUME_ATTENDEE_ALLOWED_HOSTS_ENV, "");

		await expect(
			start({ baseUrl: "https://169.254.169.254" }),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("never asks Attendee for a non-positive uptime", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ id: "bot_abc123" }), { status: 201 }),
		);

		await startParlumeMeetingBot({
			settings,
			attendee,
			sessionId: "session-1",
			meetingUrl: "https://teams.microsoft.com/meet/123456?p=abc",
			streamToken: "stream-token",
			callbackToken: "callback-token",
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

		expect(failure).toBeInstanceOf(ParlumeProviderError);
		expect((failure as ParlumeProviderError).message).toBe(
			'Attendee request failed with HTTP 400. {"bot_name":["Bot name cannot contain emojis."]}',
		);
		expect((failure as ParlumeProviderError).status).toBe(400);
		expect((failure as ParlumeProviderError).detail).toBe(
			'{"bot_name":["Bot name cannot contain emojis."]}',
		);
		expect((failure as Error).message).not.toContain("meet/123456");
	});

	it("masks the key should Attendee ever quote it", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: "Bad token operator-key" }), {
				status: 400,
			}),
		);

		const failure = await start().catch((error: Error) => error);

		expect((failure as Error).message).not.toContain("operator-key");
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
				chatTagStart: 6,
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
		const [, init] = fetchMock.mock.calls[0] ?? [];
		expect(JSON.parse(init.body)).toEqual({
			hardStopAt: "2030-01-01T00:00:00.000Z",
			chatTagStart: 6,
		});
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

	it("tells the bridge the bot is about to leave, and reports a refusal as the bridge being unavailable", async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ posted: true }));

		await noteParlumeLeaving({ settings, sessionId: "session-1" });

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://bridge.fabric.example/live/session-1?action=leaving",
		);
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			"content-type": "application/json",
			Authorization: "Bearer service-secret",
		});
		expect(requestBody(0)).toEqual({});

		fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
		await expect(
			noteParlumeLeaving({ settings, sessionId: "session-1" }),
		).rejects.toThrow(ParlumeBridgeUnavailableError);
	});

	it("hands the bridge why Parlume is leaving, to post before the leaving line", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json({ posted: true, noticed: true }),
		);

		await expect(
			noteParlumeLeaving({
				settings,
				sessionId: "session-1",
				notice: "I'm leaving: example.",
			}),
		).resolves.toBe(true);

		expect(requestBody(0)).toEqual({ notice: "I'm leaving: example." });
	});

	it("reports a notice the bridge could not post", async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json({ posted: false, noticed: false }),
		);

		await expect(
			noteParlumeLeaving({
				settings,
				sessionId: "session-1",
				notice: "I'm leaving: example.",
			}),
		).resolves.toBe(false);
	});

	// The bridge's own calls that lead to a leave allow 15 seconds in all.
	it("gives up on the leaving line after four seconds", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout");
		fetchMock.mockResolvedValueOnce(Response.json({ posted: true }));

		await noteParlumeLeaving({ settings, sessionId: "session-1" });

		expect(timeout).toHaveBeenCalledWith(4_000);
		timeout.mockRestore();
	});

	it("asks the bridge to purge a finished session's storage, and reads a refusal while a stream is connected", async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ purged: true }));

		await expect(
			purgeParlumeBridgeStorage({ settings, sessionId: "session-1" }),
		).resolves.toEqual({ purged: true });

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://bridge.fabric.example/live/session-1?action=purge",
		);
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			Authorization: "Bearer service-secret",
		});

		fetchMock.mockResolvedValueOnce(
			Response.json({ purged: false }, { status: 409 }),
		);
		await expect(
			purgeParlumeBridgeStorage({ settings, sessionId: "session-1" }),
		).resolves.toEqual({ purged: false });

		fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
		await expect(
			purgeParlumeBridgeStorage({ settings, sessionId: "session-1" }),
		).rejects.toThrow(ParlumeBridgeUnavailableError);
	});

	it("hands the bridge a page control with the member it is for, and reads back whether it changed anything", async () => {
		fetchMock.mockResolvedValue(Response.json({ changed: true }));

		const result = await sendParlumeLiveControl({
			settings,
			sessionId: "session-1",
			control: "pause",
			actor: { id: "user-1", name: "Dana Member" },
		});

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://bridge.fabric.example/live/session-1?action=pause",
		);
		expect(JSON.parse(init.body)).toEqual({
			actor: { id: "user-1", name: "Dana Member" },
		});
		expect(result).toEqual({ changed: true });
	});

	it("reports a page control the bridge refused as the bridge being unavailable", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

		await expect(
			sendParlumeLiveControl({
				settings,
				sessionId: "session-1",
				control: "stop-speech",
				actor: { id: "user-1", name: null },
			}),
		).rejects.toThrow(ParlumeBridgeUnavailableError);
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

	it("hands the bridge a meeting chat message", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
		const message = {
			id: "msg_1",
			text: "@Fabric Parlume what changed?",
			senderName: "Dev One",
			senderId: "participant-1",
			toBot: false,
			timestampMs: 1_700_000_000_000,
		};

		await sendParlumeChatMessage({
			settings,
			sessionId: "session-1",
			message,
		});

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://bridge.fabric.example/live/session-1?action=chat-message",
		);
		expect(init.headers).toMatchObject({
			Authorization: "Bearer service-secret",
		});
		expect(requestBody(0)).toEqual(message);
	});

	it("hands the bridge the guests who joined or left, and its checks", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
		const updates = [{ id: "8:teamsvisitor:guest-1", joined: true }];
		const placing = [
			{ id: "8:orgid:member", pending: false, userId: "user-2" },
		];

		await sendParlumeGuestUpdates({
			settings,
			sessionId: "session-1",
			updates,
			placing,
		});

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://bridge.fabric.example/live/session-1?action=guests",
		);
		expect(init.headers).toMatchObject({
			Authorization: "Bearer service-secret",
		});
		expect(requestBody(0)).toEqual({ updates, placing });
	});

	it("reports a bridge that refuses a chat message", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 409 }));

		await expect(
			sendParlumeChatMessage({
				settings,
				sessionId: "session-1",
				message: {
					id: "msg_1",
					text: "hello",
					senderName: null,
					senderId: null,
					toBot: false,
					timestampMs: 0,
				},
			}),
		).rejects.toThrow("Parlume media bridge is unavailable.");
	});
});

describe("deleteParlumeMeetingBotData", () => {
	it("deletes provider artifacts only through the operator credential", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

		await deleteParlumeMeetingBotData({
			attendee,
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
				attendee,
				providerBotId: "bot_abc123",
			}),
		).rejects.toThrow("HTTP 400");
	});
});

describe("sendParlumeMeetingChat", () => {
	it("posts to everyone without characters Attendee refuses", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

		await sendParlumeMeetingChat({
			attendee,
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
			message: "<p>The project is on track  for release.</p>",
		});
	});

	it("cuts a long message after stripping, so the cut cannot split a pair", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

		await sendParlumeMeetingChat({
			attendee,
			providerBotId: "bot_abc123",
			message: `${"a".repeat(4_095)}\u{1F680}${"b".repeat(10)}`,
		});

		const body = requestBody(0) as { message: string };
		expect(body.message).toBe(`<p>${"a".repeat(4_095)}b</p>`);
	});

	// Attendee's Teams bot pastes a message with HTML tags at once; plain text it
	// types a key at a time, with the meeting audio held up meanwhile.
	it("sends the text as one escaped HTML paragraph", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

		await sendParlumeMeetingChat({
			attendee,
			providerBotId: "bot_abc123",
			message: "[P3] Use <b> & keep a > b",
		});

		const body = requestBody(0) as { message: string };
		expect(body.message).toBe(
			"<p>[P3] Use &lt;b&gt; &amp; keep a &gt; b</p>",
		);
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
				attendee,
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
			leaveParlumeMeetingBot({ attendee, providerBotId: "bot_abc123" }),
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
					attendee,
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
			leaveParlumeMeetingBot({ attendee, providerBotId: "bot_abc123" }),
		).rejects.toThrow("HTTP 400. Cannot leave");
	});

	it("fails closed when the state read back names a different bot", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response("{}", { status: 400 }))
			.mockResolvedValueOnce(stateResponse("ended", "bot_other"));

		await expect(
			leaveParlumeMeetingBot({ attendee, providerBotId: "bot_abc123" }),
		).rejects.toThrow("HTTP 400");
	});

	it("fails when the state cannot be read back", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response("{}", { status: 400 }))
			.mockResolvedValueOnce(new Response("{}", { status: 500 }));

		await expect(
			leaveParlumeMeetingBot({ attendee, providerBotId: "bot_abc123" }),
		).rejects.toThrow("HTTP 400");
	});

	it("does not look for a terminal bot behind any other refusal", async () => {
		fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));

		await expect(
			leaveParlumeMeetingBot({ attendee, providerBotId: "bot_abc123" }),
		).rejects.toThrow("HTTP 404");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

// Attendee refused the notice of a guest present at entry: "Bot is in state
// joining and cannot send chat messages".
describe("waitForParlumeBotInCall", () => {
	function stateResponse(state: string) {
		return new Response(JSON.stringify({ id: "bot_abc123", state }), {
			status: 200,
		});
	}

	it("waits while the bot is joining, until it is in the call", async () => {
		fetchMock
			.mockResolvedValueOnce(stateResponse("joining"))
			.mockResolvedValueOnce(new Response("{}", { status: 503 }))
			.mockResolvedValueOnce(stateResponse("joined_recording"));

		const waiting = waitForParlumeBotInCall({
			attendee,
			providerBotId: "bot_abc123",
		});
		await vi.advanceTimersByTimeAsync(4_000);

		await expect(waiting).resolves.toBe("in_call");
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://app.attendee.dev/api/v1/bots/bot_abc123",
			expect.objectContaining({
				headers: { Authorization: "Token operator-key" },
			}),
		);
	});

	it("says the bot is gone when it left before it was in the call", async () => {
		fetchMock.mockResolvedValueOnce(stateResponse("fatal_error"));

		await expect(
			waitForParlumeBotInCall({ attendee, providerBotId: "bot_abc123" }),
		).resolves.toBe("gone");
	});

	it("gives up once the bound has passed", async () => {
		fetchMock.mockImplementation(async () => stateResponse("waiting_room"));

		const waiting = waitForParlumeBotInCall({
			attendee,
			providerBotId: "bot_abc123",
			timeoutMs: 5_000,
		});
		await vi.advanceTimersByTimeAsync(5_000);

		await expect(waiting).resolves.toBe("timeout");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});

describe("getEnvironmentAttendeeSettings", () => {
	it("is the operator's Attendee project, anonymous by default", () => {
		vi.stubEnv("PARLUME_ATTENDEE_API_KEY", "operator-key");
		vi.stubEnv("PARLUME_ATTENDEE_BASE_URL", "");
		vi.stubEnv("PARLUME_ATTENDEE_TEAMS_LOGIN", "");
		vi.stubEnv("PARLUME_ATTENDEE_WEBHOOK_SECRET", "");

		expect(getEnvironmentAttendeeSettings()).toEqual({
			apiKey: "operator-key",
			baseUrl: "https://app.attendee.dev",
			teamsLoginMode: null,
			teamsLoginGroup: null,
			webhookSecret: null,
			source: "environment",
		});
	});

	it("carries the project's webhook secret", () => {
		vi.stubEnv("PARLUME_ATTENDEE_API_KEY", "operator-key");
		vi.stubEnv(
			"PARLUME_ATTENDEE_WEBHOOK_SECRET",
			" c2VjcmV0LWZvci10ZXN0cw== ",
		);

		expect(getEnvironmentAttendeeSettings()?.webhookSecret).toBe(
			"c2VjcmV0LWZvci10ZXN0cw==",
		);
	});

	it("is absent without a key", () => {
		vi.stubEnv("PARLUME_ATTENDEE_API_KEY", "");

		expect(getEnvironmentAttendeeSettings()).toBeNull();
	});

	it.each(["always", "only_if_required"] as const)(
		"reads the Teams sign-in mode %s",
		(mode) => {
			vi.stubEnv("PARLUME_ATTENDEE_API_KEY", "operator-key");
			vi.stubEnv("PARLUME_ATTENDEE_TEAMS_LOGIN", mode);

			expect(getEnvironmentAttendeeSettings()?.teamsLoginMode).toBe(mode);
		},
	);

	it("refuses an unknown Teams sign-in mode rather than join in one nobody configured", () => {
		vi.stubEnv("PARLUME_ATTENDEE_API_KEY", "operator-key");
		vi.stubEnv("PARLUME_ATTENDEE_TEAMS_LOGIN", "sometimes");

		expect(() => getEnvironmentAttendeeSettings()).toThrow(
			"PARLUME_ATTENDEE_TEAMS_LOGIN must be always or only_if_required.",
		);
	});

	it("points at a self-hosted Attendee", () => {
		vi.stubEnv("PARLUME_ATTENDEE_API_KEY", "operator-key");
		vi.stubEnv(
			"PARLUME_ATTENDEE_BASE_URL",
			"https://attendee.example.com/api/v1/",
		);

		expect(getEnvironmentAttendeeSettings()?.baseUrl).toBe(
			"https://attendee.example.com",
		);
	});
});

describe("Attendee base URL", () => {
	it.each([
		["https://attendee.example.com/", "https://attendee.example.com"],
		["https://attendee.example.com/api/v1", "https://attendee.example.com"],
		[
			"https://gateway.example.com/attendee/",
			"https://gateway.example.com/attendee",
		],
	])("normalizes %s", (input, expected) => {
		expect(normalizeAttendeeBaseUrl(input)).toBe(expected);
	});

	it.each([
		"http://attendee.example.com",
		"https://user:secret@attendee.example.com",
		"https://attendee.example.com/?token=abc",
		"not a url",
	])("refuses %s", (input) => {
		expect(normalizeAttendeeBaseUrl(input)).toBeNull();
		expect(getAttendeeBaseUrlBlockReason(input)).not.toBeNull();
	});

	it("refuses internal destinations unless the operator lists the host", () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv(PARLUME_ATTENDEE_ALLOWED_HOSTS_ENV, "");
		expect(
			getAttendeeBaseUrlBlockReason("https://169.254.169.254"),
		).not.toBeNull();
		expect(
			getAttendeeBaseUrlBlockReason("https://10.0.0.5"),
		).not.toBeNull();

		vi.stubEnv(PARLUME_ATTENDEE_ALLOWED_HOSTS_ENV, "10.0.0.5");
		expect(getAttendeeBaseUrlBlockReason("https://10.0.0.5")).toBeNull();
	});

	it("accepts the hosted service", () => {
		expect(
			getAttendeeBaseUrlBlockReason("https://app.attendee.dev"),
		).toBeNull();
	});
});

describe("checkAttendeeConnection", () => {
	const check = () =>
		checkAttendeeConnection({
			apiKey: "organization-key",
			baseUrl: "https://attendee.example.com",
		});

	it("lists bots, read-only, with the key", async () => {
		fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));

		await expect(check()).resolves.toEqual({ status: "ok" });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://attendee.example.com/api/v1/bots");
		expect(init.method).toBeUndefined();
		expect(init.headers).toEqual({
			Authorization: "Token organization-key",
		});
	});

	it.each([401, 403])("reports HTTP %s as a rejected key", async (status) => {
		fetchMock.mockResolvedValue(new Response("{}", { status }));

		await expect(check()).resolves.toEqual({
			status: "invalid_key",
			httpStatus: status,
		});
	});

	it("reports any other answer with its status and Attendee's reason", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ error: "Service unavailable" }), {
				status: 503,
			}),
		);

		await expect(check()).resolves.toEqual({
			status: "error",
			httpStatus: 503,
			detail: "Service unavailable",
		});
	});

	it("reports an unreachable instance without a status", async () => {
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));

		await expect(check()).resolves.toEqual({
			status: "error",
			httpStatus: null,
			detail: "Attendee could not be reached.",
		});
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
