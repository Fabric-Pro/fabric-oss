import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	update: vi.fn(),
	hasProjectAccess: vi.fn(),
	leave: vi.fn(),
	settings: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: mocks.findFirst,
			update: mocks.update,
		},
	},
	hasProjectAccess: (...args: unknown[]) => mocks.hasProjectAccess(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-meeting-baas", () => ({
	getParlumeBridgeSettings: () => mocks.settings(),
	leaveParlumeMeetingBot: (...args: unknown[]) => mocks.leave(...args),
}));

import { POST } from "../route";

function request() {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/verify-access",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Agent-Service-Token": "service-secret",
			},
			body: JSON.stringify({ sessionId: "session-1", botId: "bot-1" }),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	mocks.findFirst.mockResolvedValue({
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		providerBotId: "bot-1",
		captureStoppedAt: null,
	});
	mocks.hasProjectAccess.mockResolvedValue(false);
	mocks.settings.mockReturnValue({ apiKey: "operator-key" });
	mocks.leave.mockResolvedValue(undefined);
	mocks.update.mockResolvedValue(undefined);
});

describe("Parlume active access verification", () => {
	it("stops capture and requests provider leave after the inviter loses project access", async () => {
		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.hasProjectAccess).toHaveBeenCalledWith(
			"project-1",
			"user-1",
			"org-1",
		);
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "LEAVING",
					captureStoppedAt: expect.any(Date),
				}),
			}),
		);
		expect(mocks.leave).toHaveBeenCalledWith({
			settings: { apiKey: "operator-key" },
			providerBotId: "bot-1",
		});
	});
});
