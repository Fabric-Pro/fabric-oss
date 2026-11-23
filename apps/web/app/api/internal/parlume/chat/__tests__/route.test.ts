import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	settings: vi.fn(),
	send: vi.fn(),
	channelSend: vi.fn(),
	recordTag: vi.fn(),
	recordRecapTag: vi.fn(),
	turnFindFirst: vi.fn(),
	OutcomeUnknownError: class extends Error {},
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: { findFirst: mocks.findFirst },
		parlumeMeetingTurn: { findFirst: mocks.turnFindFirst },
	},
}));

vi.mock(
	"@repo/api/modules/projects/lib/parlume-attendee",
	async (original) => ({
		...(await original<
			typeof import("@repo/api/modules/projects/lib/parlume-attendee")
		>()),
		sendParlumeMeetingChat: (...args: unknown[]) => mocks.send(...args),
	}),
);
vi.mock("@repo/api/modules/projects/lib/parlume-channel-chat", () => ({
	ParlumeChannelPostOutcomeUnknownError: mocks.OutcomeUnknownError,
	sendParlumeChannelPost: mocks.channelSend,
}));
vi.mock("@repo/api/modules/projects/lib/parlume-chat-tags", () => ({
	recordParlumeChatTag: mocks.recordTag,
	recordParlumeRecapTag: mocks.recordRecapTag,
}));

vi.mock("@repo/api/modules/projects/lib/parlume-provider-settings", () => ({
	resolveParlumeAttendeeSettings: (...args: unknown[]) =>
		mocks.settings(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: () => undefined,
}));

import { POST } from "../route";

function request(body: unknown, token = "service-secret") {
	return new NextRequest("https://fabric.example/api/internal/parlume/chat", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-Agent-Service-Token": token,
		},
		body: JSON.stringify(body),
	});
}

const message = {
	sessionId: "session-1",
	botId: "bot-1",
	message: "The project is Example Project.",
};

const attendee = {
	apiKey: "org-key",
	baseUrl: "https://attendee.example.com",
	teamsLoginMode: null,
	source: "organization",
};

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	mocks.findFirst.mockResolvedValue({
		id: "session-1",
		providerBotId: "bot-1",
		organizationId: "org-1",
	});
	mocks.settings.mockResolvedValue(attendee);
	mocks.send.mockResolvedValue(undefined);
});

describe("Parlume meeting chat fallback", () => {
	it("routes only a verified ready channel binding through Graph", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "session-1",
			providerBotId: "bot-1",
			organizationId: "org-1",
			channelChatStatus: "READY",
		});
		const response = await POST(
			request({ ...message, message: "[P1] Answer" }),
		);
		expect(await response.json()).toEqual({
			sent: true,
			delivery: "observed",
		});
		expect(mocks.channelSend).toHaveBeenCalledWith(
			"session-1",
			"[P1] Answer",
			false,
		);
		expect(mocks.send).not.toHaveBeenCalled();
	});

	// Suggestions and the recap keep their one-paragraph form.
	it("passes a plain post on as plain, to either chat", async () => {
		await POST(request({ ...message, plain: true }));
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({ plain: true }),
		);

		mocks.findFirst.mockResolvedValue({
			id: "session-1",
			providerBotId: "bot-1",
			organizationId: "org-1",
			channelChatStatus: "READY",
		});
		await POST(request({ ...message, message: "[P2] Recap", plain: true }));
		expect(mocks.channelSend).toHaveBeenCalledWith(
			"session-1",
			"[P2] Recap",
			true,
		);
	});
	it.each(["ATTENDEE", "UNRESOLVED"])(
		"keeps ordinary/resolution-unknown short-link chat on the queued-only Attendee path (%s)",
		async (channelChatStatus) => {
			mocks.findFirst.mockResolvedValue({
				id: "session-1",
				providerBotId: "bot-1",
				organizationId: "org-1",
				channelChatStatus,
			});
			const response = await POST(request(message));
			expect(await response.json()).toEqual({
				sent: true,
				delivery: "queued",
			});
			expect(mocks.send).toHaveBeenCalled();
			expect(mocks.channelSend).not.toHaveBeenCalled();
		},
	);
	it.each(["PENDING", "UNAVAILABLE", "STOPPED"])(
		"never falls back from known channel state %s to provider queue acceptance",
		async (channelChatStatus) => {
			mocks.findFirst.mockResolvedValue({
				id: "session-1",
				providerBotId: "bot-1",
				organizationId: "org-1",
				channelChatStatus,
				channelChatError: "Channel thread unavailable",
			});
			const response = await POST(request(message));
			expect(response.status).toBe(409);
			expect(mocks.send).not.toHaveBeenCalled();
		},
	);
	it.each(["UNRESOLVED", "PENDING", "ATTENDEE"])(
		"refuses provider fallback during a verified channel binding transition (%s)",
		async (channelChatStatus) => {
			mocks.findFirst.mockResolvedValue({
				id: "session-1",
				providerBotId: "bot-1",
				organizationId: "org-1",
				channelChatStatus,
				channelId: "19:example@thread.tacv2",
				channelRootMessageId: "1700000000000",
			});
			const response = await POST(request(message));
			expect(response.status).toBe(409);
			expect(mocks.send).not.toHaveBeenCalled();
			expect(mocks.channelSend).not.toHaveBeenCalled();
		},
	);
	// A channel post can fail after Graph created it: the bridge keeps that
	// one as possibly in the thread, and forgets one that was never sent.
	it.each([
		["unknown", new mocks.OutcomeUnknownError("Read-back unavailable")],
		["not_sent", new Error("Channel chat session is no longer active.")],
	])(
		"answers a failed channel post with its outcome (%s)",
		async (outcome, error) => {
			mocks.findFirst.mockResolvedValue({
				id: "session-1",
				providerBotId: "bot-1",
				organizationId: "org-1",
				channelChatStatus: "READY",
			});
			mocks.channelSend.mockRejectedValue(error);

			const response = await POST(
				request({ ...message, message: "[P1] Answer" }),
			);

			expect(response.status).toBe(502);
			expect(await response.json()).toEqual({
				error: "Channel chat delivery could not be confirmed. Check the meeting thread before retrying.",
				outcome,
			});
			expect(mocks.send).not.toHaveBeenCalled();
		},
	);
	it("rejects a caller without the service token", async () => {
		const response = await POST(request(message, "wrong"));

		expect(response.status).toBe(401);
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("sends the reply as the active session's own bot, and says it is only queued", async () => {
		const response = await POST(request(message));

		expect(await response.json()).toEqual({
			sent: true,
			delivery: "queued",
		});
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "session-1",
					providerBotId: "bot-1",
					status: "ACTIVE",
				},
			}),
		);
		expect(mocks.settings).toHaveBeenCalledWith("org-1");
		expect(mocks.send).toHaveBeenCalledWith({
			attendee,
			providerBotId: "bot-1",
			message: "The project is Example Project.",
		});
	});

	it("reports the meeting bot unavailable when no Attendee settings resolve", async () => {
		mocks.settings.mockResolvedValue(null);

		const response = await POST(request(message));

		expect(response.status).toBe(503);
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("refuses a session that is no longer in the meeting", async () => {
		mocks.findFirst.mockResolvedValue(null);

		const response = await POST(request(message));

		expect(response.status).toBe(409);
		expect(mocks.send).not.toHaveBeenCalled();
		expect(mocks.recordTag).not.toHaveBeenCalled();
	});

	it("records the post's tag before it is sent", async () => {
		mocks.send.mockImplementation(() => {
			expect(mocks.recordTag).toHaveBeenCalledWith(
				"session-1",
				"[P5] Unavailable: P3 to P4.",
			);
		});

		const response = await POST(
			request({ ...message, message: "[P5] Unavailable: P3 to P4." }),
		);

		expect(response.status).toBe(200);
		expect(mocks.send).toHaveBeenCalledTimes(1);
	});

	it("reports a provider refusal, such as chat disabled in the meeting", async () => {
		mocks.send.mockRejectedValue(
			new Error("Attendee request failed with HTTP 400."),
		);

		const response = await POST(request(message));

		expect(response.status).toBe(502);
	});

	// A recap the bridge held until the chat opened is posted after Fabric's
	// own request ended without a tag; the page called it not posted.
	it("records a sent recap's tag for the Parlume page, to either chat", async () => {
		const recap = { ...message, message: "[P35] Since last time…" };
		mocks.send.mockImplementation(() => {
			expect(mocks.recordRecapTag).not.toHaveBeenCalled();
		});

		await POST(request({ ...recap, plain: true, recap: true }));
		expect(mocks.recordRecapTag).toHaveBeenCalledWith(
			"session-1",
			"[P35] Since last time…",
		);

		mocks.recordRecapTag.mockClear();
		mocks.findFirst.mockResolvedValue({
			id: "session-1",
			providerBotId: "bot-1",
			organizationId: "org-1",
			channelChatStatus: "READY",
		});
		const response = await POST(
			request({ ...recap, plain: true, recap: true }),
		);
		expect(await response.json()).toEqual({
			sent: true,
			delivery: "observed",
		});
		expect(mocks.recordRecapTag).toHaveBeenCalledWith(
			"session-1",
			"[P35] Since last time…",
		);
	});

	it("records no recap tag for another post, or for a recap the chat refused", async () => {
		await POST(request({ ...message, message: "[P4] Idea", plain: true }));
		mocks.send.mockRejectedValue(new Error("refused"));
		await POST(request({ ...message, message: "[P5] Recap", recap: true }));

		expect(mocks.recordRecapTag).not.toHaveBeenCalled();
	});

	// A stop ends the request and its work: an answer prepared meanwhile,
	// a proposal or a rest of it, never reaches the chat afterwards.
	it("drops a post for a request someone stopped, before its tag is counted", async () => {
		mocks.turnFindFirst.mockResolvedValue({ status: "STOPPED" });

		const response = await POST(
			request({
				...message,
				message: "[P6] The plan.",
				turnId: "turn-1",
			}),
		);

		expect(response.status).toBe(409);
		expect(mocks.turnFindFirst).toHaveBeenCalledWith({
			where: { id: "turn-1", sessionId: "session-1" },
			select: { status: true },
		});
		expect(mocks.send).not.toHaveBeenCalled();
		expect(mocks.channelSend).not.toHaveBeenCalled();
		expect(mocks.recordTag).not.toHaveBeenCalled();
	});

	it.each([
		["a running request's post", "RUNNING", false, 200],
		["a completed request's later post", "COMPLETED", false, 200],
		["a failed request's error line", "FAILED", true, 200],
		["a failed request's answer", "FAILED", false, 409],
		["an error line for a request still running", "RUNNING", true, 409],
		["an error line for a stopped request", "STOPPED", true, 409],
	])("decides whether %s may post", async (_label, status, failed, code) => {
		mocks.turnFindFirst.mockResolvedValue({ status });

		const response = await POST(
			request({
				...message,
				message: "[P6] The plan.",
				turnId: "turn-1",
				...(failed ? { turnFailed: true } : {}),
			}),
		);

		expect(response.status).toBe(code);
		expect(mocks.send).toHaveBeenCalledTimes(code === 200 ? 1 : 0);
	});

	it("drops a post that names a request of another session", async () => {
		mocks.turnFindFirst.mockResolvedValue(null);

		const response = await POST(
			request({
				...message,
				message: "[P6] The plan.",
				turnId: "turn-9",
			}),
		);

		expect(response.status).toBe(409);
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("still reports a sent recap as sent when its tag cannot be recorded", async () => {
		mocks.recordRecapTag.mockRejectedValue(new Error("database down"));

		const response = await POST(
			request({ ...message, message: "[P5] Recap", recap: true }),
		);

		expect(await response.json()).toEqual({
			sent: true,
			delivery: "queued",
		});
	});
});
