/**
 * Coverage for the priority-band history layer in
 * `packages/database/prisma/queries/projects/priority-history.ts`.
 *
 * The invariant the product asked for, and the one every other assertion here
 * exists to protect, is that a history row means the band MOVED. A
 * re-prioritization pass that agrees with the current band must write nothing —
 * no history row, no story update — so the Priority view reads as a record of
 * decisions rather than a log of every time the ranker ran.
 *
 * Run with:
 *   pnpm --filter @repo/database test prisma/queries/projects/__tests__/priority-history.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const userStoryFindMany = vi.fn();
const userStoryAggregate = vi.fn();
const userStoryUpdateMany = vi.fn();
const priorityChangeCreate = vi.fn();
const priorityChangeFindMany = vi.fn();
const priorityChangeCount = vi.fn();
const priorityChangeFindFirst = vi.fn();
const transaction = vi.fn();

// The transaction client and `db` are backed by the same mocks, so an
// assertion doesn't have to care which handle a write went through.
const client = {
	userStory: {
		findMany: (...args: unknown[]) => userStoryFindMany(...args),
		aggregate: (...args: unknown[]) => userStoryAggregate(...args),
		updateMany: (...args: unknown[]) => userStoryUpdateMany(...args),
	},
	storyPriorityChange: {
		create: (...args: unknown[]) => priorityChangeCreate(...args),
		findMany: (...args: unknown[]) => priorityChangeFindMany(...args),
		count: (...args: unknown[]) => priorityChangeCount(...args),
		findFirst: (...args: unknown[]) => priorityChangeFindFirst(...args),
	},
};

vi.mock("../../../client", () => ({
	db: {
		...client,
		$transaction: (fn: (tx: typeof client) => unknown) => transaction(fn),
	},
}));

const { applyPriorityChanges, listStoryPriorityHistory } = await import(
	"../priority-history"
);

const ACTOR = { id: "u-1", name: "A. Diaz" };

beforeEach(() => {
	for (const m of [
		userStoryFindMany,
		userStoryAggregate,
		userStoryUpdateMany,
		priorityChangeCreate,
		priorityChangeFindMany,
		priorityChangeCount,
		priorityChangeFindFirst,
		transaction,
	]) {
		m.mockReset();
	}
	userStoryAggregate.mockResolvedValue({ _max: { roadmapOrder: 4 } });
	userStoryUpdateMany.mockResolvedValue({ count: 1 });
	priorityChangeCreate.mockResolvedValue({});
	// listStoryPriorityHistory's count + oldest-row lookups default to "no
	// history"; the pagination tests below override them.
	priorityChangeCount.mockResolvedValue(0);
	priorityChangeFindFirst.mockResolvedValue(null);
	transaction.mockImplementation(async (fn: (tx: typeof client) => unknown) =>
		fn(client),
	);
});

describe("applyPriorityChanges — only real moves are written", () => {
	it("writes nothing for a request whose band already matches the story", async () => {
		userStoryFindMany.mockResolvedValue([
			{ id: "s-1", priority: "P1_HIGH" },
		]);

		const applied = await applyPriorityChanges(
			"p-1",
			[{ storyId: "s-1", toPriority: "P1_HIGH" }],
			"AI",
			ACTOR,
		);

		expect(applied).toEqual([]);
		expect(priorityChangeCreate).not.toHaveBeenCalled();
		expect(userStoryUpdateMany).not.toHaveBeenCalled();
		// Nothing to write means no transaction is opened at all.
		expect(transaction).not.toHaveBeenCalled();
	});

	it("writes exactly one row and one update when 1 of 3 moves", async () => {
		userStoryFindMany.mockResolvedValue([
			{ id: "s-1", priority: "P1_HIGH" },
			{ id: "s-2", priority: "P2_MEDIUM" },
			{ id: "s-3", priority: "P3_LOW" },
		]);

		const applied = await applyPriorityChanges(
			"p-1",
			[
				{ storyId: "s-1", toPriority: "P1_HIGH" },
				// The only genuine move in the batch.
				{
					storyId: "s-2",
					toPriority: "P0_CRITICAL",
					reason: "Data loss",
				},
				{ storyId: "s-3", toPriority: "P3_LOW" },
			],
			"AI",
			ACTOR,
		);

		expect(applied).toEqual([
			{
				storyId: "s-2",
				fromPriority: "P2_MEDIUM",
				toPriority: "P0_CRITICAL",
			},
		]);
		expect(priorityChangeCreate).toHaveBeenCalledTimes(1);
		expect(userStoryUpdateMany).toHaveBeenCalledTimes(1);
		expect(priorityChangeCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					storyId: "s-2",
					projectId: "p-1",
					fromPriority: "P2_MEDIUM",
					toPriority: "P0_CRITICAL",
					source: "AI",
					reason: "Data loss",
					actorId: "u-1",
					actorName: "A. Diaz",
				}),
			}),
		);
	});

	it("returns [] for an empty batch without touching the DB", async () => {
		const applied = await applyPriorityChanges("p-1", [], "AI", ACTOR);

		expect(applied).toEqual([]);
		expect(userStoryFindMany).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
	});

	it("collapses a duplicated storyId to one entry, last write winning", async () => {
		userStoryFindMany.mockResolvedValue([
			{ id: "s-1", priority: "P2_MEDIUM" },
		]);

		const applied = await applyPriorityChanges(
			"p-1",
			[
				{ storyId: "s-1", toPriority: "P0_CRITICAL" },
				{ storyId: "s-1", toPriority: "P3_LOW" },
			],
			"AI",
			ACTOR,
		);

		// A malformed batch must not leave two history rows for one story.
		expect(applied).toEqual([
			{ storyId: "s-1", fromPriority: "P2_MEDIUM", toPriority: "P3_LOW" },
		]);
		expect(priorityChangeCreate).toHaveBeenCalledTimes(1);
	});

	it("ignores ids that do not belong to the project", async () => {
		// The load is scoped by projectId, so a foreign id simply isn't in the
		// result set — the batch is best-effort rather than throwing.
		userStoryFindMany.mockResolvedValue([
			{ id: "s-1", priority: "P2_MEDIUM" },
		]);

		const applied = await applyPriorityChanges(
			"p-1",
			[
				{ storyId: "s-1", toPriority: "P0_CRITICAL" },
				{
					storyId: "s-from-another-project",
					toPriority: "P0_CRITICAL",
				},
			],
			"MANUAL",
			ACTOR,
		);

		expect(userStoryFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: { in: ["s-1", "s-from-another-project"] },
					projectId: "p-1",
				},
			}),
		);
		expect(applied.map((c) => c.storyId)).toEqual(["s-1"]);
		expect(priorityChangeCreate).toHaveBeenCalledTimes(1);
		// The write is re-scoped by projectId too, so the id filter is never
		// the only thing keeping the update inside the tenant.
		expect(userStoryUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "s-1", projectId: "p-1" },
			}),
		);
	});

	it("normalises a whitespace-only reason to null", async () => {
		userStoryFindMany.mockResolvedValue([
			{ id: "s-1", priority: "P2_MEDIUM" },
		]);

		await applyPriorityChanges(
			"p-1",
			[{ storyId: "s-1", toPriority: "P0_CRITICAL", reason: "   " }],
			"MANUAL",
			ACTOR,
		);

		// This is the single normalisation point for every priority write, so
		// a blank comment typed in the Priority view never reaches the history.
		expect(priorityChangeCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ reason: null }),
			}),
		);
	});
});

describe("applyPriorityChanges — roadmap ranks", () => {
	it("gives two items landing in the same band consecutive roadmapOrder values", async () => {
		userStoryFindMany.mockResolvedValue([
			{ id: "s-1", priority: "P3_LOW" },
			{ id: "s-2", priority: "P3_LOW" },
		]);

		// A stand-in for the band's real max, advanced by each write the way
		// Postgres would inside the transaction. The moves are applied in
		// sequence for exactly this reason: running them concurrently would
		// have both reads see the same max and both items claim rank 8.
		const bandMax = new Map<string, number>([["P0_CRITICAL", 7]]);
		userStoryAggregate.mockImplementation(
			async ({ where }: { where: { priority: string } }) => ({
				_max: { roadmapOrder: bandMax.get(where.priority) ?? null },
			}),
		);
		userStoryUpdateMany.mockImplementation(
			async ({
				data,
			}: {
				data: { priority: string; roadmapOrder: number };
			}) => {
				bandMax.set(
					data.priority,
					Math.max(
						bandMax.get(data.priority) ?? 0,
						data.roadmapOrder,
					),
				);
				return { count: 1 };
			},
		);

		await applyPriorityChanges(
			"p-1",
			[
				{ storyId: "s-1", toPriority: "P0_CRITICAL" },
				{ storyId: "s-2", toPriority: "P0_CRITICAL" },
			],
			"AI",
			ACTOR,
		);

		const orders = userStoryUpdateMany.mock.calls.map(
			([args]) => args.data.roadmapOrder,
		);
		expect(orders).toEqual([8, 9]);
	});

	it("starts a previously empty band at rank 1", async () => {
		userStoryFindMany.mockResolvedValue([
			{ id: "s-1", priority: "P3_LOW" },
		]);
		userStoryAggregate.mockResolvedValue({ _max: { roadmapOrder: null } });

		await applyPriorityChanges(
			"p-1",
			[{ storyId: "s-1", toPriority: "P0_CRITICAL" }],
			"AI",
			ACTOR,
		);

		const [args] = userStoryUpdateMany.mock.calls[0];
		expect(args.data.roadmapOrder).toBe(1);
	});

	it("stamps every row in a batch with one shared changedAt", async () => {
		userStoryFindMany.mockResolvedValue([
			{ id: "s-1", priority: "P3_LOW" },
			{ id: "s-2", priority: "P3_LOW" },
		]);

		await applyPriorityChanges(
			"p-1",
			[
				{ storyId: "s-1", toPriority: "P0_CRITICAL" },
				{ storyId: "s-2", toPriority: "P1_HIGH" },
			],
			"AI",
			ACTOR,
		);

		// One timestamp per batch keeps a single AI pass grouped in the
		// history instead of scattering it across milliseconds.
		const stamps = priorityChangeCreate.mock.calls.map(
			([args]) => args.data.createdAt,
		);
		expect(stamps[0]).toEqual(stamps[1]);
		const updateStamps = userStoryUpdateMany.mock.calls.map(
			([args]) => args.data.priorityChangedAt,
		);
		expect(updateStamps[0]).toEqual(stamps[0]);
	});
});

function historyRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "h-1",
		fromPriority: "P2_MEDIUM",
		toPriority: "P0_CRITICAL",
		source: "MANUAL",
		reason: null,
		actorId: "u-1",
		actorName: "Snapshotted Name",
		createdAt: new Date("2026-07-21T09:00:00Z"),
		actor: null,
		...overrides,
	};
}

describe("listStoryPriorityHistory — pagination", () => {
	it("over-fetches by one and reports a further page", async () => {
		priorityChangeFindMany.mockResolvedValue([
			historyRow({ id: "h-1" }),
			historyRow({ id: "h-2" }),
			historyRow({ id: "h-3" }),
		]);

		const result = await listStoryPriorityHistory({
			storyId: "s-1",
			projectId: "p-1",
			limit: 2,
		});

		expect(priorityChangeFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { storyId: "s-1", projectId: "p-1" },
				take: 3,
			}),
		);
		// The over-fetched row is dropped from the page and only announces
		// that another page exists.
		expect(result.items.map((i) => i.id)).toEqual(["h-1", "h-2"]);
		expect(result.nextCursor).toBe("h-2");
	});

	it("returns nextCursor null on the last page", async () => {
		priorityChangeFindMany.mockResolvedValue([
			historyRow({ id: "h-1" }),
			historyRow({ id: "h-2" }),
		]);

		const result = await listStoryPriorityHistory({
			storyId: "s-1",
			projectId: "p-1",
			limit: 2,
		});

		expect(result.items).toHaveLength(2);
		expect(result.nextCursor).toBeNull();
	});

	it("skips the cursor row itself when paging forward", async () => {
		priorityChangeFindMany.mockResolvedValue([historyRow({ id: "h-3" })]);

		await listStoryPriorityHistory({
			storyId: "s-1",
			projectId: "p-1",
			cursor: "h-2",
			limit: 2,
		});

		expect(priorityChangeFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ cursor: { id: "h-2" }, skip: 1 }),
		);
	});

	it("passes no cursor clause on the first page", async () => {
		priorityChangeFindMany.mockResolvedValue([]);

		await listStoryPriorityHistory({
			storyId: "s-1",
			projectId: "p-1",
			limit: 2,
		});

		const [args] = priorityChangeFindMany.mock.calls[0];
		expect(args).not.toHaveProperty("cursor");
		expect(args).not.toHaveProperty("skip");
	});
});

describe("listStoryPriorityHistory — actor identity", () => {
	it("prefers the live user's current name over the write-time snapshot", async () => {
		priorityChangeFindMany.mockResolvedValue([
			historyRow({
				actorName: "Stale Snapshot",
				actor: { name: "A. Diaz", image: "https://img/1.png" },
			}),
		]);

		const { items } = await listStoryPriorityHistory({
			storyId: "s-1",
			projectId: "p-1",
			limit: 10,
		});

		expect(items[0].actorName).toBe("A. Diaz");
		expect(items[0].actorImage).toBe("https://img/1.png");
	});

	it("falls back to the snapshot when the account is gone", async () => {
		priorityChangeFindMany.mockResolvedValue([
			historyRow({ actorName: "A. Diaz", actor: null }),
		]);

		const { items } = await listStoryPriorityHistory({
			storyId: "s-1",
			projectId: "p-1",
			limit: 10,
		});

		// A deleted user still reads as a person rather than a blank row.
		expect(items[0].actorName).toBe("A. Diaz");
		expect(items[0].actorImage).toBeNull();
	});
});

describe("listStoryPriorityHistory — initial band + total", () => {
	it("reports the total and the band the item was created with", async () => {
		priorityChangeFindMany.mockResolvedValue([
			historyRow({
				id: "h-3",
				fromPriority: "P1_HIGH",
				toPriority: "P0_CRITICAL",
			}),
		]);
		priorityChangeCount.mockResolvedValue(3);
		// The OLDEST row's `fromPriority` is what the item was before anything
		// touched it — that is the "created as" band.
		priorityChangeFindFirst.mockResolvedValue({
			fromPriority: "P2_MEDIUM",
		});

		const result = await listStoryPriorityHistory({
			storyId: "s-1",
			projectId: "p-1",
			limit: 10,
		});

		expect(result.totalCount).toBe(3);
		expect(result.initialPriority).toBe("P2_MEDIUM");
		// The oldest lookup must be scoped to the same story+project, ascending.
		const [firstArgs] = priorityChangeFindFirst.mock.calls[0] as [
			{ where: unknown; orderBy: unknown },
		];
		expect(firstArgs.where).toEqual({ storyId: "s-1", projectId: "p-1" });
	});

	it("returns a null initial band when the item has no history at all", async () => {
		priorityChangeFindMany.mockResolvedValue([]);
		priorityChangeCount.mockResolvedValue(0);
		priorityChangeFindFirst.mockResolvedValue(null);

		const result = await listStoryPriorityHistory({
			storyId: "s-1",
			projectId: "p-1",
			limit: 10,
		});

		expect(result.totalCount).toBe(0);
		// Null → the caller falls back to the current band, which is correct for
		// something that has never been re-banded.
		expect(result.initialPriority).toBeNull();
	});
});
