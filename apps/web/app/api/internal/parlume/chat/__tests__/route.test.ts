import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	settings: vi.fn(),
	send: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { parlumeMeetingSession: { findFirst: mocks.findFirst } },
}));

vi.mock("@repo/api/modules/projects/lib/parlume-attendee", () => ({
	sendParlumeMeetingChat: (...args: unknown[]) => mocks.send(...args),
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
	});

	it("reports a provider refusal, such as chat disabled in the meeting", async () => {
		mocks.send.mockRejectedValue(
			new Error("Attendee request failed with HTTP 400."),
		);

		const response = await POST(request(message));

		expect(response.status).toBe(502);
	});
});
