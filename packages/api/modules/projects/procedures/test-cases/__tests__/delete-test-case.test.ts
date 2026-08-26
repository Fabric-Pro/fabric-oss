import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	softDeleteTestCase: vi.fn(),
}));
vi.mock("../../../lib/test-case-context", () => ({
	removeTestCaseContext: vi.fn(),
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
		Permissions: { TEST_CASE_DELETE: "test-case:delete" },
	};
});

import { softDeleteTestCase } from "@repo/database";
import { removeTestCaseContext } from "../../../lib/test-case-context";
import { deleteTestCaseProcedure } from "../delete-test-case";

const handler = (deleteTestCaseProcedure as unknown as { handler: Function })
	.handler;
const ctx = {
	user: { id: "u1", name: "U", email: "u@example.com" },
	session: {},
};
const input = { projectId: "p1", testCaseId: "tc1", organizationId: null };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("deleteTestCaseProcedure", () => {
	it("is gated on TEST_CASE_DELETE", () => {
		expect(
			(deleteTestCaseProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("test-case:delete");
	});

	it("soft-deletes and tears down the RAG context (removeTestCaseContext) when one exists", async () => {
		vi.mocked(softDeleteTestCase).mockResolvedValue({
			id: "tc1",
			contextId: "ctx1",
		} as never);

		const res = await handler({ input, context: ctx });

		expect(softDeleteTestCase).toHaveBeenCalledWith({
			id: "tc1",
			projectId: "p1",
		});
		expect(removeTestCaseContext).toHaveBeenCalledTimes(1);
		expect(removeTestCaseContext).toHaveBeenCalledWith(
			expect.objectContaining({ contextId: "ctx1", projectId: "p1" }),
		);
		expect(res).toEqual({ success: true });
	});

	it("skips context teardown when the case had no mirrored context", async () => {
		vi.mocked(softDeleteTestCase).mockResolvedValue({
			id: "tc1",
			contextId: null,
		} as never);

		const res = await handler({ input, context: ctx });

		expect(removeTestCaseContext).not.toHaveBeenCalled();
		expect(res).toEqual({ success: true });
	});

	it("throws NOT_FOUND when the case is absent (or in another project)", async () => {
		vi.mocked(softDeleteTestCase).mockResolvedValue(null as never);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(removeTestCaseContext).not.toHaveBeenCalled();
	});
});
