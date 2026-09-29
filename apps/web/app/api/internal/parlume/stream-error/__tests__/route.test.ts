import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	update: vi.fn(),
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
}));

vi.mock("@repo/api/modules/projects/lib/parlume-meeting-baas", () => ({
	getParlumeBridgeSettings: () => mocks.settings(),
	leaveParlumeMeetingBot: (...args: unknown[]) => mocks.leave(...args),
}));

import { POST } from "../route";

function request() {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/stream-error",
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
	mocks.settings.mockReturnValue({ apiKey: "operator-key" });
	mocks.findFirst.mockResolvedValue({
		id: "session-1",
		providerBotId: "bot-1",
		status: "STOP_FAILED",
	});
	mocks.update.mockResolvedValue(undefined);
});

describe("Parlume stream-error leave retry", () => {
	it("retries a prior failed provider leave instead of accepting it as terminal", async () => {
		mocks.leave.mockResolvedValue(undefined);

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.leave).toHaveBeenCalledWith({
			settings: { apiKey: "operator-key" },
			providerBotId: "bot-1",
		});
	});

	it("keeps the bridge error marker retryable when the provider leave fails", async () => {
		mocks.leave.mockRejectedValue(new Error("temporary provider outage"));

		const response = await POST(request());

		expect(response.status).toBe(503);
		expect(mocks.update).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "STOP_FAILED" }),
			}),
		);
	});
});
