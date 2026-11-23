import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	updateMany: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { parlumeMeetingSession: { updateMany: mocks.updateMany } },
}));

vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

import { POST } from "../route";

function report(body: Record<string, unknown>, token = "secret") {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/join-notice",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Agent-Service-Token": token,
			},
			body: JSON.stringify({
				sessionId: "session-1",
				botId: "bot-1",
				...body,
			}),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "secret";
	mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("Parlume join notice reports", () => {
	it("rejects a caller without the service token", async () => {
		const response = await POST(report({ via: "voice" }, "wrong"));

		expect(response.status).toBe(401);
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("records when the notice's post showed up in the chat, and its tag, once", async () => {
		const response = await POST(report({ via: "chat", tag: "P1" }));

		expect(response.status).toBe(200);
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: {
				id: "session-1",
				providerBotId: "bot-1",
				joinNoticeAt: null,
			},
			data: { joinNoticeAt: expect.any(Date), joinNoticeTag: "P1" },
		});
	});

	it("records a notice said aloud, with no tag", async () => {
		await POST(report({ via: "voice" }));

		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { joinNoticeAt: expect.any(Date), joinNoticeTag: null },
			}),
		);
	});

	it("refuses a chat report without a tag", async () => {
		const response = await POST(report({ via: "chat" }));

		expect(response.status).toBe(400);
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});
});
