/**
 * The meeting digest's completion write, and the snapshot it now maintains
 * (#2340).
 *
 * What this file proves. Prisma's model delegates are mocked, so it pins WHICH
 * ROW each write addresses, WITH WHAT SCOPE, and — the point of the whole
 * module — that the action item's completion and the bound to-do's snapshot
 * land in ONE transaction:
 *
 *  - `ProjectMeetingActionItem.completedAt` has two writers, not one. This is
 *    the older and busier of them, and before it maintained
 *    `TodoItem.lastKnownCompletedAt` a digest completion left the To Do page
 *    able to claim a reworded item had never been done, and a digest reopen left
 *    it able to claim a completion the person had explicitly taken back.
 *  - The occurrence is counted over the partition the To Do read's
 *    `ROW_NUMBER() OVER (PARTITION BY transcriptId, itemKey ORDER BY
 *    orderIndex)` produces, filtered by the same organization. A different
 *    partition would snapshot a different commitment.
 *  - A transcript with no to-dos behind it is the ordinary case for every
 *    digest-only organization, and it is a no-op, never a refusal.
 *
 * It cannot prove what Postgres returns; that needs a database.
 *
 * Run with:
 *   pnpm --filter @repo/database test complete-action-item
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	/** Top-level delegates. Any call here is a write OUTSIDE the transaction. */
	actionItem: {
		findFirst: vi.fn(),
		findMany: vi.fn(),
		updateMany: vi.fn(),
	},
	todoItem: { updateMany: vi.fn() },
	tx: {
		projectMeetingActionItem: {
			findFirst: vi.fn(),
			findMany: vi.fn(),
			updateMany: vi.fn(),
		},
		todoItem: { updateMany: vi.fn() },
	},
}));

vi.mock("../../../client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			projectMeetingActionItem: mocks.actionItem,
			todoItem: mocks.todoItem,
			// The callback runs against a tx whose delegates are separately
			// observable, so "inside the transaction" is an assertion this file
			// can make rather than a comment it repeats.
			$transaction: (
				fn: (tx: typeof mocks.tx) => Promise<unknown>,
			): Promise<unknown> => fn(mocks.tx),
		},
	};
});

const { setActionItemCompletion } = await import("../complete-action-item");

const ORG = "org-acme";
const PROJECT = "project-1";
const TRANSCRIPT = "transcript-1";
const KEY = "key-1";
const USER = "user-dana";
const NOW = new Date("2026-09-18T12:00:00.000Z");

beforeEach(() => {
	for (const fn of [
		mocks.actionItem.findFirst,
		mocks.actionItem.findMany,
		mocks.actionItem.updateMany,
		mocks.todoItem.updateMany,
		mocks.tx.projectMeetingActionItem.findFirst,
		mocks.tx.projectMeetingActionItem.findMany,
		mocks.tx.projectMeetingActionItem.updateMany,
		mocks.tx.todoItem.updateMany,
	]) {
		fn.mockReset();
	}
	mocks.tx.projectMeetingActionItem.updateMany.mockResolvedValue({
		count: 1,
	});
	mocks.tx.projectMeetingActionItem.findFirst.mockResolvedValue({
		id: "item-a",
		transcriptId: TRANSCRIPT,
		itemKey: KEY,
	});
	mocks.tx.projectMeetingActionItem.findMany.mockResolvedValue([
		{ id: "item-a" },
	]);
	mocks.tx.todoItem.updateMany.mockResolvedValue({ count: 1 });
});

function complete(overrides: Record<string, unknown> = {}) {
	return setActionItemCompletion({
		actionItemId: "item-a",
		projectId: PROJECT,
		organizationId: ORG,
		userId: USER,
		completed: true,
		now: NOW,
		...overrides,
	});
}

describe("setActionItemCompletion — the action item", () => {
	it("writes completion through the transcript relation, never a bare id", async () => {
		const result = await complete();

		expect(result).toMatchObject({ matched: true, completedAt: NOW });
		expect(
			mocks.tx.projectMeetingActionItem.updateMany,
		).toHaveBeenCalledWith({
			// A linked-meeting action item has no `projectId` column of its
			// own, so an id paired with someone else's project can only be
			// refused through the relation.
			where: { id: "item-a", transcript: { projectId: PROJECT } },
			data: { completedAt: NOW, completedById: USER },
		});
	});

	it("reports no match rather than inventing one", async () => {
		mocks.tx.projectMeetingActionItem.updateMany.mockResolvedValue({
			count: 0,
		});

		const result = await complete();

		expect(result).toEqual({
			matched: false,
			completedAt: NOW,
			snapshotWrites: 0,
		});
		// Nothing was snapshotted for a row that was never written.
		expect(mocks.tx.todoItem.updateMany).not.toHaveBeenCalled();
	});
});

describe("setActionItemCompletion — the to-do snapshot", () => {
	it("stamps lastKnownCompletedAt on the bound row, in the same transaction", async () => {
		const result = await complete();

		expect(result.snapshotWrites).toBe(1);
		expect(mocks.tx.todoItem.updateMany).toHaveBeenCalledWith({
			// Addressed by the binding triple the to-do actually uses. The
			// action item's id is not stable — extraction deletes and recreates
			// these rows on every run — so it cannot be the address.
			where: {
				transcriptId: TRANSCRIPT,
				itemKey: KEY,
				occurrenceIndex: 0,
				organizationId: ORG,
			},
			data: {
				lastKnownCompletedAt: NOW,
				// Cleared exactly as `setTodoCompletion`'s bound branch clears
				// them: a bound row's completion lives on the action item, and a
				// row completed while it was orphaned would otherwise keep
				// reporting itself completed through the read's COALESCE once
				// its binding resolved again.
				completedAt: null,
				completedById: null,
			},
		});
		// Both writes are the transaction's. A snapshot written outside it could
		// survive a completion that rolled back.
		expect(mocks.todoItem.updateMany).not.toHaveBeenCalled();
		expect(mocks.actionItem.updateMany).not.toHaveBeenCalled();
	});

	it("clears the snapshot when the digest takes the completion back", async () => {
		const result = await setActionItemCompletion({
			actionItemId: "item-a",
			projectId: PROJECT,
			organizationId: ORG,
			userId: USER,
			completed: false,
			now: NOW,
		});

		expect(result.completedAt).toBeNull();
		expect(
			mocks.tx.projectMeetingActionItem.updateMany,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { completedAt: null, completedById: null },
			}),
		);
		// A stale snapshot is the whole defect this branch prevents: without it
		// a rewording would let the orphaned row claim a completion the person
		// had explicitly undone one click earlier.
		expect(mocks.tx.todoItem.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					lastKnownCompletedAt: null,
					completedAt: null,
					completedById: null,
				},
			}),
		);
	});

	it("counts the occurrence over the partition the read numbers", async () => {
		// Three items of one transcript normalizing to one key. The second in
		// ascending `orderIndex` is occurrence 1 — the identical rule
		// `bindActionItemsToTodos` applies and the read's ROW_NUMBER reproduces.
		mocks.tx.projectMeetingActionItem.findFirst.mockResolvedValue({
			id: "item-b",
			transcriptId: TRANSCRIPT,
			itemKey: KEY,
		});
		mocks.tx.projectMeetingActionItem.findMany.mockResolvedValue([
			{ id: "item-a" },
			{ id: "item-b" },
			{ id: "item-c" },
		]);

		await complete({ actionItemId: "item-b" });

		expect(mocks.tx.projectMeetingActionItem.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				// Exactly the read's window: the same partition columns, the
				// same tenancy filter, the same order. Narrowing it further
				// would shift every position in it.
				where: {
					transcriptId: TRANSCRIPT,
					itemKey: KEY,
					organizationId: ORG,
				},
				orderBy: [{ orderIndex: "asc" }],
			}),
		);
		expect(mocks.tx.todoItem.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ occurrenceIndex: 1 }),
			}),
		);
	});

	it("is a no-op, not an error, when no to-do is bound to the transcript", async () => {
		// Every organization that uses the digest and has never opened the To Do
		// list is this case, on every click.
		mocks.tx.todoItem.updateMany.mockResolvedValue({ count: 0 });

		const result = await complete();

		expect(result).toEqual({
			matched: true,
			completedAt: NOW,
			snapshotWrites: 0,
		});
	});

	it("skips the snapshot for a row written before the binding existed", async () => {
		// The read excludes `itemKey IS NULL` from its partition, so no to-do
		// can be bound to such a row and there is no position to count.
		mocks.tx.projectMeetingActionItem.findFirst.mockResolvedValue({
			id: "item-a",
			transcriptId: TRANSCRIPT,
			itemKey: null,
		});

		const result = await complete();

		expect(result).toMatchObject({ matched: true, snapshotWrites: 0 });
		expect(mocks.tx.todoItem.updateMany).not.toHaveBeenCalled();
	});

	it("skips the snapshot rather than partitioning across tenants", async () => {
		// No to-do is reachable without an organization — `listVisibleTodos` and
		// `loadTodoForMutation` both require one — so there is nothing to keep
		// in step, and an unfiltered partition would count positions over rows
		// the read never sees.
		const result = await complete({ organizationId: undefined });

		expect(result).toMatchObject({ matched: true, snapshotWrites: 0 });
		expect(
			mocks.tx.projectMeetingActionItem.findMany,
		).not.toHaveBeenCalled();
		expect(mocks.tx.todoItem.updateMany).not.toHaveBeenCalled();
	});
});
