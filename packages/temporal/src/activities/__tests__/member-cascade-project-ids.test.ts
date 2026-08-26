import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	deleteMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findMany: (...a: unknown[]) => mocks.findMany(...a),
			deleteMany: (...a: unknown[]) => mocks.deleteMany(...a),
		},
	},
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

import { deleteUserProjectsInOrgActivity } from "../member-cascade-delete";

beforeEach(() => {
	mocks.findMany.mockReset();
	mocks.deleteMany.mockReset();
});

describe("deleteUserProjectsInOrgActivity — deletedProjectIds", () => {
	it("returns the deleted project IDs accumulated across batches", async () => {
		mocks.findMany
			.mockResolvedValueOnce([
				{ id: "p1", name: "P1" },
				{ id: "p2", name: "P2" },
			]) // initial fetch
			.mockResolvedValueOnce([{ id: "p3", name: "P3" }]) // nextBatch after batch 1
			.mockResolvedValueOnce([]); // nextBatch after batch 2 → break
		mocks.deleteMany
			.mockResolvedValueOnce({ count: 2 })
			.mockResolvedValueOnce({ count: 1 });

		const res = await deleteUserProjectsInOrgActivity({
			userId: "u1",
			organizationId: "o1",
			batchSize: 100,
		});

		expect(res.deletedProjectIds).toEqual(["p1", "p2", "p3"]);
		expect(res.deletedCount).toBe(3);
		expect(res.errors).toEqual([]);
	});

	it("returns no IDs for an empty org (no projects)", async () => {
		mocks.findMany.mockResolvedValueOnce([]);
		const res = await deleteUserProjectsInOrgActivity({
			userId: "u1",
			organizationId: "o1",
		});
		expect(res.deletedProjectIds).toEqual([]);
		expect(res.deletedCount).toBe(0);
		expect(mocks.deleteMany).not.toHaveBeenCalled();
	});

	it("captures IDs only for batches whose delete succeeded (deleteMany throws → caught, partial)", async () => {
		mocks.findMany.mockResolvedValueOnce([{ id: "p1", name: "P1" }]);
		mocks.deleteMany.mockRejectedValueOnce(new Error("db down"));
		const res = await deleteUserProjectsInOrgActivity({
			userId: "u1",
			organizationId: "o1",
		});
		// push happens AFTER deleteMany resolves, so a throw captures nothing for that batch
		expect(res.deletedProjectIds).toEqual([]);
		expect(res.errors).toHaveLength(1);
	});
});
