import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	requestLeave: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { parlumeMeetingSession: { findFirst: mocks.findFirst } },
}));

vi.mock("@repo/api/modules/projects/lib/parlume-leave", () => ({
	requestParlumeLeave: (...args: unknown[]) => mocks.requestLeave(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: () => undefined,
}));

import { POST } from "../route";

function request(body: unknown, token = "service-secret") {
	return new NextRequest("https://fabric.example/api/internal/parlume/idle", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-Agent-Service-Token": token,
		},
		body: JSON.stringify(body),
	});
}

const idle = { sessionId: "session-1", botId: "bot-1", idleMs: 181_000 };

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	mocks.findFirst.mockResolvedValue({
		id: "session-1",
		providerBotId: "bot-1",
		streamGeneration: 3,
	});
	mocks.requestLeave.mockResolvedValue({ kind: "LEAVE_REQUESTED" });
});

describe("Parlume idle meeting report", () => {
	it("rejects a caller without the service token", async () => {
		const response = await POST(request(idle, "wrong"));

		expect(response.status).toBe(401);
		expect(mocks.findFirst).not.toHaveBeenCalled();
	});

	it("leaves an idle active meeting and records the reason", async () => {
		const response = await POST(request(idle));

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "session-1",
					providerBotId: "bot-1",
					status: "ACTIVE",
				},
			}),
		);
		expect(mocks.requestLeave).toHaveBeenCalledWith({
			session: {
				id: "session-1",
				providerBotId: "bot-1",
				streamGeneration: 3,
			},
			reason: "IDLE",
			lastError: null,
			captureStopped: true,
		});
	});

	it("ignores a report for a session that is no longer active", async () => {
		mocks.findFirst.mockResolvedValue(null);

		const response = await POST(request(idle));

		expect(await response.json()).toEqual({ accepted: true, stale: true });
		expect(mocks.requestLeave).not.toHaveBeenCalled();
	});

	it("asks the bridge to retry when the provider leave fails", async () => {
		mocks.requestLeave.mockRejectedValue(new Error("provider outage"));

		const response = await POST(request(idle));

		expect(response.status).toBe(503);
	});
});
