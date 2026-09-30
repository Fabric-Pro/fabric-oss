import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	updateMany: vi.fn(),
	finalize: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: (...args: unknown[]) => mocks.findFirst(...args),
			updateMany: (...args: unknown[]) => mocks.updateMany(...args),
		},
	},
}));

vi.mock("../../lib", () => ({
	isParlumeServiceRequestAuthorized: () => true,
}));

vi.mock("@repo/api/modules/projects/lib/parlume-finalization", () => ({
	finalizeParlumeSession: (...args: unknown[]) => mocks.finalize(...args),
}));

import { POST } from "../route";

function request(streamGeneration: number) {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/stream-closed",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				sessionId: "session-1",
				botId: "bot-1",
				streamGeneration,
			}),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.findFirst.mockResolvedValue({
		id: "session-1",
		status: "ACTIVE",
		terminalCallbackAt: new Date(),
		streamGeneration: 2,
	});
});

describe("Parlume stream close", () => {
	it("acknowledges a stale close without writing a close marker or finalizing", async () => {
		mocks.updateMany.mockResolvedValue({ count: 0 });

		const response = await POST(request(1));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: true, stale: true });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: {
				id: "session-1",
				status: { in: ["ACTIVE", "LEAVING", "FAILED"] },
				streamGeneration: 1,
				finalizedAt: null,
			},
			data: { streamClosedAt: expect.any(Date) },
		});
		expect(mocks.finalize).not.toHaveBeenCalled();
	});

	it("finalizes a failed session after the bridge drains its buffered segments", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "session-1",
			status: "FAILED",
			terminalCallbackAt: null,
			streamGeneration: 2,
		});
		mocks.updateMany.mockResolvedValue({ count: 1 });

		const response = await POST(request(2));

		expect(response.status).toBe(200);
		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			preserveFailure: true,
			expectedStreamGeneration: 2,
		});
	});

	it("does not re-finalize a duplicate close after a failed session is finalized", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "session-1",
			status: "FAILED",
			terminalCallbackAt: null,
			streamGeneration: 2,
		});
		mocks.updateMany.mockResolvedValue({ count: 0 });

		const response = await POST(request(2));

		expect(response.status).toBe(200);
		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ finalizedAt: null }),
			}),
		);
		expect(mocks.finalize).not.toHaveBeenCalled();
	});
});
