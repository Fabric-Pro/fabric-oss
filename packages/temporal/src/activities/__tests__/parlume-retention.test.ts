import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	purge: vi.fn(),
	drop: vi.fn(),
	drain: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listParlumeSessionsPastRetention: (...args: unknown[]) =>
		mocks.list(...args),
	purgeParlumeSessionContent: (...args: unknown[]) => mocks.purge(...args),
	dropParlumeTranscriptVectors: (...args: unknown[]) => mocks.drop(...args),
}));

vi.mock("../../lib/delete-channel-context", () => ({
	drainPendingVectorCleanup: (...args: unknown[]) => mocks.drain(...args),
}));

vi.mock("../parlume-log", () => ({
	parlumeActivityLog: () => undefined,
}));

import { purgeExpiredParlumeTranscripts } from "../parlume-retention";

function cleanup(id: string, contextId: string) {
	return {
		id,
		projectId: "project-1",
		contextIds: [contextId],
		userId: null,
		organizationId: "example-org",
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.list.mockResolvedValue([]);
	mocks.drop.mockResolvedValue([]);
	mocks.drain.mockResolvedValue(undefined);
});

describe("purgeExpiredParlumeTranscripts", () => {
	it("purges the transcripts of the sessions past retention, in batches, and drains their vectors", async () => {
		mocks.list.mockResolvedValue([
			{ id: "old-1", projectId: "project-1" },
			{ id: "old-2", projectId: "project-1" },
		]);
		mocks.purge
			.mockResolvedValueOnce({
				purged: true,
				vectorCleanup: cleanup("cleanup-1", "context-1"),
			})
			.mockResolvedValueOnce({ purged: true, vectorCleanup: null });

		const result = await purgeExpiredParlumeTranscripts();

		expect(mocks.list).toHaveBeenCalledWith({
			now: expect.any(Date),
			limit: 50,
		});
		// The sweep's scope keeps the requests, suggestions and notes.
		expect(mocks.purge).toHaveBeenNthCalledWith(1, {
			sessionId: "old-1",
			projectId: "project-1",
			scope: "TRANSCRIPT",
		});
		expect(mocks.purge).toHaveBeenNthCalledWith(2, {
			sessionId: "old-2",
			projectId: "project-1",
			scope: "TRANSCRIPT",
		});
		expect(mocks.drain).toHaveBeenCalledWith(
			cleanup("cleanup-1", "context-1"),
		);
		expect(result).toEqual({
			purgedSessions: 2,
			droppedVectors: 0,
			undrained: 0,
		});
	});

	it("leaves newer sessions alone: only what the retention query lists is purged", async () => {
		const result = await purgeExpiredParlumeTranscripts();

		expect(mocks.purge).not.toHaveBeenCalled();
		expect(result.purgedSessions).toBe(0);
	});

	it("counts a session another run already purged as nothing done, so a second run is harmless", async () => {
		mocks.list.mockResolvedValue([{ id: "old-1", projectId: "project-1" }]);
		mocks.purge.mockResolvedValue({ purged: false, vectorCleanup: null });

		await expect(purgeExpiredParlumeTranscripts()).resolves.toEqual({
			purgedSessions: 0,
			droppedVectors: 0,
			undrained: 0,
		});
		expect(mocks.drain).not.toHaveBeenCalled();
	});

	it("takes any still-embedded Parlume transcript out of the index", async () => {
		mocks.drop.mockResolvedValue([cleanup("cleanup-2", "context-2")]);

		const result = await purgeExpiredParlumeTranscripts();

		expect(mocks.drop).toHaveBeenCalledWith({ limit: 50 });
		expect(mocks.drain).toHaveBeenCalledWith(
			cleanup("cleanup-2", "context-2"),
		);
		expect(result.droppedVectors).toBe(1);
	});

	it("leaves a failed drain queued for the pending-cleanup sweep and finishes the run", async () => {
		mocks.list.mockResolvedValue([{ id: "old-1", projectId: "project-1" }]);
		mocks.purge.mockResolvedValue({
			purged: true,
			vectorCleanup: cleanup("cleanup-1", "context-1"),
		});
		mocks.drop.mockResolvedValue([cleanup("cleanup-2", "context-2")]);
		mocks.drain
			.mockRejectedValueOnce(new Error("vector store unavailable"))
			.mockResolvedValueOnce(undefined);

		await expect(purgeExpiredParlumeTranscripts()).resolves.toEqual({
			purgedSessions: 1,
			droppedVectors: 1,
			undrained: 1,
		});
		expect(mocks.drain).toHaveBeenCalledTimes(2);
	});
});
