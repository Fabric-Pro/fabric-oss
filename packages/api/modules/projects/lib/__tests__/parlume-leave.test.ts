import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	updateMany: vi.fn(),
	settings: vi.fn(),
	leave: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			updateMany: (...args: unknown[]) => mocks.updateMany(...args),
		},
	},
}));

vi.mock("../parlume-meeting-baas", () => ({
	getParlumeBridgeSettings: () => mocks.settings(),
	leaveParlumeMeetingBot: (...args: unknown[]) => mocks.leave(...args),
}));

vi.mock("../parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

import { requestParlumeLeave } from "../parlume-leave";

const session = {
	id: "session-1",
	providerBotId: "bot-1",
	streamGeneration: 2,
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.settings.mockReturnValue({ apiKey: "operator-key" });
	mocks.leave.mockResolvedValue({ kind: "LEAVE_REQUESTED" });
});

describe("requestParlumeLeave", () => {
	it("records the reason, stops capture, and asks the provider to leave", async () => {
		const result = await requestParlumeLeave({
			session,
			reason: "IDLE",
			lastError: null,
			captureStopped: true,
		});

		expect(result).toEqual({ kind: "LEAVE_REQUESTED" });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: {
				id: "session-1",
				streamGeneration: 2,
				status: { in: ["JOINING", "ACTIVE", "LEAVING", "STOP_FAILED"] },
				finalizedAt: null,
			},
			data: {
				status: "LEAVING",
				endReason: "IDLE",
				leaveRequestedAt: expect.any(Date),
				captureStoppedAt: expect.any(Date),
			},
		});
		expect(mocks.leave).toHaveBeenCalledWith({
			settings: { apiKey: "operator-key" },
			providerBotId: "bot-1",
		});
	});

	it("writes the detail only when the caller has one", async () => {
		await requestParlumeLeave({
			session,
			reason: "ACCESS_REVOKED",
			lastError: "The inviter no longer has access to this project.",
			captureStopped: true,
		});

		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastError:
						"The inviter no longer has access to this project.",
				}),
			}),
		);
	});

	it("does nothing for a session another path already finished", async () => {
		mocks.updateMany.mockResolvedValue({ count: 0 });

		const result = await requestParlumeLeave({
			session,
			reason: "IDLE",
			lastError: null,
			captureStopped: true,
		});

		expect(result).toBeNull();
		expect(mocks.leave).not.toHaveBeenCalled();
	});

	it("leaves the session retryable when the provider refuses", async () => {
		mocks.leave.mockRejectedValue(new Error("provider outage"));

		await expect(
			requestParlumeLeave({
				session,
				reason: "STREAM_ERROR",
				lastError: null,
				captureStopped: false,
			}),
		).rejects.toThrow("provider outage");
		expect(mocks.updateMany).toHaveBeenLastCalledWith({
			where: { id: "session-1", status: "LEAVING" },
			data: { status: "STOP_FAILED" },
		});
		expect(mocks.log).toHaveBeenCalledWith(
			"error",
			"leave.failed",
			expect.objectContaining({ reason: "STREAM_ERROR" }),
		);
	});
});
