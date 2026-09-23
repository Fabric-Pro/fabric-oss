/**
 * `filterAccessibleWorkspaceIds` narrows caller-supplied workspace ids to the
 * ones the caller may read inside one tenant.
 *
 * Chat stream routes take workspace ids from the request body, or from a
 * conversation's attachments, and hand them to retrieval. The tenancy filter
 * alone would let any organization workspace through for any user, so these
 * tests pin both halves of the rule: the tenant comparison
 * `filterWorkspaceIdsForTenant` makes, then the user's own access. The client
 * is mocked at the same layer as `filter-workspace-ids-for-tenant.test.ts`, so
 * the real `hasWorkspaceAccess` decides the second half.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	workspaceFindMany: vi.fn(),
	workspaceFindFirst: vi.fn(),
	memberFindFirst: vi.fn(),
	administratorFindFirst: vi.fn(),
	contributorFindFirst: vi.fn(),
	stakeholderFindFirst: vi.fn(),
	agentFindFirst: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		workspace: {
			findMany: mocks.workspaceFindMany,
			findFirst: mocks.workspaceFindFirst,
		},
		member: { findFirst: mocks.memberFindFirst },
		workspaceAdministrator: { findFirst: mocks.administratorFindFirst },
		workspaceContributor: { findFirst: mocks.contributorFindFirst },
		workspaceStakeholder: { findFirst: mocks.stakeholderFindFirst },
		workspaceAgent: { findFirst: mocks.agentFindFirst },
	},
}));

import { filterAccessibleWorkspaceIds } from "../prisma/queries/workspaces/workspaces";

const WORKSPACES = [
	// Owned by the caller in organization A.
	{ id: "ws-a-own", userId: "user-1", organizationId: "example-org-a" },
	// Organization A, owned by someone else; the caller administers it.
	{ id: "ws-a-admin", userId: "user-2", organizationId: "example-org-a" },
	// Organization A, owned by someone else; the caller is in no group.
	{ id: "ws-a-closed", userId: "user-2", organizationId: "example-org-a" },
	// Organization B, owned by the caller, who is a member there too.
	{ id: "ws-b-own", userId: "user-1", organizationId: "example-org-b" },
	{ id: "ws-personal-own", userId: "user-1", organizationId: null },
	{ id: "ws-personal-other", userId: "user-2", organizationId: null },
];

const MEMBERSHIPS = [
	{ userId: "user-1", organizationId: "example-org-a" },
	{ userId: "user-1", organizationId: "example-org-b" },
	{ userId: "user-2", organizationId: "example-org-a" },
];

const ADMINISTRATORS = [{ workspaceId: "ws-a-admin", userId: "user-1" }];

function workspaceIdsLookedUpOneByOne(): Array<string | undefined> {
	return mocks.workspaceFindFirst.mock.calls.map(
		(call) => (call[0] as { where: { id?: string } }).where.id,
	);
}

describe("filterAccessibleWorkspaceIds", () => {
	beforeEach(() => {
		for (const mock of Object.values(mocks)) {
			mock.mockReset();
		}
		mocks.workspaceFindMany.mockImplementation(
			async (args: { where: { id: { in: string[] } } }) =>
				WORKSPACES.filter((w) => args.where.id.in.includes(w.id)),
		);
		mocks.workspaceFindFirst.mockImplementation(
			async (args: { where: { id: string } }) =>
				WORKSPACES.find((w) => w.id === args.where.id) ?? null,
		);
		mocks.memberFindFirst.mockImplementation(
			async (args: {
				where: { userId: string; organizationId: string };
			}) =>
				MEMBERSHIPS.some(
					(m) =>
						m.userId === args.where.userId &&
						m.organizationId === args.where.organizationId,
				)
					? { id: "member" }
					: null,
		);
		mocks.administratorFindFirst.mockImplementation(
			async (args: { where: { workspaceId: string; userId: string } }) =>
				ADMINISTRATORS.some(
					(a) =>
						a.workspaceId === args.where.workspaceId &&
						a.userId === args.where.userId,
				)
					? { id: "administrator" }
					: null,
		);
		mocks.contributorFindFirst.mockResolvedValue(null);
		mocks.stakeholderFindFirst.mockResolvedValue(null);
		mocks.agentFindFirst.mockResolvedValue(null);
	});

	it("keeps same-organization workspaces the caller can open and drops unknown, other-organization and unreachable ones", async () => {
		const result = await filterAccessibleWorkspaceIds({
			workspaceIds: [
				"ws-a-own",
				"ws-missing",
				"ws-b-own",
				"ws-a-closed",
				"ws-a-admin",
				"ws-personal-own",
			],
			userId: "user-1",
			organizationId: "example-org-a",
		});

		expect(result).toEqual({
			allowed: ["ws-a-own", "ws-a-admin"],
			dropped: [
				"ws-missing",
				"ws-b-own",
				"ws-a-closed",
				"ws-personal-own",
			],
		});
	});

	it("drops another organization's workspace the caller can open without consulting access for it", async () => {
		const result = await filterAccessibleWorkspaceIds({
			workspaceIds: ["ws-b-own", "ws-a-own"],
			userId: "user-1",
			organizationId: "example-org-a",
		});

		expect(result).toEqual({
			allowed: ["ws-a-own"],
			dropped: ["ws-b-own"],
		});
		// The tenant comparison decides it: the access check only ever sees
		// the ids that survived it.
		expect(workspaceIdsLookedUpOneByOne()).toEqual(["ws-a-own"]);
	});

	it("drops a same-organization workspace the caller is in no group of", async () => {
		const result = await filterAccessibleWorkspaceIds({
			workspaceIds: ["ws-a-closed"],
			userId: "user-1",
			organizationId: "example-org-a",
		});

		expect(result).toEqual({ allowed: [], dropped: ["ws-a-closed"] });
		expect(workspaceIdsLookedUpOneByOne()).toEqual(["ws-a-closed"]);
	});

	it("drops an organization workspace once the caller is no longer a member, even one they own", async () => {
		mocks.memberFindFirst.mockResolvedValue(null);

		const result = await filterAccessibleWorkspaceIds({
			workspaceIds: ["ws-a-own", "ws-a-admin"],
			userId: "user-1",
			organizationId: "example-org-a",
		});

		expect(result).toEqual({
			allowed: [],
			dropped: ["ws-a-own", "ws-a-admin"],
		});
	});

	it("keeps only the caller's own personal workspace for a personal tenant", async () => {
		const result = await filterAccessibleWorkspaceIds({
			workspaceIds: ["ws-personal-other", "ws-a-own", "ws-personal-own"],
			userId: "user-1",
			organizationId: null,
		});

		expect(result).toEqual({
			allowed: ["ws-personal-own"],
			dropped: ["ws-personal-other", "ws-a-own"],
		});
	});

	it("keeps the caller's order rather than the database's, and collapses repeats", async () => {
		mocks.workspaceFindMany.mockResolvedValue([...WORKSPACES].reverse());

		const result = await filterAccessibleWorkspaceIds({
			workspaceIds: [
				"ws-a-admin",
				"ws-a-closed",
				"ws-b-own",
				"ws-a-own",
				"ws-a-admin",
				"ws-a-closed",
				"ws-b-own",
			],
			userId: "user-1",
			organizationId: "example-org-a",
		});

		expect(result).toEqual({
			allowed: ["ws-a-admin", "ws-a-own"],
			dropped: ["ws-a-closed", "ws-b-own"],
		});
		expect(workspaceIdsLookedUpOneByOne()).toEqual([
			"ws-a-admin",
			"ws-a-closed",
			"ws-a-own",
		]);
	});

	it("returns empty lists without querying when given no ids", async () => {
		const result = await filterAccessibleWorkspaceIds({
			workspaceIds: [],
			userId: "user-1",
			organizationId: "example-org-a",
		});

		expect(result).toEqual({ allowed: [], dropped: [] });
		expect(mocks.workspaceFindMany).not.toHaveBeenCalled();
		expect(mocks.workspaceFindFirst).not.toHaveBeenCalled();
	});
});
