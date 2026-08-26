import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getTestCase: vi.fn(),
}));
vi.mock("../../../../../lib/project-permissions", () => ({
	userHasProjectPermission: vi.fn(),
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
		Permissions: {
			TEST_CASE_READ: "test-case:read",
			TEST_CASE_UPDATE: "test-case:update",
		},
	};
});

import { getTestCase } from "@repo/database";
import { userHasProjectPermission } from "../../../../../lib/project-permissions";
import { getTestCaseProcedure } from "../get-test-case";

const handler = (getTestCaseProcedure as unknown as { handler: Function })
	.handler;
const ctx = {
	user: { id: "u1", name: "U", email: "u@example.com" },
	session: {},
};
const input = { projectId: "p1", testCaseId: "tc1", organizationId: null };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getTestCaseProcedure", () => {
	it("is gated on TEST_CASE_READ", () => {
		expect(
			(getTestCaseProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("test-case:read");
	});

	it("throws NOT_FOUND for a case that belongs to a different project", async () => {
		// The case exists, but not in p1 → the project-scoped query returns null.
		vi.mocked(getTestCase).mockResolvedValue(null as never);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(userHasProjectPermission).not.toHaveBeenCalled();
	});

	it("returns the case plus the caller's canEdit flag", async () => {
		vi.mocked(getTestCase).mockResolvedValue({
			id: "tc1",
			identifier: "TC-001",
		} as never);
		vi.mocked(userHasProjectPermission).mockResolvedValue(true as never);

		const res = await handler({ input, context: ctx });

		expect(res).toEqual({
			testCase: { id: "tc1", identifier: "TC-001" },
			canEdit: true,
		});
		expect(userHasProjectPermission).toHaveBeenCalledWith(
			"p1",
			"u1",
			"test-case:update",
		);
	});
});
