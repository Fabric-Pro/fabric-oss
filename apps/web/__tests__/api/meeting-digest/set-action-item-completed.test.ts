import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateMany, recordAudit } = vi.hoisted(() => ({
	updateMany: vi.fn(),
	recordAudit: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		db: {
			...actual.db,
			projectMeetingActionItem: { updateMany },
		},
	};
});
vi.mock("@repo/api/lib/audit", () => ({
	recordAuditFromRequest: recordAudit,
}));

import { applyActionItemCompletion } from "@repo/api/modules/projects/procedures/meeting-digest/set-action-item-completed";

describe("applyActionItemCompletion", () => {
	beforeEach(() => vi.clearAllMocks());

	it("sets completedAt/completedById when completing", async () => {
		updateMany.mockResolvedValue({ count: 1 });
		const res = await applyActionItemCompletion({
			projectId: "p1",
			actionItemId: "a1",
			userId: "u1",
			completed: true,
		});
		expect(res.success).toBe(true);
		expect(res.completedAt).toBeInstanceOf(Date);
		expect(updateMany).toHaveBeenCalledWith({
			where: { id: "a1", transcript: { projectId: "p1" } },
			data: {
				completedAt: expect.any(Date),
				completedById: "u1",
			},
		});
	});

	it("clears completion when un-completing", async () => {
		updateMany.mockResolvedValue({ count: 1 });
		const res = await applyActionItemCompletion({
			projectId: "p1",
			actionItemId: "a1",
			userId: "u1",
			completed: false,
		});
		expect(res.completedAt).toBeNull();
		expect(updateMany).toHaveBeenCalledWith({
			where: { id: "a1", transcript: { projectId: "p1" } },
			data: { completedAt: null, completedById: null },
		});
	});

	it("throws NOT_FOUND when the item is not in this project", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		await expect(
			applyActionItemCompletion({
				projectId: "p1",
				actionItemId: "a1",
				userId: "u1",
				completed: true,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
