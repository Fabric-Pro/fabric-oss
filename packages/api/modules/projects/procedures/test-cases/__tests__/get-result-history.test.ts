import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: { testCase: { findFirst: vi.fn() } },
	listTestCaseResultHistory: vi.fn(),
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
		Permissions: { TEST_CASE_READ: "test-case:read" },
	};
});

import { db, listTestCaseResultHistory } from "@repo/database";
import { getResultHistoryProcedure } from "../get-result-history";

const handler = (getResultHistoryProcedure as unknown as { handler: Function })
	.handler;
const ctx = {
	user: { id: "u1", name: "U", email: "u@example.com" },
	session: {},
};
const input = { projectId: "p1", testCaseId: "tc1", organizationId: null };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(db.testCase.findFirst).mockResolvedValue({ id: "tc1" } as never);
});

describe("getResultHistoryProcedure", () => {
	it("is gated on TEST_CASE_READ", () => {
		expect(
			(getResultHistoryProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("test-case:read");
	});

	it("returns the case's provenance history after an in-project check", async () => {
		const events = [
			{ id: "ev2", result: "PASSED", source: "PM_SYNC" },
			{ id: "ev1", result: "FAILED", source: "MANUAL" },
		];
		vi.mocked(listTestCaseResultHistory).mockResolvedValue({
			items: events,
			total: 2,
		} as never);

		const res = await handler({ input, context: ctx });

		expect(db.testCase.findFirst).toHaveBeenCalledWith({
			where: { id: "tc1", projectId: "p1", deletedAt: null },
			select: { id: true },
		});
		expect(listTestCaseResultHistory).toHaveBeenCalledWith({
			testCaseId: "tc1",
			limit: undefined,
			offset: undefined,
		});
		// `total` is passed through so the panel can say "5 of 37" rather than
		// silently truncating.
		expect(res).toEqual({ items: events, total: 2 });
	});

	it("returns an empty list when the case has no history yet", async () => {
		vi.mocked(listTestCaseResultHistory).mockResolvedValue({
			items: [],
			total: 0,
		} as never);
		const res = await handler({ input, context: ctx });
		expect(res).toEqual({ items: [], total: 0 });
	});

	it("throws NOT_FOUND for a case in another project (no enumeration)", async () => {
		vi.mocked(db.testCase.findFirst).mockResolvedValue(null as never);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(listTestCaseResultHistory).not.toHaveBeenCalled();
	});
});
