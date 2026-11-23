import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	update: vi.fn(),
	createMany: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => {
	const delegates = {
		parlumeMeetingSession: {
			findFirst: (...args: unknown[]) => mocks.findFirst(...args),
			update: (...args: unknown[]) => mocks.update(...args),
		},
		parlumeMeetingSegment: {
			createMany: (...args: unknown[]) => mocks.createMany(...args),
		},
	};
	return {
		db: {
			...delegates,
			$transaction: (run: (tx: typeof delegates) => Promise<unknown>) =>
				run(delegates),
		},
	};
});

vi.mock("@repo/api/modules/projects/lib/parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

vi.mock("../../lib", () => ({
	isParlumeServiceRequestAuthorized: (value: string | null) =>
		value === "service",
	listeningEventDedupeKey: (input: { paused: boolean; at: number }) =>
		`listening-${input.paused}-${input.at}`,
}));

import { POST } from "../route";

const AT = Date.UTC(2026, 0, 5, 10, 0, 0);

function request(overrides: Record<string, unknown> = {}, token = "service") {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/listening",
		{
			method: "POST",
			headers: { "X-Agent-Service-Token": token },
			body: JSON.stringify({
				sessionId: "session-1",
				botId: "bot-1",
				paused: true,
				by: "Dana Member",
				at: AT,
				offsetMs: 60_000,
				...overrides,
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
	});
	mocks.createMany.mockResolvedValue({ count: 1 });
});

describe("Parlume listening reports", () => {
	it("authenticates before reading or changing anything", async () => {
		expect((await POST(request({}, "wrong"))).status).toBe(401);
		expect(mocks.findFirst).not.toHaveBeenCalled();
	});

	it("marks the session paused and leaves a transcript marker where it happened", async () => {
		const response = await POST(request());

		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "session-1",
					providerBotId: "bot-1",
					status: { in: ["ACTIVE", "LEAVING", "STOP_FAILED"] },
					finalizedAt: null,
					captureStoppedAt: null,
				},
			}),
		);
		expect(mocks.update).toHaveBeenCalledWith({
			where: { id: "session-1" },
			data: { pausedAt: new Date(AT), pausedBy: "Dana Member" },
		});
		expect(mocks.createMany).toHaveBeenCalledWith({
			data: {
				sessionId: "session-1",
				projectId: "project-1",
				organizationId: "org-1",
				userId: "user-1",
				dedupeKey: `listening-true-${AT}`,
				source: "EVENT",
				text: "Listening paused by Dana Member.",
				speakerName: null,
				speakerId: null,
				utteranceStartMs: 60_000,
				utteranceEndMs: 60_000,
			},
			skipDuplicates: true,
		});
	});

	it("clears the paused state on resume", async () => {
		await POST(request({ paused: false }));

		expect(mocks.update).toHaveBeenCalledWith({
			where: { id: "session-1" },
			data: { pausedAt: null, pausedBy: null },
		});
		expect(mocks.createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					text: "Listening resumed by Dana Member.",
					source: "EVENT",
				}),
			}),
		);
	});

	it("accepts nothing for a meeting that is over", async () => {
		mocks.findFirst.mockResolvedValue(null);

		const response = await POST(request());

		expect(await response.json()).toEqual({ accepted: false });
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.createMany).not.toHaveBeenCalled();
	});

	it("refuses a malformed report", async () => {
		const response = await POST(request({ paused: "yes" }));

		expect(response.status).toBe(400);
		expect(mocks.findFirst).not.toHaveBeenCalled();
	});
});
