import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirror the db mock harness from pending-pm-state-changes.test.ts
// (vi.hoisted so the mock factory can reference it before module init).
const mockStreak = vi.hoisted(() => ({
	findUnique: vi.fn(),
	upsert: vi.fn(),
	deleteMany: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: { pmTicketMissingStreak: mockStreak },
}));

import {
	incrementMissingStreak,
	resetMissingStreaks,
} from "../prisma/queries/pm-ticket-missing-streak";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("incrementMissingStreak", () => {
	it("increments an existing streak, capped at the threshold", async () => {
		mockStreak.findUnique.mockResolvedValue({ missStreak: 2 });
		mockStreak.upsert.mockResolvedValue({ missStreak: 3 });
		const n = await incrementMissingStreak({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			externalId: "123",
			cap: 3,
			pollRunId: "run-1",
		});
		expect(n).toBe(3);
		// capped: existing 2 + 1 = 3 (not 4) even if called again
		const updateArg = mockStreak.upsert.mock.calls[0][0];
		expect(updateArg.update.missStreak).toBe(3);
	});

	it("does not exceed the cap when already at threshold", async () => {
		mockStreak.findUnique.mockResolvedValue({ missStreak: 3 });
		mockStreak.upsert.mockResolvedValue({ missStreak: 3 });
		await incrementMissingStreak({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			externalId: "123",
			cap: 3,
			pollRunId: "run-1",
		});
		expect(mockStreak.upsert.mock.calls[0][0].update.missStreak).toBe(3);
	});

	it("creates a new streak at 1 when none exists", async () => {
		mockStreak.findUnique.mockResolvedValue(null);
		mockStreak.upsert.mockResolvedValue({ missStreak: 1 });
		const n = await incrementMissingStreak({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			externalId: "123",
			cap: 3,
			pollRunId: "run-1",
		});
		expect(n).toBe(1);
		expect(mockStreak.upsert.mock.calls[0][0].create.missStreak).toBe(1);
		// The cycle's run id is stamped so a retry of the same cycle is idempotent.
		expect(mockStreak.upsert.mock.calls[0][0].create.lastCountedRunId).toBe(
			"run-1",
		);
		expect(mockStreak.upsert.mock.calls[0][0].update.lastCountedRunId).toBe(
			"run-1",
		);
	});

	// Fix C: run-id-guarded idempotency.
	it("is idempotent within the same poll cycle (same pollRunId → no double count)", async () => {
		mockStreak.findUnique.mockResolvedValue({
			missStreak: 2,
			lastCountedRunId: "run-1",
		});
		const n = await incrementMissingStreak({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			externalId: "123",
			cap: 3,
			pollRunId: "run-1",
		});
		// Returns the existing value untouched; no DB write.
		expect(n).toBe(2);
		expect(mockStreak.upsert).not.toHaveBeenCalled();
	});

	it("increments again on a NEW poll cycle (different pollRunId)", async () => {
		mockStreak.findUnique.mockResolvedValue({
			missStreak: 2,
			lastCountedRunId: "run-1",
		});
		mockStreak.upsert.mockResolvedValue({ missStreak: 3 });
		const n = await incrementMissingStreak({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			externalId: "123",
			cap: 3,
			pollRunId: "run-2",
		});
		expect(n).toBe(3);
		expect(mockStreak.upsert).toHaveBeenCalledTimes(1);
		expect(mockStreak.upsert.mock.calls[0][0].update.lastCountedRunId).toBe(
			"run-2",
		);
	});
});

describe("resetMissingStreaks", () => {
	it("deletes streak rows for the seen externalIds", async () => {
		mockStreak.deleteMany.mockResolvedValue({ count: 2 });
		await resetMissingStreaks("p1", ["123", "456"]);
		expect(mockStreak.deleteMany).toHaveBeenCalledWith({
			where: { projectId: "p1", externalId: { in: ["123", "456"] } },
		});
	});

	it("no-ops on an empty seen list", async () => {
		await resetMissingStreaks("p1", []);
		expect(mockStreak.deleteMany).not.toHaveBeenCalled();
	});
});
