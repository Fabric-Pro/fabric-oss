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
	callbackSecret: () => "callback-secret",
	constantTimeEqual: () => true,
}));

vi.mock("@repo/api/modules/projects/lib/parlume-finalization", () => ({
	finalizeParlumeSession: (...args: unknown[]) => mocks.finalize(...args),
	cleanupParlumeProviderData: (...args: unknown[]) => mocks.finalize(...args),
}));

import { POST } from "../route";

function request() {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/callback?sessionId=session-1",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-mb-secret": "callback-secret",
			},
			body: JSON.stringify({
				event: "bot.failed",
				data: { bot_id: "bot-1" },
			}),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.findFirst.mockResolvedValue({
		id: "session-1",
		status: "ACTIVE",
		streamClosedAt: null,
		streamGeneration: 2,
	});
	mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("Parlume failed bot callback", () => {
	it("keeps the failure visible and defers finalization until buffered segments drain", async () => {
		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "session-1", status: { not: "ENDED" } },
			data: expect.objectContaining({ status: "FAILED" }),
		});
		expect(mocks.finalize).not.toHaveBeenCalled();
	});

	it("finalizes a failed bot before stream verification because no bridge drain can follow", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "session-1",
			status: "JOINING",
			streamClosedAt: null,
			streamGeneration: 0,
		});

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			preserveFailure: true,
		});
	});
});
