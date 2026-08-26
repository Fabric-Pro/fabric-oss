/**
 * Unit tests for the Test Plan query layer (`../test-plans`).
 *
 * Mocks the Prisma client (`../../../client`) — no real DB. Asserts the pure
 * decision logic: per-project `TP-NNN` identifier sequencing + P2002 retry,
 * membership append ordering, the duplicate-membership throw (so the procedure
 * can map CONFLICT), idempotent removal, and the soft-delete guard.
 *
 * Real-row membership uniqueness + ordered listing live in
 * `test-cases.integration.test.ts` (self-skips without a DB).
 *
 * Run with: pnpm --filter @repo/database test prisma/queries/projects/__tests__/test-plans.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => {
	const make = () => ({
		findFirst: vi.fn(),
		findMany: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		deleteMany: vi.fn(),
		count: vi.fn(),
	});
	return {
		dbMock: {
			testPlan: make(),
			testPlanCase: make(),
			$transaction: vi.fn(),
		},
	};
});

vi.mock("../../../client", () => ({ db: dbMock }));

import {
	addCaseToPlan,
	createTestPlan,
	generateTestPlanIdentifier,
	listTestPlans,
	removeCaseFromPlan,
	reorderPlanCases,
	softDeleteTestPlan,
	updateTestPlan,
} from "../test-plans";

function defaultTransaction() {
	dbMock.$transaction.mockImplementation(async (arg: unknown) =>
		typeof arg === "function"
			? (arg as (tx: unknown) => unknown)(dbMock)
			: Promise.all(arg as Promise<unknown>[]),
	);
}

function smartFindFirst(identifier: string | null, order: number | null) {
	dbMock.testPlan.findFirst.mockImplementation(async (args: any) => {
		if (args?.orderBy?.createdAt) {
			return identifier ? { identifier } : null;
		}
		if (args?.orderBy?.order) {
			return order != null ? { order } : null;
		}
		return null;
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	defaultTransaction();
	dbMock.testPlan.create.mockResolvedValue({ id: "tp1" });
	dbMock.testPlan.update.mockResolvedValue({ id: "tp1" });
	dbMock.testPlanCase.create.mockResolvedValue({ id: "pc1" });
	dbMock.testPlanCase.updateMany.mockResolvedValue({ count: 1 });
});

describe("generateTestPlanIdentifier", () => {
	it("starts at TP-001 then increments", async () => {
		dbMock.testPlan.findFirst.mockResolvedValueOnce(null);
		await expect(generateTestPlanIdentifier("p1")).resolves.toBe("TP-001");
		dbMock.testPlan.findFirst.mockResolvedValueOnce({
			identifier: "TP-009",
		});
		await expect(generateTestPlanIdentifier("p1")).resolves.toBe("TP-010");
	});
});

describe("createTestPlan", () => {
	it("allocates TP-001 + order 1 for an empty project", async () => {
		smartFindFirst(null, null);
		dbMock.testPlan.create.mockResolvedValue({
			id: "tp1",
			identifier: "TP-001",
		});

		await createTestPlan({
			projectId: "p1",
			createdById: "u1",
			name: "Smoke",
		});

		const arg = dbMock.testPlan.create.mock.calls[0][0];
		expect(arg.data.identifier).toBe("TP-001");
		expect(arg.data.order).toBe(1);
		expect(arg.data.state).toBe("ACTIVE");
	});

	it("retries once on a P2002 identifier race", async () => {
		smartFindFirst(null, null);
		dbMock.testPlan.create.mockResolvedValue({ id: "tp1" });
		dbMock.$transaction.mockRejectedValueOnce({ code: "P2002" });
		await createTestPlan({ projectId: "p1", createdById: "u1", name: "X" });
		expect(dbMock.$transaction).toHaveBeenCalledTimes(2);
	});
});

describe("updateTestPlan", () => {
	it("returns null and never writes when missing/soft-deleted", async () => {
		dbMock.testPlan.findFirst.mockResolvedValue(null);
		const res = await updateTestPlan({
			id: "tp1",
			projectId: "p1",
			data: { name: "X" },
		});
		expect(res).toBeNull();
		expect(dbMock.testPlan.update).not.toHaveBeenCalled();
	});

	it("writes only the provided fields", async () => {
		dbMock.testPlan.findFirst.mockResolvedValue({ id: "tp1" });
		await updateTestPlan({
			id: "tp1",
			projectId: "p1",
			data: { state: "INACTIVE" },
		});
		expect(dbMock.testPlan.update.mock.calls[0][0].data).toEqual({
			state: "INACTIVE",
		});
	});
});

describe("softDeleteTestPlan", () => {
	it("stamps deletedAt and returns { id }", async () => {
		dbMock.testPlan.findFirst.mockResolvedValue({ id: "tp1" });
		const res = await softDeleteTestPlan({ id: "tp1", projectId: "p1" });
		expect(res).toEqual({ id: "tp1" });
		expect(
			dbMock.testPlan.update.mock.calls[0][0].data.deletedAt,
		).toBeInstanceOf(Date);
	});

	it("returns null and never writes when absent", async () => {
		dbMock.testPlan.findFirst.mockResolvedValue(null);
		const res = await softDeleteTestPlan({ id: "tp1", projectId: "p1" });
		expect(res).toBeNull();
		expect(dbMock.testPlan.update).not.toHaveBeenCalled();
	});
});

describe("listTestPlans", () => {
	it("scopes to projectId + deletedAt:null, returns { items, total }", async () => {
		dbMock.testPlan.findMany.mockResolvedValue([{ id: "tp1" }]);
		dbMock.testPlan.count.mockResolvedValue(1);
		const res = await listTestPlans({ projectId: "p1", state: "ACTIVE" });
		expect(res).toEqual({ items: [{ id: "tp1" }], total: 1 });
		expect(dbMock.testPlan.findMany.mock.calls[0][0].where).toEqual({
			projectId: "p1",
			deletedAt: null,
			state: "ACTIVE",
		});
	});
});

describe("addCaseToPlan", () => {
	it("appends at order = last+1 with the optional section", async () => {
		dbMock.testPlanCase.findFirst.mockResolvedValue({ order: 4 });
		dbMock.testPlanCase.create.mockResolvedValue({ id: "pc1" });
		await addCaseToPlan({
			planId: "tp1",
			testCaseId: "tc1",
			section: "Critical",
		});
		expect(dbMock.testPlanCase.create).toHaveBeenCalledWith({
			data: {
				planId: "tp1",
				testCaseId: "tc1",
				section: "Critical",
				order: 5,
			},
			select: expect.anything(),
		});
	});

	it("starts membership order at 1 for an empty plan", async () => {
		dbMock.testPlanCase.findFirst.mockResolvedValue(null);
		await addCaseToPlan({ planId: "tp1", testCaseId: "tc1" });
		expect(dbMock.testPlanCase.create.mock.calls[0][0].data.order).toBe(1);
	});

	it("propagates the P2002 unique violation on duplicate membership (→ CONFLICT)", async () => {
		dbMock.testPlanCase.findFirst.mockResolvedValue(null);
		dbMock.testPlanCase.create.mockRejectedValue({ code: "P2002" });
		await expect(
			addCaseToPlan({ planId: "tp1", testCaseId: "tc1" }),
		).rejects.toEqual({ code: "P2002" });
	});
});

describe("removeCaseFromPlan", () => {
	it("deletes the membership idempotently and reports rows removed", async () => {
		dbMock.testPlanCase.deleteMany.mockResolvedValue({ count: 1 });
		const res = await removeCaseFromPlan({
			planId: "tp1",
			testCaseId: "tc1",
		});
		expect(res).toEqual({ removed: 1 });
		expect(dbMock.testPlanCase.deleteMany).toHaveBeenCalledWith({
			where: { planId: "tp1", testCaseId: "tc1" },
		});
	});
});

describe("reorderPlanCases", () => {
	it("writes each membership order scoped to the plan", async () => {
		await reorderPlanCases("tp1", [
			{ id: "pc1", order: 2 },
			{ id: "pc2", order: 1 },
		]);
		expect(dbMock.testPlanCase.updateMany).toHaveBeenCalledWith({
			where: { id: "pc1", planId: "tp1" },
			data: { order: 2 },
		});
		expect(dbMock.testPlanCase.updateMany).toHaveBeenCalledWith({
			where: { id: "pc2", planId: "tp1" },
			data: { order: 1 },
		});
	});
});
