import { beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.hoisted(() => vi.fn());
vi.mock("../prisma/client", () => ({ db: { workflow: { update } } }));
import { updateWorkflow } from "../prisma/queries/workflows/workflows";

beforeEach(() => update.mockReset());

describe("workflow edit CAS", () => {
	it("puts the expected timestamp, owner and exclusive tenant in the actual update predicate", async () => {
		const expectedUpdatedAt = new Date("2026-01-01T12:00:00Z");
		await updateWorkflow(
			"workflow-1",
			"owner-1",
			{ name: "Updated" },
			"org-1",
			{
				expectedUpdatedAt,
			},
		);
		expect(update).toHaveBeenCalledWith({
			where: {
				id: "workflow-1",
				userId: "owner-1",
				organizationId: "org-1",
				updatedAt: expectedUpdatedAt,
			},
			data: { name: "Updated" },
		});
	});

	it("keeps existing callers unconditional and the null tenant arm exclusive", async () => {
		await updateWorkflow("workflow-1", "owner-1", { name: "Updated" });
		expect(update).toHaveBeenCalledWith({
			where: {
				id: "workflow-1",
				userId: "owner-1",
				organizationId: null,
			},
			data: { name: "Updated" },
		});
	});

	it("propagates a conditional update miss for the command to classify", async () => {
		const conflict = Object.assign(new Error("Row changed"), {
			code: "P2025",
		});
		update.mockRejectedValueOnce(conflict);
		await expect(
			updateWorkflow(
				"workflow-1",
				"owner-1",
				{ name: "Updated" },
				"org-1",
				{
					expectedUpdatedAt: new Date("2026-01-01"),
				},
			),
		).rejects.toBe(conflict);
	});
});
