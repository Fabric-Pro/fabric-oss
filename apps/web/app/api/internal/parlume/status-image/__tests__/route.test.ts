import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	settings: vi.fn(),
	output: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: (...args: unknown[]) => mocks.findFirst(...args),
		},
	},
}));

vi.mock("@repo/api/modules/projects/lib/parlume-provider-settings", () => ({
	resolveParlumeAttendeeSettings: (...args: unknown[]) =>
		mocks.settings(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-status-image", () => ({
	PARLUME_TILE_STATES: ["LISTENING", "PAUSED", "ANSWERING"],
	outputParlumeStatusImage: (...args: unknown[]) => mocks.output(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

vi.mock("../../lib", () => ({
	isParlumeServiceRequestAuthorized: (value: string | null) =>
		value === "service",
}));

import { POST } from "../route";

const ATTENDEE = { apiKey: "org-key", baseUrl: "https://app.attendee.dev" };

function request(body: Record<string, unknown>, token = "service") {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/status-image",
		{
			method: "POST",
			headers: { "X-Agent-Service-Token": token },
			body: JSON.stringify({
				sessionId: "session-1",
				botId: "bot-1",
				state: "PAUSED",
				...body,
			}),
		},
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findFirst.mockResolvedValue({
		id: "session-1",
		organizationId: "org-1",
		providerBotId: "bot-1",
	});
	mocks.settings.mockResolvedValue(ATTENDEE);
	mocks.output.mockResolvedValue(undefined);
});

describe("POST /api/internal/parlume/status-image", () => {
	it("shows the state on the live session's bot with the organization's Attendee key", async () => {
		const response = await POST(request({}));

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.findFirst).toHaveBeenCalledWith({
			where: {
				id: "session-1",
				providerBotId: "bot-1",
				status: "ACTIVE",
			},
			select: { id: true, organizationId: true, providerBotId: true },
		});
		expect(mocks.settings).toHaveBeenCalledWith("org-1");
		expect(mocks.output).toHaveBeenCalledWith({
			attendee: ATTENDEE,
			providerBotId: "bot-1",
			state: "PAUSED",
		});
	});

	it("authenticates before reading anything", async () => {
		const response = await POST(request({}, "wrong"));

		expect(response.status).toBe(401);
		expect(mocks.findFirst).not.toHaveBeenCalled();
	});

	it("refuses a state it does not draw", async () => {
		const response = await POST(request({ state: "SPEAKING" }));

		expect(response.status).toBe(400);
		expect(mocks.output).not.toHaveBeenCalled();
	});

	it("shows nothing for a meeting that is over", async () => {
		mocks.findFirst.mockResolvedValue(null);

		const response = await POST(request({}));

		expect(await response.json()).toEqual({ accepted: false });
		expect(mocks.output).not.toHaveBeenCalled();
	});

	it("answers an error the bridge retries when Attendee refuses the image", async () => {
		mocks.output.mockRejectedValue(new Error("Attendee returned HTTP 400"));

		const response = await POST(request({}));

		expect(response.status).toBe(502);
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"status_image.failed",
			expect.objectContaining({
				sessionId: "session-1",
				state: "PAUSED",
			}),
		);
	});
});
