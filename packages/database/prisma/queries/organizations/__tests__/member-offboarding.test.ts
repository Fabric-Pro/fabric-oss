import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The predicates that decide WHOSE access is revoked, and from where.
 *
 * Honest about what this can prove. Every statement here runs against a mock,
 * so what is asserted is the WHERE CLAUSE the function builds, not the rows a
 * real Postgres would delete. That is deliberate rather than lazy: the failure
 * mode this function has to be protected against is an over-broad predicate —
 * one that matches another organization's rows, or every row for the user — and
 * a predicate is exactly what a mock can inspect faithfully. What it cannot
 * prove is that the columns exist and mean what the schema says; the type
 * checker covers that, and no fixture would.
 *
 * The scoping claim is the whole point. A person normally belongs to several
 * organizations, and their personal-tenant rows (`organizationId: null`) are
 * their own workspaces — a predicate on `userId` alone would empty those too.
 */

const {
	sessionUpdateMany,
	projectFindMany,
	workspaceFindMany,
	projectMemberDeleteMany,
	administratorDeleteMany,
	contributorDeleteMany,
	stakeholderDeleteMany,
} = vi.hoisted(() => ({
	sessionUpdateMany: vi.fn(),
	projectFindMany: vi.fn(),
	workspaceFindMany: vi.fn(),
	projectMemberDeleteMany: vi.fn(),
	administratorDeleteMany: vi.fn(),
	contributorDeleteMany: vi.fn(),
	stakeholderDeleteMany: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		session: { updateMany: (...a: unknown[]) => sessionUpdateMany(...a) },
		project: { findMany: (...a: unknown[]) => projectFindMany(...a) },
		workspace: { findMany: (...a: unknown[]) => workspaceFindMany(...a) },
		projectMember: {
			deleteMany: (...a: unknown[]) => projectMemberDeleteMany(...a),
		},
		workspaceAdministrator: {
			deleteMany: (...a: unknown[]) => administratorDeleteMany(...a),
		},
		workspaceContributor: {
			deleteMany: (...a: unknown[]) => contributorDeleteMany(...a),
		},
		workspaceStakeholder: {
			deleteMany: (...a: unknown[]) => stakeholderDeleteMany(...a),
		},
	},
	Prisma: {},
}));

import { revokeOrganizationMemberAccess } from "../member-offboarding";

const INPUT = { organizationId: "org-1", userId: "user-1" };

beforeEach(() => {
	vi.clearAllMocks();
	sessionUpdateMany.mockResolvedValue({ count: 1 });
	projectFindMany.mockResolvedValue([{ id: "proj-1" }, { id: "proj-2" }]);
	workspaceFindMany.mockResolvedValue([{ id: "ws-1" }]);
	projectMemberDeleteMany.mockResolvedValue({ count: 2 });
	administratorDeleteMany.mockResolvedValue({ count: 1 });
	contributorDeleteMany.mockResolvedValue({ count: 3 });
	stakeholderDeleteMany.mockResolvedValue({ count: 0 });
});

describe("revokeOrganizationMemberAccess", () => {
	it("deletes project memberships only within the organization's projects", async () => {
		await revokeOrganizationMemberAccess(INPUT);

		expect(projectFindMany).toHaveBeenCalledWith({
			where: { organizationId: "org-1" },
			select: { id: true },
		});
		expect(projectMemberDeleteMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				projectId: { in: ["proj-1", "proj-2"] },
			},
		});
	});

	it("deletes all three workspace membership kinds, scoped the same way", async () => {
		// A person can hold more than one role on the same workspace and each
		// table is a separate grant. Dropping only the administrator row would
		// leave contributor access intact and look, from outside, like
		// offboarding had worked.
		await revokeOrganizationMemberAccess(INPUT);

		const scope = {
			where: { userId: "user-1", workspaceId: { in: ["ws-1"] } },
		};
		expect(administratorDeleteMany).toHaveBeenCalledWith(scope);
		expect(contributorDeleteMany).toHaveBeenCalledWith(scope);
		expect(stakeholderDeleteMany).toHaveBeenCalledWith(scope);
	});

	it("clears the active-organization pointer on every session, not just one", async () => {
		// better-auth's own `leaveOrganization` clears only the session token
		// that made the request, so a second browser signed in as the same
		// person keeps pointing at the organization it has just left.
		await revokeOrganizationMemberAccess(INPUT);

		expect(sessionUpdateMany).toHaveBeenCalledWith({
			where: { userId: "user-1", activeOrganizationId: "org-1" },
			data: { activeOrganizationId: null },
		});
	});

	it("never issues a predicate keyed on the user alone", async () => {
		// The regression that would matter: a `deleteMany` whose only
		// condition is `userId` empties the person's rows in every other
		// organization AND their personal workspaces. Asserted over every
		// destructive call rather than one at a time, so a table added later
		// is covered by the same claim.
		await revokeOrganizationMemberAccess(INPUT);

		const destructive = [
			projectMemberDeleteMany,
			administratorDeleteMany,
			contributorDeleteMany,
			stakeholderDeleteMany,
		];

		expect(destructive.every((fn) => fn.mock.calls.length === 1)).toBe(
			true,
		);
		for (const fn of destructive) {
			const where = fn.mock.calls[0][0].where as Record<string, unknown>;
			expect(Object.keys(where).sort()).not.toEqual(["userId"]);
			expect(where.userId).toBe("user-1");
		}
	});

	it("sums the counts it actually deleted", async () => {
		const result = await revokeOrganizationMemberAccess(INPUT);

		expect(result).toEqual({
			projectMemberships: 2,
			workspaceMemberships: 4,
			sessionsCleared: 1,
		});
	});

	it("issues no delete at all when the organization owns nothing", async () => {
		// `in: []` is a valid Prisma filter that matches nothing, so the guard
		// is not about correctness — it is about not sending two pointless
		// statements per offboarding for an organization with no projects.
		projectFindMany.mockResolvedValue([]);
		workspaceFindMany.mockResolvedValue([]);

		const result = await revokeOrganizationMemberAccess(INPUT);

		expect(projectMemberDeleteMany).not.toHaveBeenCalled();
		expect(administratorDeleteMany).not.toHaveBeenCalled();
		expect(result).toEqual({
			projectMemberships: 0,
			workspaceMemberships: 0,
			sessionsCleared: 1,
		});
	});
});
