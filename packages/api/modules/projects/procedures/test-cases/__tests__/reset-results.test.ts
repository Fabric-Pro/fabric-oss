import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	resetProjectTestResults: vi.fn(),
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

import { resetProjectTestResults } from "@repo/database";
import { resetResultsProcedure } from "../reset-results";

const handler = (resetResultsProcedure as unknown as { handler: Function })
	.handler;
const ctx = {
	user: { id: "u1", name: "U", email: "u@example.com" },
	session: {},
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(resetProjectTestResults).mockResolvedValue({ reset: 3 } as never);
});

describe("resetResultsProcedure", () => {
	it("is gated on TEST_CASE_UPDATE", () => {
		expect(
			(resetResultsProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("test-case:update");
	});

	it("resets the project (org context) and returns the count", async () => {
		const input = { projectId: "p1", organizationId: "org1" };

		const res = await handler({ input, context: ctx });

		expect(resetProjectTestResults).toHaveBeenCalledWith({
			projectId: "p1",
			organizationId: "org1",
			changedByUserId: "u1",
		});
		expect(res).toEqual({ reset: 3 });
	});

	it("passes organizationId null for a personal context", async () => {
		vi.mocked(resetProjectTestResults).mockResolvedValue({
			reset: 0,
		} as never);
		const input = { projectId: "p1", organizationId: null };

		const res = await handler({ input, context: ctx });

		expect(resetProjectTestResults).toHaveBeenCalledWith({
			projectId: "p1",
			organizationId: null,
			changedByUserId: "u1",
		});
		expect(res).toEqual({ reset: 0 });
	});
});
