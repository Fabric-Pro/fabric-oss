import { beforeEach, describe, expect, it, vi } from "vitest";

const findManyMock = vi.hoisted(() => vi.fn());

vi.mock("../../../client", () => ({
	db: { userStory: { findMany: findManyMock } },
}));

import { rankStoryIdsBySemanticActivity } from "../story-activity-ranking";

const WHERE = { projectId: "project-1" };

/** Serve the edited partition and the never-edited partition separately. */
function stubPartitions(
	edited: Array<{ id: string; createdAt: Date; lastEditedAt: Date }>,
	neverEdited: Array<{ id: string; createdAt: Date }>,
) {
	findManyMock.mockImplementation(
		(args: { where: { lastEditedAt?: unknown } }) =>
			args.where.lastEditedAt === null
				? Promise.resolve(
						neverEdited.map((row) => ({
							...row,
							lastEditedAt: null,
						})),
					)
				: Promise.resolve(edited),
	);
}

describe("rankStoryIdsBySemanticActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("caps BOTH partition reads so a large project is never fully scanned", async () => {
		stubPartitions([], []);

		await rankStoryIdsBySemanticActivity(WHERE, 10);

		expect(findManyMock).toHaveBeenCalledTimes(2);
		for (const [args] of findManyMock.mock.calls) {
			expect(args.take).toBe(10);
			expect(args.where).toMatchObject(WHERE);
			expect(args.select).toEqual({
				id: true,
				createdAt: true,
				lastEditedAt: true,
			});
		}
	});

	it("orders each partition on the key that decides its rows' position", async () => {
		stubPartitions([], []);

		await rankStoryIdsBySemanticActivity(WHERE, 5);

		const [editedCall, neverEditedCall] = findManyMock.mock.calls.map(
			([args]) => args,
		);
		expect(editedCall.where.lastEditedAt).toEqual({ not: null });
		expect(editedCall.orderBy).toEqual({ lastEditedAt: "desc" });
		expect(neverEditedCall.where.lastEditedAt).toBeNull();
		expect(neverEditedCall.orderBy).toEqual({ createdAt: "desc" });
	});

	// The reason a compound `lastEditedAt desc nulls last, createdAt desc` is
	// NOT equivalent: it would rank every edited story above every never-edited
	// one, burying a story created today under one last touched years ago.
	it("interleaves a freshly created story among older edits", async () => {
		stubPartitions(
			[
				{
					id: "edited-yesterday",
					createdAt: new Date("2024-01-01T00:00:00.000Z"),
					lastEditedAt: new Date("2026-08-09T00:00:00.000Z"),
				},
				{
					id: "edited-long-ago",
					createdAt: new Date("2023-01-01T00:00:00.000Z"),
					lastEditedAt: new Date("2024-05-01T00:00:00.000Z"),
				},
			],
			[
				{
					id: "created-today",
					createdAt: new Date("2026-08-10T00:00:00.000Z"),
				},
			],
		);

		const ids = await rankStoryIdsBySemanticActivity(WHERE, 10);

		expect(ids).toEqual([
			"created-today",
			"edited-yesterday",
			"edited-long-ago",
		]);
	});

	it("returns at most `take` ids across both partitions combined", async () => {
		stubPartitions(
			[
				{
					id: "a",
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					lastEditedAt: new Date("2026-08-05T00:00:00.000Z"),
				},
				{
					id: "b",
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					lastEditedAt: new Date("2026-08-04T00:00:00.000Z"),
				},
			],
			[
				{ id: "c", createdAt: new Date("2026-08-03T00:00:00.000Z") },
				{ id: "d", createdAt: new Date("2026-08-02T00:00:00.000Z") },
			],
		);

		const ids = await rankStoryIdsBySemanticActivity(WHERE, 2);

		expect(ids).toEqual(["a", "b"]);
	});
});
