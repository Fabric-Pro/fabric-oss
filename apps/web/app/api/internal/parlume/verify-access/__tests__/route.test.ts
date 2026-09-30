import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	updateMany: vi.fn(),
	hasProjectAccess: vi.fn(),
	requestLeave: vi.fn(),
	finalize: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: mocks.findFirst,
			updateMany: (...args: unknown[]) => mocks.updateMany(...args),
		},
	},
	hasProjectAccess: (...args: unknown[]) => mocks.hasProjectAccess(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-finalization", () => ({
	finalizeParlumeSession: (...args: unknown[]) => mocks.finalize(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-leave", () => ({
	requestParlumeLeave: (...args: unknown[]) => mocks.requestLeave(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: () => undefined,
}));

import { POST } from "../route";

function request(extra: Record<string, unknown> = {}) {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/verify-access",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Agent-Service-Token": "service-secret",
			},
			body: JSON.stringify({
				sessionId: "session-1",
				botId: "bot-1",
				...extra,
			}),
		},
	);
}

const session = {
	id: "session-1",
	projectId: "project-1",
	organizationId: "org-1",
	userId: "user-1",
	providerBotId: "bot-1",
	status: "ACTIVE",
	streamGeneration: 2,
	endReason: null,
	captureStoppedAt: null,
	terminalCallbackAt: null,
	streamClosedAt: null,
};

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	mocks.findFirst.mockResolvedValue(session);
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.requestLeave.mockResolvedValue({ kind: "LEAVE_REQUESTED" });
	mocks.finalize.mockResolvedValue(undefined);
});

describe("Parlume active access verification", () => {
	it("keeps capturing while the inviter retains access", async () => {
		const response = await POST(request());

		expect(await response.json()).toEqual({
			accepted: true,
			captureStopped: false,
		});
		expect(mocks.requestLeave).not.toHaveBeenCalled();
	});

	it("stops capture and requests provider leave after the inviter loses project access", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		const response = await POST(request());

		expect(await response.json()).toEqual({
			accepted: true,
			captureStopped: true,
		});
		expect(mocks.hasProjectAccess).toHaveBeenCalledWith(
			"project-1",
			"user-1",
			"org-1",
		);
		expect(mocks.requestLeave).toHaveBeenCalledWith({
			session: {
				id: "session-1",
				providerBotId: "bot-1",
				streamGeneration: 2,
			},
			reason: "ACCESS_REVOKED",
			lastError: "The inviter no longer has access to this project.",
			captureStopped: true,
		});
	});

	it("retries an earlier stop with its own reason instead of relabelling it", async () => {
		mocks.findFirst.mockResolvedValue({
			...session,
			endReason: "IDLE",
			captureStoppedAt: new Date("2026-09-30T18:00:00Z"),
		});

		await POST(request());

		expect(mocks.requestLeave).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "IDLE", lastError: null }),
		);
	});

	it("tells the bridge to stop once the provider reported the bot gone", async () => {
		mocks.findFirst.mockResolvedValue({
			...session,
			terminalCallbackAt: new Date("2026-09-30T18:00:00Z"),
		});

		const response = await POST(request());

		expect(await response.json()).toEqual({
			accepted: true,
			captureStopped: true,
		});
		expect(mocks.hasProjectAccess).not.toHaveBeenCalled();
		expect(mocks.requestLeave).not.toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
	});

	it("finalizes a departed bot's session when the bridge holds no stream to close", async () => {
		mocks.findFirst.mockResolvedValue({
			...session,
			status: "LEAVING",
			terminalCallbackAt: new Date("2026-09-30T18:00:00Z"),
		});

		const response = await POST(request({ openConnections: 0 }));

		expect(await response.json()).toEqual({
			accepted: true,
			captureStopped: true,
		});
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: {
				id: "session-1",
				status: { in: ["ACTIVE", "LEAVING"] },
				streamGeneration: 2,
				finalizedAt: null,
				streamClosedAt: null,
			},
			data: { streamClosedAt: expect.any(Date) },
		});
		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			expectedStreamGeneration: 2,
		});
	});

	it("leaves finalization to the stream close while a socket is still open", async () => {
		mocks.findFirst.mockResolvedValue({
			...session,
			status: "LEAVING",
			terminalCallbackAt: new Date("2026-09-30T18:00:00Z"),
		});

		await POST(request({ openConnections: 1 }));

		expect(mocks.updateMany).not.toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
	});

	it("still reports capture stopped when finalization fails now", async () => {
		mocks.findFirst.mockResolvedValue({
			...session,
			status: "LEAVING",
			terminalCallbackAt: new Date("2026-09-30T18:00:00Z"),
		});
		mocks.finalize.mockRejectedValue(new Error("provider outage"));

		const response = await POST(request({ openConnections: 0 }));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			accepted: true,
			captureStopped: true,
		});
	});

	it("asks the bridge to retry when the provider leave fails", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		mocks.requestLeave.mockRejectedValue(new Error("provider outage"));

		const response = await POST(request());

		expect(response.status).toBe(503);
	});
});
