import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	createMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: (...args: unknown[]) => mocks.findFirst(...args),
		},
		parlumeMeetingSegment: {
			createMany: (...args: unknown[]) => mocks.createMany(...args),
		},
	},
}));

vi.mock("../../lib", () => ({
	isParlumeServiceRequestAuthorized: () => true,
	MAX_PARLUME_SEGMENT_CHARS: 20_000,
	segmentDedupeKey: () => "segment-1",
}));

import { POST } from "../route";

function request() {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/segments",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				sessionId: "session-1",
				botId: "bot-1",
				text: "Buffered final segment",
				speakerName: null,
				speakerId: null,
				utteranceStartMs: null,
				utteranceEndMs: null,
			}),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.findFirst.mockResolvedValue({
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		captureStoppedAt: null,
	});
	mocks.createMany.mockResolvedValue({ count: 1 });
});

describe("Parlume segment drain", () => {
	it("accepts a buffered final segment after the bot failure is recorded", async () => {
		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: {
						in: ["ACTIVE", "LEAVING", "STOP_FAILED", "FAILED"],
					},
				}),
			}),
		);
		expect(mocks.createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					text: "Buffered final segment",
				}),
			}),
		);
	});

	it("rejects a late segment after the failed session has been finalized", async () => {
		mocks.findFirst.mockResolvedValue(null);

		const response = await POST(request());

		expect(response.status).toBe(409);
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ finalizedAt: null }),
			}),
		);
		expect(mocks.createMany).not.toHaveBeenCalled();
	});
});
