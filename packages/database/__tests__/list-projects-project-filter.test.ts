import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	member: vi.fn(),
	projectMember: vi.fn(),
	findFirst: vi.fn(),
	findMany: vi.fn(),
	count: vi.fn(),
	groupBy: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		member: { findFirst: mocks.member },
		projectMember: { findFirst: mocks.projectMember },
		project: {
			findFirst: mocks.findFirst,
			findMany: mocks.findMany,
			count: mocks.count,
			groupBy: mocks.groupBy,
		},
	},
	Prisma: { JsonNull: Symbol("JsonNull") },
	ProjectMemberRole: { OWNER: "OWNER" },
}));

import {
	getProjectForReportsOnly,
	listOrganizationProjectsForReports,
	listProjects,
} from "../prisma/queries/projects/projects";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.member.mockResolvedValue({ id: "member-1" });
	mocks.projectMember.mockResolvedValue(null);
	mocks.findMany.mockResolvedValue([]);
	mocks.count.mockResolvedValue(1);
	mocks.groupBy.mockResolvedValue([]);
});

describe("listOrganizationProjectsForReports", () => {
	const list = (status?: "ACTIVE" | "DRAFT") =>
		listOrganizationProjectsForReports({
			userId: "user-1",
			organizationId: "org-1",
			limit: 50,
			offset: 0,
			status,
		});

	it("lists the organization's live projects whatever row the caller holds, drafts left out, in the rows and every count", async () => {
		await list();

		const { where } = mocks.findMany.mock.calls[0][0];
		expect(where).toEqual({
			organizationId: "org-1",
			deletedAt: null,
			status: { not: "DRAFT" },
		});
		expect(mocks.count.mock.calls[0][0].where).toEqual(where);
		expect(mocks.groupBy.mock.calls[0][0].where).toEqual(where);
	});

	it("gives no drafts even when asked for them", async () => {
		await list("DRAFT");

		expect(mocks.findMany.mock.calls[0][0].where.status).toEqual({
			not: "DRAFT",
		});
	});

	it("reads a project card's fields and nothing the project's members alone read", async () => {
		await list();

		const { select } = mocks.findMany.mock.calls[0][0];
		expect(Object.keys(select).sort()).toEqual([
			"_count",
			"color",
			"createdAt",
			"description",
			"icon",
			"id",
			"members",
			"name",
			"organization",
			"projectTypes",
			"status",
			"tags",
			"updatedAt",
			"userId",
			"userPreferences",
		]);
	});

	it("reads only the caller's own row, so a card cannot offer them another member's rights", async () => {
		await list();

		const { select } = mocks.findMany.mock.calls[0][0];
		expect(select.members.where.userId).toBe("user-1");
		expect(select.members.select).toEqual({ role: true });
		expect(select.userPreferences.where.userId).toBe("user-1");
	});
});

describe("getProjectForReportsOnly", () => {
	it("reads a live project of the named organization only, with what the report surface reads", async () => {
		await getProjectForReportsOnly("project-1", "org-1");

		const { where, select } = mocks.findFirst.mock.calls[0][0];
		expect(where).toEqual({
			id: "project-1",
			organizationId: "org-1",
			deletedAt: null,
		});
		expect(Object.keys(select).sort()).toEqual([
			"description",
			"id",
			"name",
			"organizationId",
			"projectManagementAdditionalContext",
			"projectManagementContainerId",
			"projectManagementContainerName",
			"projectManagementMcpConfigId",
			"projectManagementMcpServerId",
			"repositoryIntegrations",
			"status",
		]);
		expect(
			Object.keys(select.repositoryIntegrations.select).sort(),
		).toEqual([
			"id",
			"provider",
			"repositoryName",
			"repositoryOwner",
			"status",
		]);
	});

	it("keeps a personal project out of an organization's reach, and the reverse", async () => {
		await getProjectForReportsOnly("project-1", null);

		expect(
			mocks.findFirst.mock.calls[0][0].where.organizationId,
		).toBeNull();
	});
});

describe("listProjects project restriction", () => {
	it("restricts rows and every count before pagination without replacing access or search", async () => {
		const result = await listProjects({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
			limit: 1,
			offset: 1,
			search: "example",
			includeStatusCounts: true,
		});
		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "project-1",
					organizationId: "org-1",
					deletedAt: null,
					OR: expect.any(Array),
					AND: expect.any(Array),
				}),
				take: 1,
				skip: 1,
			}),
		);
		for (const [query] of mocks.count.mock.calls) {
			expect(query.where).toMatchObject({
				id: "project-1",
				organizationId: "org-1",
			});
		}
		expect(mocks.groupBy).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "project-1",
					organizationId: "org-1",
				}),
			}),
		);
		expect(result).toMatchObject({
			projects: [],
			total: 1,
			hasMore: false,
		});
	});

	it("preserves unrestricted queries when the project is omitted", async () => {
		await listProjects({ userId: "user-1", organizationId: "org-1" });
		expect(mocks.findMany.mock.calls[0][0].where).not.toHaveProperty("id");
	});
});
