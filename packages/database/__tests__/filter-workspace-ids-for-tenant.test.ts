/**
 * `filterWorkspaceIdsForTenant` narrows stored workspace ids to one tenant.
 *
 * Agent instances saved before instance writes bound workspaces to the
 * instance's organization can carry another organization's workspace, or a
 * personal one, and execution reads those ids back on every run. These tests
 * pin the rule the execution path relies on: an exact, null-aware match on the
 * workspace's hosting organization, the owner check for personal workspaces,
 * unknown ids dropped, and the caller's order kept.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		workspace: {
			findMany: mocks.findMany,
		},
	},
}));

import { filterWorkspaceIdsForTenant } from "../prisma/queries/workspaces/workspaces";

const WORKSPACES = [
	{ id: "ws-a", userId: "user-2", organizationId: "example-org-a" },
	{ id: "ws-a2", userId: "user-1", organizationId: "example-org-a" },
	{ id: "ws-b", userId: "user-1", organizationId: "example-org-b" },
	{ id: "ws-personal-own", userId: "user-1", organizationId: null },
	{ id: "ws-personal-other", userId: "user-2", organizationId: null },
];

describe("filterWorkspaceIdsForTenant", () => {
	beforeEach(() => {
		mocks.findMany.mockReset();
		mocks.findMany.mockImplementation(
			async (args: { where: { id: { in: string[] } } }) =>
				WORKSPACES.filter((w) => args.where.id.in.includes(w.id)),
		);
	});

	it("keeps an organization's own workspaces and drops another organization's, personal and unknown ones", async () => {
		const result = await filterWorkspaceIdsForTenant({
			workspaceIds: [
				"ws-a",
				"ws-b",
				"ws-personal-own",
				"ws-missing",
				"ws-a2",
			],
			userId: "user-1",
			organizationId: "example-org-a",
		});

		expect(result).toEqual({
			allowed: ["ws-a", "ws-a2"],
			dropped: ["ws-b", "ws-personal-own", "ws-missing"],
		});
		expect(mocks.findMany).toHaveBeenCalledTimes(1);
		expect(mocks.findMany).toHaveBeenCalledWith({
			where: {
				id: {
					in: [
						"ws-a",
						"ws-b",
						"ws-personal-own",
						"ws-missing",
						"ws-a2",
					],
				},
			},
			select: { id: true, userId: true, organizationId: true },
		});
	});

	it("keeps only the caller's own personal workspaces for a personal tenant", async () => {
		const result = await filterWorkspaceIdsForTenant({
			workspaceIds: ["ws-personal-other", "ws-a2", "ws-personal-own"],
			userId: "user-1",
			organizationId: null,
		});

		expect(result).toEqual({
			allowed: ["ws-personal-own"],
			dropped: ["ws-personal-other", "ws-a2"],
		});
	});

	it("treats an omitted organization as the personal tenant, not as any tenant", async () => {
		const result = await filterWorkspaceIdsForTenant({
			workspaceIds: ["ws-a2", "ws-personal-own"],
			userId: "user-1",
			organizationId: undefined,
		});

		expect(result).toEqual({
			allowed: ["ws-personal-own"],
			dropped: ["ws-a2"],
		});
	});

	it("keeps the caller's order rather than the database's, and collapses repeats", async () => {
		mocks.findMany.mockResolvedValue([...WORKSPACES].reverse());

		const result = await filterWorkspaceIdsForTenant({
			workspaceIds: ["ws-a2", "ws-b", "ws-a", "ws-a2", "ws-b"],
			userId: "user-1",
			organizationId: "example-org-a",
		});

		expect(result).toEqual({
			allowed: ["ws-a2", "ws-a"],
			dropped: ["ws-b"],
		});
	});

	it("returns empty lists without querying when given no ids", async () => {
		const result = await filterWorkspaceIdsForTenant({
			workspaceIds: [],
			userId: "user-1",
			organizationId: "example-org-a",
		});

		expect(result).toEqual({ allowed: [], dropped: [] });
		expect(mocks.findMany).not.toHaveBeenCalled();
	});
});
