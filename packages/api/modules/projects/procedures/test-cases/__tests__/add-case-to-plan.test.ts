import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => {
	// Minimal stand-in for Prisma's known-request error so the handler's
	// `instanceof Prisma.PrismaClientKnownRequestError && code === "P2002"`
	// branch (duplicate membership → CONFLICT) can be exercised.
	class PrismaClientKnownRequestError extends Error {
		code: string;
		constructor(code: string) {
			super("Unique constraint failed");
			this.code = code;
		}
	}
	return {
		db: {
			testPlan: { findFirst: vi.fn() },
			testCase: { findFirst: vi.fn() },
		},
		addCaseToPlan: vi.fn(),
		Prisma: { PrismaClientKnownRequestError },
	};
});
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

import { addCaseToPlan, db, Prisma } from "@repo/database";
import { addCaseToPlanProcedure } from "../add-case-to-plan";

const handler = (addCaseToPlanProcedure as unknown as { handler: Function })
	.handler;
const ctx = { user: { id: "u1" }, session: {} };
const input = {
	projectId: "p1",
	planId: "tp1",
	testCaseId: "tc1",
	organizationId: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(db.testPlan.findFirst).mockResolvedValue({ id: "tp1" } as never);
	vi.mocked(db.testCase.findFirst).mockResolvedValue({ id: "tc1" } as never);
});

describe("addCaseToPlanProcedure", () => {
	it("is gated on TEST_CASE_UPDATE", () => {
		expect(
			(addCaseToPlanProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("test-case:update");
	});

	it("adds the case to the plan", async () => {
		vi.mocked(addCaseToPlan).mockResolvedValue({ id: "link1" } as never);

		const res = await handler({ input, context: ctx });

		expect(addCaseToPlan).toHaveBeenCalledWith({
			planId: "tp1",
			testCaseId: "tc1",
			section: null,
		});
		expect(res).toEqual({ link: { id: "link1" } });
	});

	it("maps a duplicate-membership P2002 to CONFLICT", async () => {
		vi.mocked(addCaseToPlan).mockRejectedValue(
			new Prisma.PrismaClientKnownRequestError("P2002"),
		);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});

	it("throws NOT_FOUND when the plan is not in the project", async () => {
		vi.mocked(db.testPlan.findFirst).mockResolvedValue(null as never);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(addCaseToPlan).not.toHaveBeenCalled();
	});
});
