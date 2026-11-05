import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ lock: vi.fn(), read: vi.fn(), update: vi.fn() }));
vi.mock("@repo/database", () => ({
	db: {
		$transaction: async (callback: any) =>
			callback({
				$queryRaw: m.lock,
				workflow: { findFirst: m.read, update: m.update },
			}),
	},
}));

import { updateWorkflowWithProtectedChecks } from "../protected-check-settings";

const actor = { userId: "example-user", organizationId: "example-org" };
beforeEach(() => {
	vi.clearAllMocks();
	m.read.mockResolvedValue({
		settings: {
			fabricResultChecks: {
				version: 1,
				workflowId: "example-workflow",
				cases: [],
			},
			other: "previous",
		},
	});
	m.update.mockResolvedValue({ id: "example-workflow" });
});
it("locks and preserves the latest checks when unrelated settings are replaced", async () => {
	await updateWorkflowWithProtectedChecks(actor, {
		id: "example-workflow",
		settings: { other: "next" },
	});
	expect(m.lock).toHaveBeenCalled();
	expect(m.read).toHaveBeenCalledWith(
		expect.objectContaining({
			where: { id: "example-workflow", ...actor },
		}),
	);
	expect(m.update).toHaveBeenCalledWith(
		expect.objectContaining({
			where: { id: "example-workflow", ...actor },
			data: {
				settings: {
					other: "next",
					fabricResultChecks: {
						version: 1,
						workflowId: "example-workflow",
						cases: [],
					},
				},
			},
		}),
	);
});
it("does not allow general settings requests to forge managed check data", async () => {
	await expect(
		updateWorkflowWithProtectedChecks(actor, {
			id: "example-workflow",
			settings: { fabricResultChecks: { version: 1, cases: [] } },
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(m.update).not.toHaveBeenCalled();
});
it("keeps the optimistic revision and reports conflicts honestly", async () => {
	m.update.mockRejectedValueOnce({ code: "P2025" });
	await expect(
		updateWorkflowWithProtectedChecks(
			actor,
			{ id: "example-workflow", settings: {} },
			{ expectedUpdatedAt: new Date("2026-01-01") },
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(m.update.mock.calls[0][0].where.updatedAt).toEqual(
		new Date("2026-01-01"),
	);
});
