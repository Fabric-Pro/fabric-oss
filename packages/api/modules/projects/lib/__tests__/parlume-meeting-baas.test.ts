import { afterEach, describe, expect, it, vi } from "vitest";
import {
	armParlumeMeetingBridge,
	deleteParlumeMeetingBotData,
	getParlumeBridgeSettings,
	leaveParlumeMeetingBot,
	startParlumeMeetingBot,
} from "../parlume-meeting-baas";

const settings = {
	apiKey: "operator-key",
	bridgeUrl: "wss://bridge.fabric.example/live",
	callbackUrl: "https://fabric.example/api/internal/parlume/callback",
	serviceSecret: "service-secret",
};

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
	fetchMock.mockReset();
	vi.unstubAllEnvs();
});

describe("getParlumeBridgeSettings", () => {
	it("derives public bridge and callback endpoints from Fabric's canonical staging URLs", () => {
		vi.stubEnv("PARLUME_MEETING_BAAS_API_KEY", "operator-key");
		vi.stubEnv("AGENT_SERVICE_SECRET", "service-secret");
		vi.stubEnv("NEXT_PUBLIC_PARTYKIT_HOST", "bridge.fabric.example");
		vi.stubEnv("APP_URL", "https://staging.fabric.example");

		expect(getParlumeBridgeSettings()).toEqual({
			apiKey: "operator-key",
			bridgeUrl: "wss://bridge.fabric.example/parties/parlume",
			callbackUrl:
				"https://staging.fabric.example/api/internal/parlume/callback",
			serviceSecret: "service-secret",
		});
	});
});

describe("startParlumeMeetingBot", () => {
	it("uses the Meeting BaaS v2 live-streaming contract", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ data: { bot_id: "bot-1" } }), {
				status: 200,
			}),
		);

		await expect(
			startParlumeMeetingBot({
				settings,
				sessionId: "session-1",
				meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
				streamToken: "stream-token",
				callbackSecret: "callback-secret",
			}),
		).resolves.toBe("bot-1");

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.meetingbaas.com/v2/bots",
			expect.objectContaining({
				headers: expect.objectContaining({
					"x-meeting-baas-api-key": "operator-key",
				}),
				body: JSON.stringify({
					bot_name: "Fabric Parlume (AI recording)",
					meeting_url:
						"https://teams.microsoft.com/l/meetup-join/example",
					recording_mode: "audio_only",
					allow_multiple_bots: false,
					callback_enabled: true,
					callback_config: {
						url: "https://fabric.example/api/internal/parlume/callback?sessionId=session-1",
						method: "POST",
						secret: "callback-secret",
					},
					streaming_enabled: true,
					streaming_config: {
						mode: "transcription",
						output_url:
							"wss://bridge.fabric.example/live/session-1?token=stream-token",
						input_url:
							"wss://bridge.fabric.example/live/session-1?token=stream-token",
						transcription: { provider: "gladia", api_key: null },
						audio_frequency: 24_000,
					},
					timeout_config: {
						waiting_room_timeout: 300,
						no_one_joined_timeout: 300,
						silence_timeout: 300,
					},
				}),
			}),
		);
	});

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

	it("deletes provider artifacts only through the operator credential", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

		await deleteParlumeMeetingBotData({ settings, providerBotId: "bot-1" });

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.meetingbaas.com/v2/bots/bot-1/delete-data",
			expect.objectContaining({
				method: "DELETE",
				headers: { "x-meeting-baas-api-key": "operator-key" },
			}),
		);
	});
});

describe("leaveParlumeMeetingBot", () => {
	it("recovers a terminal bot only after the provider verifies its identity and state", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(null, { status: 409 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						data: { bot_id: "bot-1", status: "completed" },
					}),
					{ status: 200 },
				),
			);

		await expect(
			leaveParlumeMeetingBot({ settings, providerBotId: "bot-1" }),
		).resolves.toEqual({ kind: "TERMINAL", status: "completed" });
		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"https://api.meetingbaas.com/v2/bots/bot-1/leave",
			expect.objectContaining({ method: "POST" }),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"https://api.meetingbaas.com/v2/bots/bot-1/status",
			expect.objectContaining({
				headers: { "x-meeting-baas-api-key": "operator-key" },
			}),
		);
	});

	it("fails closed when a conflict cannot be verified as a terminal bot", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(null, { status: 409 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						data: { bot_id: "other-bot", status: "completed" },
					}),
					{ status: 200 },
				),
			);

		await expect(
			leaveParlumeMeetingBot({ settings, providerBotId: "bot-1" }),
		).rejects.toThrow("HTTP 409");
	});

	it("reports a verified provider failure distinctly from a completed bot", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(null, { status: 409 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						data: { bot_id: "bot-1", status: "failed" },
					}),
					{ status: 200 },
				),
			);

		await expect(
			leaveParlumeMeetingBot({ settings, providerBotId: "bot-1" }),
		).resolves.toEqual({ kind: "TERMINAL", status: "failed" });
	});
});
