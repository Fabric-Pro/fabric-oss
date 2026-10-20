import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	member: vi.fn(),
	projectMember: vi.fn(),
	findMany: vi.fn(),
	count: vi.fn(),
	groupBy: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		member: { findFirst: mocks.member },
		projectMember: { findFirst: mocks.projectMember },
		project: {
			findMany: mocks.findMany,
			count: mocks.count,
			groupBy: mocks.groupBy,
		},
	},
	Prisma: { JsonNull: Symbol("JsonNull") },
	ProjectMemberRole: { OWNER: "OWNER" },
}));

import { listProjects } from "../prisma/queries/projects/projects";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.member.mockResolvedValue({ id: "member-1" });
	mocks.projectMember.mockResolvedValue(null);
	mocks.findMany.mockResolvedValue([]);
	mocks.count.mockResolvedValue(1);
	mocks.groupBy.mockResolvedValue([]);
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
