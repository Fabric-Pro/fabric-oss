import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	transaction: vi.fn(),
	update: vi.fn(),
	create: vi.fn(),
	latest: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	recordAuditTx: vi.fn(),
	db: { $transaction: m.transaction },
}));

import { commitWorkflowVersion } from "../commit-workflow-version";

const input = {
	operation: "publish" as const,
	workflowId: "example-workflow",
	userId: "example-user",
	organizationId: "example-org",
	expectedUpdatedAt: new Date("2026-01-01"),
	publishedAt: new Date("2026-01-02"),
	content: { nodes: [], edges: [] },
	patch: { status: "PUBLISHED" as const },
};
beforeEach(() => {
	vi.clearAllMocks();
	m.latest.mockResolvedValue({ version: 4 });
	m.update.mockResolvedValue({});
	m.create.mockResolvedValue({});
	m.transaction.mockImplementation(async (fn) =>
		fn({
			workflow: { update: m.update },
			workflowVersion: { findFirst: m.latest, create: m.create },
		}),
	);
});
it("commits publication and snapshot inside the same transaction with current edit revision", async () => {
	expect(await commitWorkflowVersion(input)).toBe(5);
	expect(m.transaction).toHaveBeenCalledOnce();
	expect(m.update).toHaveBeenCalledWith(
		expect.objectContaining({
			where: {
				id: input.workflowId,
				userId: input.userId,
				organizationId: input.organizationId,
				updatedAt: input.expectedUpdatedAt,
			},
			data: expect.objectContaining({ version: 5, publishedVersion: 5 }),
		}),
	);
	expect(m.create).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({
				version: 5,
				userId: input.userId,
				organizationId: input.organizationId,
			}),
		}),
	);
});
it.each(["P2025", "P2002"])(
	"reports concurrent publication/edit %s as a conflict",
	async (code) => {
		m.transaction.mockRejectedValue({ code });
		await expect(commitWorkflowVersion(input)).rejects.toMatchObject({
			code: "CONFLICT",
		});
	},
);
it("does not create a snapshot when the optimistic update fails", async () => {
	m.update.mockRejectedValue({ code: "P2025" });
	await expect(commitWorkflowVersion(input)).rejects.toMatchObject({
		code: "CONFLICT",
	});
	expect(m.create).not.toHaveBeenCalled();
});
it("propagates a snapshot failure so the transaction can roll back", async () => {
	m.create.mockRejectedValue(new Error("storage unavailable"));
	await expect(commitWorkflowVersion(input)).rejects.toThrow(
		"storage unavailable",
	);
});
