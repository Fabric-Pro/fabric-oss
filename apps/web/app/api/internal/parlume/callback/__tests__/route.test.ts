import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	update: vi.fn(),
	updateMany: vi.fn(),
	finalize: vi.fn(),
	cleanup: vi.fn(),
	settings: vi.fn(),
	closeBridge: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: (...args: unknown[]) => mocks.findFirst(...args),
			update: (...args: unknown[]) => mocks.update(...args),
			updateMany: (...args: unknown[]) => mocks.updateMany(...args),
		},
	},
}));

vi.mock("../../lib", () => ({
	callbackSecret: () => "callback-secret",
	constantTimeEqual: (provided: string | null, expected: string) =>
		provided === expected,
}));

vi.mock("@repo/api/modules/projects/lib/parlume-finalization", () => ({
	finalizeParlumeSession: (...args: unknown[]) => mocks.finalize(...args),
	cleanupParlumeProviderData: (...args: unknown[]) => mocks.cleanup(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-meeting-baas", () => ({
	getParlumeBridgeSettings: () => mocks.settings(),
	closeParlumeMeetingBridge: (...args: unknown[]) =>
		mocks.closeBridge(...args),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

import { POST } from "../route";

function request(
	event: "bot.completed" | "bot.failed" = "bot.failed",
	secret = "callback-secret",
) {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/callback?sessionId=session-1",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-mb-secret": secret,
			},
			body: JSON.stringify({ event, data: { bot_id: "bot-1" } }),
		},
	);
}

const active = {
	id: "session-1",
	status: "ACTIVE",
	endReason: null,
	leaveRequestedAt: null,
	streamClosedAt: null,
	streamGeneration: 2,
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.findFirst.mockResolvedValue(active);
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.update.mockResolvedValue(undefined);
	mocks.settings.mockReturnValue({ bridgeUrl: "wss://bridge.example" });
	mocks.closeBridge.mockResolvedValue(undefined);
});

describe("Parlume callback authentication", () => {
	it("rejects a wrong secret and logs the event name without the secret", async () => {
		const response = await POST(request("bot.completed", "stale-secret"));

		expect(response.status).toBe(401);
		expect(mocks.findFirst).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"callback.rejected",
			expect.objectContaining({
				sessionId: "session-1",
				event: "bot.completed",
				hasSecretHeader: true,
			}),
		);
		const logged = JSON.stringify(mocks.log.mock.calls);
		expect(logged).not.toContain("stale-secret");
		expect(logged).not.toContain("callback-secret");
	});
});

describe("Parlume failed bot callback after a leave Fabric requested", () => {
	it("records a normal end with the requested reason instead of a failure", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "LEAVING",
			endReason: "IDLE",
			leaveRequestedAt: new Date("2026-10-01T18:07:20Z"),
		});

		const response = await POST(request("bot.failed"));

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "session-1", streamGeneration: 2 },
			data: {
				status: "LEAVING",
				endReason: "IDLE",
				terminalCallbackAt: expect.any(Date),
			},
		});
		expect(mocks.updateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
	});
});

describe("Parlume failed bot callback", () => {
	it("keeps the failure visible, closes the bridge, and defers finalization until buffered segments drain", async () => {
		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "session-1", status: { not: "ENDED" } },
			data: expect.objectContaining({
				status: "FAILED",
				endReason: "PROVIDER_FAILED",
			}),
		});
		expect(mocks.closeBridge).toHaveBeenCalledWith({
			settings: { bridgeUrl: "wss://bridge.example" },
			sessionId: "session-1",
		});
		expect(mocks.finalize).not.toHaveBeenCalled();
	});

	it("finalizes a failed bot before stream verification because no bridge drain can follow", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "JOINING",
			streamGeneration: 0,
		});

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			preserveFailure: true,
		});
		expect(mocks.closeBridge).not.toHaveBeenCalled();
	});

	it("keeps an earlier stop reason on a failure that follows it", async () => {
		mocks.findFirst.mockResolvedValue({ ...active, endReason: "STOPPED" });

		await POST(request());

		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ endReason: "STOPPED" }),
			}),
		);
	});
});

describe("Parlume completed bot callback", () => {
	it("marks a bot that left an active meeting as removed and closes the bridge", async () => {
		const response = await POST(request("bot.completed"));

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "session-1", streamGeneration: 2 },
			data: {
				status: "LEAVING",
				endReason: "REMOVED",
				terminalCallbackAt: expect.any(Date),
			},
		});
		expect(mocks.closeBridge).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session-1" }),
		);
		expect(mocks.finalize).not.toHaveBeenCalled();
	});

	it("finalizes at once when the stream already closed", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "LEAVING",
			endReason: "STOPPED",
			streamClosedAt: new Date("2026-09-30T18:00:00Z"),
		});

		await POST(request("bot.completed"));

		expect(mocks.closeBridge).not.toHaveBeenCalled();
		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			expectedStreamGeneration: 2,
		});
	});

	it("still accepts the callback when the bridge cannot be reached", async () => {
		mocks.closeBridge.mockRejectedValue(new Error("bridge down"));

		const response = await POST(request("bot.completed"));

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"callback.bridge_close_failed",
			expect.objectContaining({ sessionId: "session-1" }),
		);
	});

	it("fails a bot that completed before the stream was ever verified", async () => {
		mocks.findFirst.mockResolvedValue({
			...active,
			status: "JOINING",
			streamGeneration: 0,
		});
		mocks.cleanup.mockResolvedValue(undefined);

		await POST(request("bot.completed"));

		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "FAILED",
					endReason: "START_FAILED",
				}),
			}),
		);
		expect(mocks.cleanup).toHaveBeenCalledWith("session-1");
	});
});
