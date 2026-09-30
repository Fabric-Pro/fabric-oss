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
	mocks.findFirst.mockResolvedValue({
		id: "session-1",
		providerBotId: "bot-1",
		status: "STOP_FAILED",
		streamGeneration: 2,
		endReason: "STOPPED",
	});
});

describe("Parlume stream-error leave retry", () => {
	it("retries a prior failed provider leave without relabelling why it stopped", async () => {
		mocks.requestLeave.mockResolvedValue({ kind: "LEAVE_REQUESTED" });

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.requestLeave).toHaveBeenCalledWith({
			session: {
				id: "session-1",
				providerBotId: "bot-1",
				streamGeneration: 2,
			},
			reason: "STOPPED",
			lastError: null,
			captureStopped: false,
		});
	});

	it("records a stream error for a healthy session", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "session-1",
			providerBotId: "bot-1",
			status: "ACTIVE",
			streamGeneration: 2,
			endReason: null,
		});
		mocks.requestLeave.mockResolvedValue({ kind: "LEAVE_REQUESTED" });

		await POST(request());

		expect(mocks.requestLeave).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: "STREAM_ERROR",
				lastError: "Parlume transcription stream failed.",
			}),
		);
	});

	it("keeps the bridge error marker retryable when the provider leave fails", async () => {
		mocks.requestLeave.mockRejectedValue(
			new Error("temporary provider outage"),
		);

		const response = await POST(request());

		expect(response.status).toBe(503);
	});
});
