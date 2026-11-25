import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	project: { findUnique: vi.fn() },
	projectMember: { findUnique: vi.fn() },
	member: { findFirst: vi.fn() },
}));
vi.mock("@repo/database", () => ({ getTestCase: vi.fn(), db }));
vi.mock("../../../../../orpc/procedures", async () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
	});
	return {
		userHasProjectPermission: (
			await import("../../../../../lib/project-permission-decision")
		).userHasProjectPermission,
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
		expect(db.project.findUnique).not.toHaveBeenCalled();
	});

	it.each([
		["VIEWER", false],
		["PROJECT_ADMIN", true],
	])(
		"returns the case with canEdit based on the organization admin's %s project role",
		async (role, canEdit) => {
			vi.mocked(getTestCase).mockResolvedValue({
				id: "tc1",
				identifier: "TC-001",
			} as never);
			db.project.findUnique.mockResolvedValue({
				id: "p1",
				userId: "u1",
				organizationId: "example-org",
				organization: { deletedAt: null },
			});
			db.member.findFirst.mockResolvedValue({ role: "admin" });
			db.projectMember.findUnique.mockResolvedValue({
				role,
				acceptedAt: new Date(),
				expiresAt: null,
			});

			const res = await handler({ input, context: ctx });

			expect(res).toEqual({
				testCase: { id: "tc1", identifier: "TC-001" },
				canEdit,
			});
			expect(db.projectMember.findUnique).toHaveBeenCalledWith(
				expect.objectContaining({
					where: {
						projectId_userId: { projectId: "p1", userId: "u1" },
					},
				}),
			);
		},
	);
});
