/**
 * The meeting digest's completion toggle (#1896, and #2340's snapshot).
 *
 * WHY THIS FILE CHANGED SHAPE. It used to mock `db.projectMeetingActionItem`
 * and assert the `updateMany` this function performed itself. The write moved
 * into `@repo/database` (`setActionItemCompletion`) when
 * `ProjectMeetingActionItem.completedAt` stopped being a value this surface
 * alone reads: the consolidated To Do list keeps
 * `TodoItem.lastKnownCompletedAt` as a snapshot of that column, and the two have
 * to be written in one transaction, over the same partition the To Do read
 * numbers occurrences with. The row-level assertions therefore live beside that
 * code, in `packages/database/prisma/queries/todos/__tests__/`; what is left
 * here is what this layer still decides — which arguments the write is given,
 * and how "no such item in this project" is reported to the client.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { setActionItemCompletion, recordAudit } = vi.hoisted(() => ({
	setActionItemCompletion: vi.fn(),
	recordAudit: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		setActionItemCompletion,
	};
});
vi.mock("@repo/api/lib/audit", () => ({
	recordAuditFromRequest: recordAudit,
}));

import { applyActionItemCompletion } from "@repo/api/modules/projects/procedures/meeting-digest/set-action-item-completed";

const ORG = "org-acme";

describe("applyActionItemCompletion", () => {
	beforeEach(() => vi.clearAllMocks());

	it("sets completedAt/completedById when completing", async () => {
		const completedAt = new Date("2026-09-18T12:00:00.000Z");
		setActionItemCompletion.mockResolvedValue({
			matched: true,
			completedAt,
			snapshotWrites: 1,
		});

		const res = await applyActionItemCompletion({
			projectId: "p1",
			actionItemId: "a1",
			userId: "u1",
			completed: true,
			organizationId: ORG,
		});

		expect(res.success).toBe(true);
		expect(res.completedAt).toBe(completedAt);
		expect(setActionItemCompletion).toHaveBeenCalledWith(
			expect.objectContaining({
				actionItemId: "a1",
				// The scope guard: applied through the transcript relation,
				// because a linked-meeting row has no `projectId` of its own.
				projectId: "p1",
				userId: "u1",
				completed: true,
				// The tenant whose partition the bound to-do's occurrence is
				// counted in. Omitting it is why the snapshot half would be
				// skipped, so it is part of the call and not an afterthought.
				organizationId: ORG,
			}),
		);
	});

	it("clears completion when un-completing", async () => {
		setActionItemCompletion.mockResolvedValue({
			matched: true,
			completedAt: null,
			snapshotWrites: 1,
		});

		const res = await applyActionItemCompletion({
			projectId: "p1",
			actionItemId: "a1",
			userId: "u1",
			completed: false,
			organizationId: ORG,
		});

		expect(res.completedAt).toBeNull();
		expect(setActionItemCompletion).toHaveBeenCalledWith(
			expect.objectContaining({ completed: false }),
		);
	});

	it("throws NOT_FOUND when the item is not in this project", async () => {
		setActionItemCompletion.mockResolvedValue({
			matched: false,
			completedAt: null,
			snapshotWrites: 0,
		});

		await expect(
			applyActionItemCompletion({
				projectId: "p1",
				actionItemId: "a1",
				userId: "u1",
				completed: true,
				organizationId: ORG,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("succeeds when no to-do was bound to the item", async () => {
		// Every organization that uses the digest and has never opened the To
		// Do list is this case, on every click: the action item is the truth,
		// and a to-do that does not exist has nothing to remember.
		setActionItemCompletion.mockResolvedValue({
			matched: true,
			completedAt: new Date("2026-09-18T12:00:00.000Z"),
			snapshotWrites: 0,
		});

		await expect(
			applyActionItemCompletion({
				projectId: "p1",
				actionItemId: "a1",
				userId: "u1",
				completed: true,
				organizationId: ORG,
			}),
		).resolves.toMatchObject({ success: true });
	});
});
