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
 * prove is that the columns and relations exist and mean what the schema says;
 * the type checker covers that, and no fixture would.
 *
 * Two claims carry the file.
 *
 * SCOPING. A person normally belongs to several organizations, and their
 * personal-tenant rows (`organizationId: null`) are their own workspaces — a
 * predicate on `userId` alone would empty those too.
 *
 * NO SNAPSHOT. The organization's scope is pushed into each predicate as a
 * relation filter instead of being collected into an id list first. An id list
 * is a point-in-time read, so a project or workspace joining the organization
 * between the read and the delete would keep its grants through an offboarding
 * that reported success.
 */

const {
	sessionUpdateMany,
	projectFindMany,
	workspaceFindMany,
	projectMemberDeleteMany,
	administratorDeleteMany,
	contributorDeleteMany,
	stakeholderDeleteMany,
	orgApiKeyUpdateMany,
} = vi.hoisted(() => ({
	sessionUpdateMany: vi.fn(),
	projectFindMany: vi.fn(),
	workspaceFindMany: vi.fn(),
	projectMemberDeleteMany: vi.fn(),
	administratorDeleteMany: vi.fn(),
	contributorDeleteMany: vi.fn(),
	stakeholderDeleteMany: vi.fn(),
	orgApiKeyUpdateMany: vi.fn(),
}));

// `project.findMany` and `workspace.findMany` are mocked deliberately even
// though the function must not call them: an unmocked delegate throws, which
// would fail the "issues no read" case for the wrong reason and read as a
// missing stub rather than as the regression it is meant to catch.
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
		organizationApiKey: {
			updateMany: (...a: unknown[]) => orgApiKeyUpdateMany(...a),
		},
	},
	Prisma: {},
}));

import { revokeOrganizationMemberAccess } from "../member-offboarding";

const INPUT = { organizationId: "org-1", userId: "user-1" };

beforeEach(() => {
	vi.clearAllMocks();
	sessionUpdateMany.mockResolvedValue({ count: 1 });
	projectFindMany.mockResolvedValue([]);
	workspaceFindMany.mockResolvedValue([]);
	projectMemberDeleteMany.mockResolvedValue({ count: 2 });
	administratorDeleteMany.mockResolvedValue({ count: 1 });
	contributorDeleteMany.mockResolvedValue({ count: 3 });
	stakeholderDeleteMany.mockResolvedValue({ count: 0 });
	orgApiKeyUpdateMany.mockResolvedValue({ count: 1 });
});

describe("revokeOrganizationMemberAccess", () => {
	it("scopes project memberships through the project's own organization", async () => {
		await revokeOrganizationMemberAccess(INPUT);

		expect(projectMemberDeleteMany).toHaveBeenCalledWith({
			where: { userId: "user-1", project: { organizationId: "org-1" } },
		});
	});

	it("deletes all three workspace membership kinds, scoped the same way", async () => {
		// A person can hold more than one role on the same workspace and each
		// table is a separate grant. Dropping only the administrator row would
		// leave contributor access intact and look, from outside, like
		// offboarding had worked.
		await revokeOrganizationMemberAccess(INPUT);

		const scope = {
			where: {
				userId: "user-1",
				workspace: { organizationId: "org-1" },
			},
		};
		expect(administratorDeleteMany).toHaveBeenCalledWith(scope);
		expect(contributorDeleteMany).toHaveBeenCalledWith(scope);
		expect(stakeholderDeleteMany).toHaveBeenCalledWith(scope);
	});

	it("collects no id list first — nothing can join the organization mid-flight", async () => {
		// The window this closes: with a snapshot of project ids, a project
		// moved into the organization between the read and the delete keeps its
		// grants while offboarding reports success.
		await revokeOrganizationMemberAccess(INPUT);

		expect(projectFindMany).not.toHaveBeenCalled();
		expect(workspaceFindMany).not.toHaveBeenCalled();
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
		// The regression that would matter: a `deleteMany` whose only condition
		// is `userId` empties the person's rows in every other organization AND
		// their personal workspaces. Asserted over every destructive call
		// rather than one at a time, so a table added later is covered by the
		// same claim.
		await revokeOrganizationMemberAccess(INPUT);

		const destructive = [
			projectMemberDeleteMany,
			administratorDeleteMany,
			contributorDeleteMany,
			stakeholderDeleteMany,
			orgApiKeyUpdateMany,
		];

		for (const fn of destructive) {
			expect(fn).toHaveBeenCalledTimes(1);
			const where = fn.mock.calls[0][0].where as Record<string, unknown>;
			// The owning user is named `userId` on the membership tables and
			// `createdByUserId` on the key table. Either way it has to be
			// there, and it must not be the only condition.
			expect(where.userId ?? where.createdByUserId).toBe("user-1");
			expect(Object.keys(where).length).toBeGreaterThan(1);
			// Whichever relation carries the scope, it must name THIS
			// organization — a relation filter with the wrong key would satisfy
			// the shape check above while scoping nothing.
			expect(JSON.stringify(where)).toContain('"organizationId":"org-1"');
		}
	});

	it("deactivates the keys this person minted for THIS organization only", async () => {
		// Before this, removal revoked a key only on the surfaces that re-read
		// membership live. The runtime verifier, `/mcp`, the fabric-kanban
		// routes and agent model resolution all gate on `isActive` alone, so an
		// offboarded creator's key kept authenticating there (Fizzy #2380, QA
		// round 2). Deactivating is what revokes it for those.
		await revokeOrganizationMemberAccess(INPUT);

		expect(orgApiKeyUpdateMany).toHaveBeenCalledWith({
			where: {
				createdByUserId: "user-1",
				organizationId: "org-1",
				isActive: true,
			},
			data: { isActive: false },
		});
	});

	it("sums the counts it actually deleted", async () => {
		const result = await revokeOrganizationMemberAccess(INPUT);

		expect(result).toEqual({
			projectMemberships: 2,
			workspaceMemberships: 4,
			sessionsCleared: 1,
			apiKeysDeactivated: 1,
		});
	});

	it("reports zeroes without pretending it skipped the work", async () => {
		// An organization with nothing in it still gets one statement per
		// table. There is no id list to be empty, so there is no shortcut and
		// no branch that could be wrong.
		projectMemberDeleteMany.mockResolvedValue({ count: 0 });
		administratorDeleteMany.mockResolvedValue({ count: 0 });
		contributorDeleteMany.mockResolvedValue({ count: 0 });
		stakeholderDeleteMany.mockResolvedValue({ count: 0 });
		sessionUpdateMany.mockResolvedValue({ count: 0 });
		orgApiKeyUpdateMany.mockResolvedValue({ count: 0 });

		const result = await revokeOrganizationMemberAccess(INPUT);

		expect(result).toEqual({
			projectMemberships: 0,
			workspaceMemberships: 0,
			sessionsCleared: 0,
			apiKeysDeactivated: 0,
		});
		expect(projectMemberDeleteMany).toHaveBeenCalledTimes(1);
	});
});
