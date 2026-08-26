import { beforeEach, describe, expect, it, vi } from "vitest";

// Preserve all real @repo/database exports (pm-state-poll.ts imports many at
// module scope); override only the helpers the producer calls.
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	findFabricItemsByExternalId: vi.fn(),
	incrementMissingStreak: vi.fn(),
	pendingFlagMissingExists: vi.fn(),
	resetMissingStreaks: vi.fn(),
	upsertPendingChange: vi.fn(),
	autoDismissReappearedFlagMissing: vi.fn(),
	recordAudit: vi.fn(),
	db: { project: { findUnique: vi.fn() } },
}));

import {
	autoDismissReappearedFlagMissing,
	db,
	findFabricItemsByExternalId,
	incrementMissingStreak,
	pendingFlagMissingExists,
	recordAudit,
	resetMissingStreaks,
	upsertPendingChange,
} from "@repo/database";
import {
	reconcileMissingTickets,
	STREAK_THRESHOLD,
} from "../src/activities/pm-integration/pm-state-poll";

const q = {
	findFabricItemsByExternalId: vi.mocked(findFabricItemsByExternalId),
	incrementMissingStreak: vi.mocked(incrementMissingStreak),
	pendingFlagMissingExists: vi.mocked(pendingFlagMissingExists),
	resetMissingStreaks: vi.mocked(resetMissingStreaks),
	upsertPendingChange: vi.mocked(upsertPendingChange),
};

beforeEach(() => {
	vi.clearAllMocks();
	q.resetMissingStreaks.mockResolvedValue(undefined);
	q.pendingFlagMissingExists.mockResolvedValue(false);
	q.upsertPendingChange.mockResolvedValue({
		action: "created",
		pendingId: "x",
	});
	// Default: no stale FLAG_MISSING rows to auto-dismiss (#1360). Individual
	// tests override this.
	vi.mocked(autoDismissReappearedFlagMissing).mockResolvedValue([]);
});

const base = {
	projectId: "p1",
	activeServerId: "srv-1",
	pollRunId: "run-1",
};

describe("reconcileMissingTickets", () => {
	it("resets streaks for seen externalIds", async () => {
		await reconcileMissingTickets({
			...base,
			seenExternalIds: ["1", "2"],
			notFoundIds: [],
			totalLinked: 5,
		});
		expect(q.resetMissingStreaks).toHaveBeenCalledWith("p1", ["1", "2"]);
	});

	it("does not increment during an outage (>=50% not-found, >=3 linked)", async () => {
		await reconcileMissingTickets({
			...base,
			seenExternalIds: [],
			notFoundIds: ["a", "b"],
			totalLinked: 4,
		});
		expect(q.incrementMissingStreak).not.toHaveBeenCalled();
	});

	it("flags only at the streak threshold", async () => {
		q.findFabricItemsByExternalId.mockResolvedValue([
			{
				entityType: "STORY",
				entityId: "s1",
				draftingStage: "DRAFT",
				externalMcpServerId: "srv-1",
			},
		]);
		q.incrementMissingStreak.mockResolvedValueOnce(STREAK_THRESHOLD - 1);
		let created = await reconcileMissingTickets({
			...base,
			seenExternalIds: [],
			notFoundIds: ["123"],
			totalLinked: 10,
		});
		expect(q.upsertPendingChange).not.toHaveBeenCalled();
		expect(created).toBe(0);

		q.incrementMissingStreak.mockResolvedValueOnce(STREAK_THRESHOLD);
		created = await reconcileMissingTickets({
			...base,
			seenExternalIds: [],
			notFoundIds: ["123"],
			totalLinked: 10,
		});
		expect(q.upsertPendingChange).toHaveBeenCalledWith(
			expect.objectContaining({
				proposedAction: "FLAG_MISSING",
				externalId: "123",
				entityType: "STORY",
				entityId: "s1",
				// Fix B: the story's active server is stamped on the proposal so the
				// unlink predicate can refuse a later retool to a different server.
				expectedExternalMcpServerId: "srv-1",
			}),
		);
		expect(created).toBe(1);
	});

	it("passes the pollRunId through to incrementMissingStreak (Fix C)", async () => {
		q.findFabricItemsByExternalId.mockResolvedValue([
			{
				entityType: "STORY",
				entityId: "s1",
				draftingStage: "DRAFT",
				externalMcpServerId: "srv-1",
			},
		]);
		q.incrementMissingStreak.mockResolvedValue(1);
		await reconcileMissingTickets({
			...base,
			pollRunId: "run-XYZ",
			seenExternalIds: [],
			notFoundIds: ["123"],
			totalLinked: 10,
		});
		expect(q.incrementMissingStreak).toHaveBeenCalledWith(
			expect.objectContaining({ pollRunId: "run-XYZ" }),
		);
	});

	it("skips a cross-tool story (externalMcpServerId != active)", async () => {
		q.findFabricItemsByExternalId.mockResolvedValue([
			{
				entityType: "STORY",
				entityId: "s1",
				draftingStage: "DRAFT",
				externalMcpServerId: "OTHER",
			},
		]);
		await reconcileMissingTickets({
			...base,
			seenExternalIds: [],
			notFoundIds: ["123"],
			totalLinked: 10,
		});
		expect(q.incrementMissingStreak).not.toHaveBeenCalled();
	});

	it("skips a null-server story (unknown provenance)", async () => {
		q.findFabricItemsByExternalId.mockResolvedValue([
			{
				entityType: "STORY",
				entityId: "s1",
				draftingStage: "DRAFT",
				externalMcpServerId: null,
			},
		]);
		await reconcileMissingTickets({
			...base,
			seenExternalIds: [],
			notFoundIds: ["123"],
			totalLinked: 10,
		});
		expect(q.incrementMissingStreak).not.toHaveBeenCalled();
	});

	it("skips a notFoundId that resolves to no entity (orphan)", async () => {
		q.findFabricItemsByExternalId.mockResolvedValue([]);
		await reconcileMissingTickets({
			...base,
			seenExternalIds: [],
			notFoundIds: ["123"],
			totalLinked: 10,
		});
		expect(q.incrementMissingStreak).not.toHaveBeenCalled();
	});

	it("de-duplicates notFoundIds", async () => {
		q.findFabricItemsByExternalId.mockResolvedValue([
			{
				entityType: "STORY",
				entityId: "s1",
				draftingStage: "DRAFT",
				externalMcpServerId: "srv-1",
			},
		]);
		q.incrementMissingStreak.mockResolvedValue(1);
		await reconcileMissingTickets({
			...base,
			seenExternalIds: [],
			notFoundIds: ["123", "123"],
			totalLinked: 10,
		});
		expect(q.incrementMissingStreak).toHaveBeenCalledTimes(1);
	});

	// Fix A: a non-not-found failure (auth/transient) is simply absent from
	// notFoundIds — it never reaches reconcile, so the streak neither increments
	// nor resets. A transient blip between two not-found cycles does NOT reset the
	// streak; the ticket still flags on the 3rd not-found cycle.
	it("holds the streak across a transient (non-not-found) cycle and still flags", async () => {
		q.findFabricItemsByExternalId.mockResolvedValue([
			{
				entityType: "STORY",
				entityId: "s1",
				draftingStage: "DRAFT",
				externalMcpServerId: "srv-1",
			},
		]);
		// Real streak: increments on each not-found cycle, capped at threshold.
		let streak = 0;
		q.incrementMissingStreak.mockImplementation(async () => {
			streak = Math.min(streak + 1, STREAK_THRESHOLD);
			return streak;
		});

		const nf = (notFoundIds: string[]) => ({
			...base,
			seenExternalIds: [] as string[],
			notFoundIds,
			totalLinked: 10,
		});

		// Cycle 1: not-found → streak 1, no flag.
		expect(await reconcileMissingTickets(nf(["123"]))).toBe(0);
		// Cycle 2: transient (auth) failure → externalId NOT in notFoundIds.
		// The streak helper is not called for it; seenExternalIds is empty so no
		// reset of 123's streak occurs.
		expect(await reconcileMissingTickets(nf([]))).toBe(0);
		expect(q.resetMissingStreaks).toHaveBeenLastCalledWith("p1", []);
		// Cycle 3: not-found → streak 2.
		expect(await reconcileMissingTickets(nf(["123"]))).toBe(0);
		// Cycle 4: not-found → streak 3 → flag.
		expect(await reconcileMissingTickets(nf(["123"]))).toBe(1);
		expect(q.upsertPendingChange).toHaveBeenCalledWith(
			expect.objectContaining({
				proposedAction: "FLAG_MISSING",
				externalId: "123",
			}),
		);
	});

	it("outage guard trips on the notFoundIds ratio, not all failures", async () => {
		q.findFabricItemsByExternalId.mockResolvedValue([
			{
				entityType: "STORY",
				entityId: "s1",
				draftingStage: "DRAFT",
				externalMcpServerId: "srv-1",
			},
		]);
		// 2 of 4 linked are definite not-found → 50% → outage guard suppresses.
		const created = await reconcileMissingTickets({
			...base,
			seenExternalIds: [],
			notFoundIds: ["1", "2"],
			totalLinked: 4,
		});
		expect(created).toBe(0);
		expect(q.incrementMissingStreak).not.toHaveBeenCalled();
	});

	it("caps net-new creates per cycle; over-cap ids hold streak", async () => {
		const ids = Array.from({ length: 15 }, (_, i) => `id${i}`); // 15 new, cap is 10
		q.findFabricItemsByExternalId.mockImplementation(async (_p, ext) => [
			{
				entityType: "STORY",
				entityId: ext,
				externalMcpServerId: "srv-1",
				draftingStage: "X",
			},
		]);
		q.incrementMissingStreak.mockResolvedValue(3);
		q.pendingFlagMissingExists.mockResolvedValue(false); // all NEW
		q.upsertPendingChange.mockResolvedValue({
			action: "created",
			pendingId: "x",
		});
		const flagged = await reconcileMissingTickets({
			projectId: "p",
			activeServerId: "srv-1",
			pollRunId: "r1",
			seenExternalIds: [],
			notFoundIds: ids,
			totalLinked: 100,
		});
		expect(flagged).toBe(10);
		expect(q.upsertPendingChange).toHaveBeenCalledTimes(10); // over-cap NEW skipped
		expect(q.incrementMissingStreak).toHaveBeenCalledTimes(15); // all streaks advanced
	});

	it("two-cycle drip: existing rows refresh without consuming budget; next ids create", async () => {
		const ids = Array.from({ length: 12 }, (_, i) => `id${i}`); // cap 10
		q.findFabricItemsByExternalId.mockImplementation(async (_p, ext) => [
			{
				entityType: "STORY",
				entityId: ext,
				externalMcpServerId: "srv-1",
				draftingStage: "X",
			},
		]);
		q.incrementMissingStreak.mockResolvedValue(3);
		const existing = new Set([
			"id0",
			"id1",
			"id2",
			"id3",
			"id4",
			"id5",
			"id6",
			"id7",
			"id8",
			"id9",
		]);
		q.pendingFlagMissingExists.mockImplementation(
			async ({ entityId }: { entityId: string }) =>
				existing.has(entityId),
		);
		q.upsertPendingChange.mockImplementation(
			async ({ entityId }: { entityId: string }) => ({
				action: existing.has(entityId) ? "updated" : "created",
				pendingId: "x",
			}),
		);
		const flagged = await reconcileMissingTickets({
			projectId: "p",
			activeServerId: "srv-1",
			pollRunId: "r1",
			seenExternalIds: [],
			notFoundIds: ids,
			totalLinked: 100,
		});
		expect(q.upsertPendingChange).toHaveBeenCalledTimes(12); // 10 refresh + 2 new
		expect(flagged).toBe(12);
		const created = q.upsertPendingChange.mock.calls
			.map((c) => (c[0] as { entityId: string }).entityId)
			.filter((e) => ["id10", "id11"].includes(e));
		expect(created.sort()).toEqual(["id10", "id11"]);
	});

	it("flags an EPIC at threshold (server match)", async () => {
		q.findFabricItemsByExternalId.mockResolvedValue([
			{
				entityType: "EPIC",
				entityId: "epic-1",
				draftingStage: "PUBLISHED",
				externalMcpServerId: "srv-1",
			},
		]);
		q.incrementMissingStreak.mockResolvedValue(STREAK_THRESHOLD);
		q.pendingFlagMissingExists.mockResolvedValue(false);
		q.upsertPendingChange.mockResolvedValue({
			action: "created",
			pendingId: "x",
		});
		await reconcileMissingTickets({
			projectId: "p1",
			activeServerId: "srv-1",
			pollRunId: "r1",
			seenExternalIds: [],
			notFoundIds: ["AB#1"],
			totalLinked: 10,
		});
		expect(q.incrementMissingStreak).toHaveBeenCalledWith(
			expect.objectContaining({ entityType: "EPIC", entityId: "epic-1" }),
		);
		expect(q.upsertPendingChange).toHaveBeenCalledWith(
			expect.objectContaining({
				entityType: "EPIC",
				proposedAction: "FLAG_MISSING",
			}),
		);
	});

	it("plural: an externalId on BOTH an epic and a story flags BOTH (no masking)", async () => {
		q.findFabricItemsByExternalId.mockResolvedValue([
			{
				entityType: "EPIC",
				entityId: "epic-1",
				draftingStage: "PUBLISHED",
				externalMcpServerId: "srv-1",
			},
			{
				entityType: "STORY",
				entityId: "story-1",
				draftingStage: "DRAFT",
				externalMcpServerId: "srv-1",
			},
		]);
		q.incrementMissingStreak.mockResolvedValue(STREAK_THRESHOLD);
		q.pendingFlagMissingExists.mockResolvedValue(false);
		q.upsertPendingChange.mockResolvedValue({
			action: "created",
			pendingId: "x",
		});
		await reconcileMissingTickets({
			projectId: "p1",
			activeServerId: "srv-1",
			pollRunId: "r1",
			seenExternalIds: [],
			notFoundIds: ["AB#1"],
			totalLinked: 10,
		});
		expect(q.upsertPendingChange).toHaveBeenCalledWith(
			expect.objectContaining({ entityType: "EPIC", entityId: "epic-1" }),
		);
		expect(q.upsertPendingChange).toHaveBeenCalledWith(
			expect.objectContaining({
				entityType: "STORY",
				entityId: "story-1",
			}),
		);
	});

	it("epic with cross-server provenance is skipped", async () => {
		q.findFabricItemsByExternalId.mockResolvedValue([
			{
				entityType: "EPIC",
				entityId: "epic-1",
				draftingStage: "PUBLISHED",
				externalMcpServerId: "OTHER",
			},
		]);
		await reconcileMissingTickets({
			projectId: "p1",
			activeServerId: "srv-1",
			pollRunId: "r1",
			seenExternalIds: [],
			notFoundIds: ["AB#1"],
			totalLinked: 10,
		});
		expect(q.incrementMissingStreak).not.toHaveBeenCalled();
	});
});

describe("reconcileMissingTickets — auto-dismiss on reappear", () => {
	it("auto-dismisses stale FLAG_MISSING for seen ids and audits each", async () => {
		vi.mocked(resetMissingStreaks).mockResolvedValue(undefined);
		vi.mocked(autoDismissReappearedFlagMissing).mockResolvedValue([
			{ entityType: "STORY", entityId: "s1", externalId: "123" },
		]);
		vi.mocked(db.project.findUnique).mockResolvedValue({
			organizationId: "org-1",
		} as any);

		await reconcileMissingTickets({
			projectId: "p1",
			activeServerId: "srv-1",
			pollRunId: "run-1",
			seenExternalIds: ["123"],
			notFoundIds: [],
			totalLinked: 1,
		});

		expect(autoDismissReappearedFlagMissing).toHaveBeenCalledWith({
			projectId: "p1",
			externalIds: ["123"],
			activeServerId: "srv-1",
		});
		expect(recordAudit).toHaveBeenCalledTimes(1);
		expect(vi.mocked(recordAudit).mock.calls[0][0]).toMatchObject({
			action: "story.pm_flag_missing_auto_dismissed",
			organizationId: "org-1",
			resource: { type: "story", id: "s1" },
		});
	});

	it("does not look up org or audit when nothing is dismissed", async () => {
		vi.mocked(autoDismissReappearedFlagMissing).mockResolvedValue([]);
		await reconcileMissingTickets({
			projectId: "p1",
			activeServerId: "srv-1",
			pollRunId: "run-1",
			seenExternalIds: ["123"],
			notFoundIds: [],
			totalLinked: 1,
		});
		expect(db.project.findUnique).not.toHaveBeenCalled();
		expect(recordAudit).not.toHaveBeenCalled();
	});
});
