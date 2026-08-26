import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		testCase: { findFirst: vi.fn() },
		testPlan: { findFirst: vi.fn() },
	},
	recordTestCaseResult: vi.fn(),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		resolveOrganizationId: (orgId: unknown) => orgId ?? undefined,
		Permissions: { TEST_CASE_UPDATE: "test-case:update" },
	};
});

import { db, recordTestCaseResult } from "@repo/database";
import { recordResultProcedure } from "../record-result";

const handler = (recordResultProcedure as unknown as { handler: Function })
	.handler;
const ctx = {
	user: { id: "u1", name: "U", email: "u@example.com" },
	session: {},
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(db.testCase.findFirst).mockResolvedValue({ id: "tc1" } as never);
	vi.mocked(db.testPlan.findFirst).mockResolvedValue({ id: "tp1" } as never);
	vi.mocked(recordTestCaseResult).mockResolvedValue({
		id: "tc1",
		currentResult: "PASSED",
		event: { id: "ev1" },
	} as never);
});

describe("recordResultProcedure", () => {
	it("is gated on TEST_CASE_UPDATE", () => {
		expect(
			(recordResultProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("test-case:update");
	});

	it("records a MANUAL mark attributed to the acting user (default source)", async () => {
		const input = {
			projectId: "p1",
			testCaseId: "tc1",
			result: "PASSED",
			organizationId: null,
		};

		const res = await handler({ input, context: ctx });

		// Case is re-verified in-project before the write.
		expect(db.testCase.findFirst).toHaveBeenCalledWith({
			where: { id: "tc1", projectId: "p1", deletedAt: null },
			select: { id: true },
		});
		// Source defaults to MANUAL; the mark is attributed to context.user.
		expect(recordTestCaseResult).toHaveBeenCalledWith({
			testCaseId: "tc1",
			result: "PASSED",
			source: "MANUAL",
			changedByUserId: "u1",
			testPlanId: null,
			note: null,
		});
		expect(res).toEqual({
			testCase: {
				id: "tc1",
				currentResult: "PASSED",
				event: { id: "ev1" },
			},
		});
	});

	it("verifies the plan is in-project when a testPlanId is supplied", async () => {
		const input = {
			projectId: "p1",
			testCaseId: "tc1",
			result: "FAILED",
			testPlanId: "tp1",
			organizationId: null,
		};

		await handler({ input, context: ctx });

		expect(db.testPlan.findFirst).toHaveBeenCalledWith({
			where: { id: "tp1", projectId: "p1", deletedAt: null },
			select: { id: true },
		});
		expect(recordTestCaseResult).toHaveBeenCalledWith(
			expect.objectContaining({ testPlanId: "tp1" }),
		);
	});

	it("always records MANUAL attributed to the user — a smuggled PM_SYNC source can't forge provenance", async () => {
		// This route is the user-driven MANUAL path; PM_SYNC events are written
		// only by the ingestion query layer with real provenance. Even if a
		// caller smuggles source: "PM_SYNC" past the schema, the handler ignores
		// it and records a MANUAL mark attributed to the acting user.
		const input = {
			projectId: "p1",
			testCaseId: "tc1",
			result: "PASSED",
			source: "PM_SYNC",
			organizationId: null,
		};

		await handler({ input, context: ctx });

		expect(recordTestCaseResult).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "MANUAL",
				changedByUserId: "u1",
			}),
		);
	});

	it("throws NOT_FOUND when the case is not in the project", async () => {
		vi.mocked(db.testCase.findFirst).mockResolvedValue(null as never);
		const input = {
			projectId: "p1",
			testCaseId: "tc1",
			result: "PASSED",
			organizationId: null,
		};

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(recordTestCaseResult).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when the supplied plan is not in the project", async () => {
		vi.mocked(db.testPlan.findFirst).mockResolvedValue(null as never);
		const input = {
			projectId: "p1",
			testCaseId: "tc1",
			result: "PASSED",
			testPlanId: "tpX",
			organizationId: null,
		};

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(recordTestCaseResult).not.toHaveBeenCalled();
	});
});
