/**
 * The Teams channel monitor's per-thread watermark on the seen-message table.
 *
 * A seen row's effective watermark is `analyzedThroughAt`, or `createdAt` for
 * a legacy NULL row — the boundary that can never re-propose or mass
 * re-analyze, since everything the old analyzer saw predates its own insert.
 * Its documented limit: a reply that arrived during that original analysis
 * run stays unanalyzed, exactly as before this column existed. Moving a watermark
 * is a compare-and-swap against the value the fetch read, so two overlapping
 * revisits that read the same watermark cannot both record.
 *
 * The Prisma client is mocked; the interleave test uses a small stateful fake
 * that evaluates the exact WHERE the helper sends.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	updateMany: vi.fn(),
	createMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		projectLinkedTeamsChannelSeenMessage: {
			findMany: mocks.findMany,
			updateMany: mocks.updateMany,
			createMany: mocks.createMany,
		},
	},
}));

import {
	advanceTeamsThreadWatermark,
	getSeenThreadWatermarks,
	markTeamsMessagesAsSeen,
} from "../prisma/queries/projects/teams-channel-monitor";

const MINUTE_MS = 60 * 1000;
const INSERTED_AT = new Date("2026-09-01T12:00:00.000Z");
const ANALYZED_THROUGH = new Date("2026-09-01T10:30:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getSeenThreadWatermarks", () => {
	it("uses analyzedThroughAt when set, and createdAt when it is NULL", async () => {
		mocks.findMany.mockResolvedValue([
			{
				messageId: "root-new",
				analyzedThroughAt: ANALYZED_THROUGH,
				createdAt: INSERTED_AT,
			},
			{
				messageId: "root-legacy",
				analyzedThroughAt: null,
				createdAt: INSERTED_AT,
			},
		]);

		const watermarks = await getSeenThreadWatermarks("lc1", [
			"root-new",
			"root-legacy",
			"root-unseen",
		]);

		expect(watermarks.get("root-new")).toEqual(ANALYZED_THROUGH);
		expect(watermarks.get("root-legacy")).toEqual(INSERTED_AT);
		// Never analyzed: absent, not defaulted.
		expect(watermarks.has("root-unseen")).toBe(false);
		expect(mocks.findMany).toHaveBeenCalledWith({
			where: {
				linkedChannelId: "lc1",
				messageId: { in: ["root-new", "root-legacy", "root-unseen"] },
			},
			select: {
				messageId: true,
				analyzedThroughAt: true,
				createdAt: true,
			},
		});
	});

	it("treats a reply after a legacy row's insert as new, and one before it as not (documented legacy limit)", async () => {
		mocks.findMany.mockResolvedValue([
			{
				messageId: "root",
				analyzedThroughAt: null,
				createdAt: INSERTED_AT,
			},
		]);
		const afterInsert = INSERTED_AT.getTime() + 5 * MINUTE_MS;
		// Arrived while the old analysis was running (after its fetch, before
		// its insert). The row does not record what that run observed, so this
		// reply stays unanalyzed — exactly as before this column existed.
		const duringOldRun = INSERTED_AT.getTime() - 5 * MINUTE_MS;

		const watermark = (await getSeenThreadWatermarks("lc1", ["root"]))
			.get("root")
			?.getTime();

		expect(watermark).toBeDefined();
		expect(afterInsert > (watermark as number)).toBe(true);
		expect(duringOldRun > (watermark as number)).toBe(false);
	});

	it("does not query for an empty candidate list", async () => {
		const watermarks = await getSeenThreadWatermarks("lc1", []);
		expect(watermarks.size).toBe(0);
		expect(mocks.findMany).not.toHaveBeenCalled();
	});
});

describe("advanceTeamsThreadWatermark", () => {
	it("compare-and-swaps from the watermark the caller read (or a still-NULL legacy row)", async () => {
		mocks.updateMany.mockResolvedValue({ count: 1 });
		const next = new Date("2026-09-02T09:00:00.000Z");

		const count = await advanceTeamsThreadWatermark(
			"lc1",
			"root-1",
			ANALYZED_THROUGH,
			next,
		);

		expect(count).toBe(1);
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: {
				linkedChannelId: "lc1",
				messageId: "root-1",
				// The NULL arm carries no createdAt comparison on purpose.
				OR: [
					{ analyzedThroughAt: ANALYZED_THROUGH },
					{ analyzedThroughAt: null },
				],
			},
			data: { analyzedThroughAt: next },
		});
	});

	it("writes nothing and returns 0 unless next is strictly after expectedPrevious", async () => {
		expect(
			await advanceTeamsThreadWatermark(
				"lc1",
				"root-1",
				ANALYZED_THROUGH,
				ANALYZED_THROUGH,
			),
		).toBe(0);
		expect(
			await advanceTeamsThreadWatermark(
				"lc1",
				"root-1",
				ANALYZED_THROUGH,
				new Date(ANALYZED_THROUGH.getTime() - 1),
			),
		).toBe(0);
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("runs on the transaction client it is given", async () => {
		const txUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
		const tx = {
			projectLinkedTeamsChannelSeenMessage: { updateMany: txUpdateMany },
		} as unknown as Parameters<typeof advanceTeamsThreadWatermark>[4];

		await advanceTeamsThreadWatermark(
			"lc1",
			"root-1",
			ANALYZED_THROUGH,
			new Date("2026-09-02T09:00:00.000Z"),
			tx,
		);

		expect(txUpdateMany).toHaveBeenCalledTimes(1);
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	describe("two overlapping revisits that read the same watermark", () => {
		// One seen row, updated by a fake that evaluates the WHERE the helper
		// actually sends — so the test is about the condition, not about a
		// canned count.
		type Row = {
			linkedChannelId: string;
			messageId: string;
			createdAt: Date;
			analyzedThroughAt: Date | null;
		};
		type Filter = Record<string, unknown>;

		function matchesValue(value: unknown, filter: unknown): boolean {
			if (filter === null) {
				return value === null;
			}
			if (filter instanceof Date) {
				return (
					value instanceof Date &&
					value.getTime() === filter.getTime()
				);
			}
			if (typeof filter === "object") {
				const ops = filter as { lt?: Date };
				if (ops.lt !== undefined) {
					return (
						value instanceof Date &&
						value.getTime() < ops.lt.getTime()
					);
				}
				throw new Error(`unsupported filter ${JSON.stringify(filter)}`);
			}
			return value === filter;
		}

		function matches(row: Row, where: Filter): boolean {
			return Object.entries(where).every(([key, filter]) => {
				if (key === "OR") {
					return (filter as Filter[]).some((arm) =>
						matches(row, arm),
					);
				}
				return matchesValue(row[key as keyof Row], filter);
			});
		}

		function useRow(row: Row) {
			mocks.updateMany.mockImplementation(
				async (args: { where: Filter; data: Partial<Row> }) => {
					if (!matches(row, args.where)) {
						return { count: 0 };
					}
					Object.assign(row, args.data);
					return { count: 1 };
				},
			);
			return row;
		}

		const T0 = new Date("2026-09-01T10:30:00.000Z");
		const T1 = new Date("2026-09-01T14:00:00.000Z");
		const T2 = new Date("2026-09-01T15:00:00.000Z");

		it("lets only the first advance a stored watermark", async () => {
			const row = useRow({
				linkedChannelId: "lc1",
				messageId: "root-1",
				createdAt: INSERTED_AT,
				analyzedThroughAt: T0,
			});

			// Run A proposed for replies through T1; run B, which read the same
			// T0, proposed for replies through T2 — including A's reply.
			const a = await advanceTeamsThreadWatermark(
				"lc1",
				"root-1",
				T0,
				T1,
			);
			const b = await advanceTeamsThreadWatermark(
				"lc1",
				"root-1",
				T0,
				T2,
			);

			expect(a).toBe(1);
			expect(b).toBe(0);
			// B's reply at T2 is still newer than T1, so it is revisited next tick.
			expect(row.analyzedThroughAt).toEqual(T1);
		});

		it("lets only the first advance a legacy NULL row", async () => {
			const row = useRow({
				linkedChannelId: "lc1",
				messageId: "root-1",
				createdAt: INSERTED_AT,
				analyzedThroughAt: null,
			});
			// Both runs read the legacy fallback (createdAt) as the watermark.
			const afterInsert = new Date(INSERTED_AT.getTime() + 5 * MINUTE_MS);

			const a = await advanceTeamsThreadWatermark(
				"lc1",
				"root-1",
				INSERTED_AT,
				afterInsert,
			);
			const b = await advanceTeamsThreadWatermark(
				"lc1",
				"root-1",
				INSERTED_AT,
				T2,
			);

			// The NULL arm matched once and only once: after A the column is
			// no longer NULL, so B's identical expectedPrevious misses.
			expect(a).toBe(1);
			expect(b).toBe(0);
			expect(row.analyzedThroughAt).toEqual(afterInsert);
		});
	});
});

describe("markTeamsMessagesAsSeen", () => {
	it("writes analyzedThroughAt on insert when given", async () => {
		mocks.createMany.mockResolvedValue({ count: 1 });

		await markTeamsMessagesAsSeen(
			"lc1",
			["root-1"],
			null,
			ANALYZED_THROUGH,
		);

		expect(mocks.createMany).toHaveBeenCalledWith({
			data: [
				{
					linkedChannelId: "lc1",
					messageId: "root-1",
					pendingProposalId: null,
					analyzedThroughAt: ANALYZED_THROUGH,
				},
			],
			skipDuplicates: true,
		});
	});

	it("stays backward compatible: omitting it writes NULL", async () => {
		mocks.createMany.mockResolvedValue({ count: 1 });

		await markTeamsMessagesAsSeen("lc1", ["root-1"]);

		expect(mocks.createMany).toHaveBeenCalledWith({
			data: [
				{
					linkedChannelId: "lc1",
					messageId: "root-1",
					pendingProposalId: null,
					analyzedThroughAt: null,
				},
			],
			skipDuplicates: true,
		});
	});
});
