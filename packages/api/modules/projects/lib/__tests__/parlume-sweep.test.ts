import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	finalize: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { parlumeMeetingSession: { findMany: mocks.findMany } },
}));
vi.mock("../parlume-finalization", () => ({
	finalizeParlumeSession: mocks.finalize,
}));
vi.mock("../parlume-log", () => ({ parlumeLog: mocks.log }));

import { sweepOverdueParlumeSessions } from "../parlume-sweep";

const NOW = new Date("2026-11-20T09:30:00.000Z");

beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	mocks.findMany.mockResolvedValue([]);
	mocks.finalize.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("sweepOverdueParlumeSessions", () => {
	// The bot left at 09:17:43 and the bridge never reported the stream
	// closed: the session stayed LEAVING until the hard stop at 13:12.
	// The bridge retries a failed segment delivery every five minutes, and
	// Fabric refuses segments for a finalized session: the grace outlasts
	// several retries.
	it("takes a session whose bot left fifteen minutes ago, long before its hard stop", async () => {
		await sweepOverdueParlumeSessions("project-1");

		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "project-1",
					status: { in: ["LEAVING", "STOP_FAILED", "FAILED"] },
					providerBotId: { not: null },
					terminalCallbackAt: { not: null },
					finalizedAt: null,
					OR: [
						{ hardStopAt: { lt: NOW } },
						{
							terminalCallbackAt: {
								lt: new Date("2026-11-20T09:15:00.000Z"),
							},
						},
					],
				},
			}),
		);
	});

	it("finalizes each overdue session, keeping a failure as it is", async () => {
		mocks.findMany.mockResolvedValue([
			{ id: "session-1", status: "LEAVING", streamGeneration: 1 },
			{ id: "session-2", status: "FAILED", streamGeneration: 2 },
		]);

		await sweepOverdueParlumeSessions("project-1");

		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			expectedStreamGeneration: 1,
		});
		expect(mocks.finalize).toHaveBeenCalledWith("session-2", {
			expectedStreamGeneration: 2,
			preserveFailure: true,
		});
	});

	// The schedule's sweep: a session stranded in LEAVING whose project page
	// nobody opens is finalized all the same.
	it("finalizes a stranded session of any project when run for all of them", async () => {
		mocks.findMany.mockResolvedValue([
			{ id: "session-1", status: "LEAVING", streamGeneration: 1 },
		]);

		await expect(sweepOverdueParlumeSessions()).resolves.toBe(1);

		const [query] = mocks.findMany.mock.calls[0] ?? [];
		expect(query.where).not.toHaveProperty("projectId");
		expect(query.where).toMatchObject({
			status: { in: ["LEAVING", "STOP_FAILED", "FAILED"] },
			providerBotId: { not: null },
			terminalCallbackAt: { not: null },
			finalizedAt: null,
		});
		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			expectedStreamGeneration: 1,
		});
	});

	it("goes on past a session it could not finalize", async () => {
		mocks.findMany.mockResolvedValue([
			{ id: "session-1", status: "LEAVING", streamGeneration: 1 },
			{ id: "session-2", status: "LEAVING", streamGeneration: 1 },
		]);
		mocks.finalize.mockRejectedValueOnce(new Error("claimed"));

		await expect(sweepOverdueParlumeSessions("project-1")).resolves.toBe(1);

		expect(mocks.finalize).toHaveBeenCalledTimes(2);
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"session.sweep_failed",
			expect.objectContaining({ sessionId: "session-1" }),
		);
	});
});
