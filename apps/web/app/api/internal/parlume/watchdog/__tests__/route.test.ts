import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	updateMany: vi.fn(),
	finalize: vi.fn(),
	leave: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: mocks.findFirst,
			updateMany: mocks.updateMany,
		},
	},
}));
vi.mock("../../lib", () => ({ isParlumeServiceRequestAuthorized: () => true }));
vi.mock("@repo/api/modules/projects/lib/parlume-finalization", () => ({
	finalizeParlumeSession: mocks.finalize,
}));
vi.mock("@repo/api/modules/projects/lib/parlume-meeting-baas", () => ({
	getParlumeBridgeSettings: () => ({}),
	leaveParlumeMeetingBot: mocks.leave,
}));

function request() {
	return new NextRequest(
		"https://example.com/api/internal/parlume/watchdog",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId: "example-session" }),
		},
	);
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.findFirst.mockResolvedValue({
		id: "example-session",
		providerBotId: "example-bot",
		status: "ACTIVE",
		terminalCallbackAt: null,
		streamClosedAt: new Date(),
		streamGeneration: 2,
	});
	mocks.updateMany.mockResolvedValue({ count: 1 });
});
describe("Parlume watchdog terminal recovery", () => {
	it.each(["completed", "failed"])(
		"finalizes a provider-confirmed %s bot at the hard deadline",
		async (status) => {
			mocks.leave.mockResolvedValue({ kind: "TERMINAL", status });
			const response = await POST(request());
			expect(response.status).toBe(200);
			expect(mocks.finalize).toHaveBeenCalledWith("example-session", {
				expectedStreamGeneration: 2,
				...(status === "failed" ? { preserveFailure: true } : {}),
			});
		},
	);
	it("does not overwrite a finalized state after post-finalization cleanup fails", async () => {
		mocks.leave.mockResolvedValue({
			kind: "TERMINAL",
			status: "completed",
		});
		mocks.finalize.mockRejectedValue(new Error("Cleanup failed"));
		const response = await POST(request());
		expect(response.status).toBe(503);
		expect(mocks.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: {
					id: "example-session",
					streamGeneration: 2,
					status: {
						in: ["JOINING", "ACTIVE", "LEAVING", "STOP_FAILED"],
					},
					finalizedAt: null,
				},
			}),
		);
	});
	it("ignores a stale deadline after another finalizer completed", async () => {
		mocks.updateMany.mockResolvedValue({ count: 0 });
		expect((await POST(request())).status).toBe(200);
		expect(mocks.leave).not.toHaveBeenCalled();
		expect(mocks.finalize).not.toHaveBeenCalled();
	});
});
