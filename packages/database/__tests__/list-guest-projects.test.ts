/**
 * Unit tests for the `listGuestProjects` "Shared with me" query.
 *
 * The helper backs the Personal-workspace "Shared with me" section: org
 * projects (`organizationId != null`, soft-delete excluded) where the user
 * holds an accepted (`acceptedAt != null`), unexpired (`expiresAt` null or
 * future) ProjectMember row AND has NO Member row in the host organization
 * (guest-only — real org members already see these projects in the org
 * workspace grid). The member sub-filter mirrors the `listProjects` access
 * predicate so "accepted + unexpired" stays consistent across surfaces.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/list-guest-projects.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listGuestProjects } from "../prisma/queries/projects/list-guest-projects";

const { findManyMock } = vi.hoisted(() => ({
	findManyMock: vi.fn(),
}));

// The helper resolves its `db` import to `../../client` from its position
// at `prisma/queries/projects/`. From this test's location at
// `__tests__/`, that same module is reachable at `../prisma/client`.
// `vi.mock` is hoisted above the static import, so the helper sees the
// mocked client.
vi.mock("../prisma/client", () => ({
	db: {
		project: { findMany: findManyMock },
	},
}));

beforeEach(() => {
	findManyMock.mockReset();
	findManyMock.mockResolvedValue([]);
});

describe("listGuestProjects", () => {
	it("issues one `findMany` with the exact guest-only where clause", async () => {
		await listGuestProjects("user-1");

		expect(findManyMock).toHaveBeenCalledTimes(1);
		const { where } = findManyMock.mock.calls[0][0];
		expect(where).toEqual({
			organizationId: { not: null },
			deletedAt: null,
			members: {
				some: {
					userId: "user-1",
					acceptedAt: { not: null },
					OR: [
						{ expiresAt: null },
						{ expiresAt: { gt: expect.any(Date) } },
					],
				},
			},
			organization: {
				members: { none: { userId: "user-1" } },
			},
		});
	});

	it("targets ORG projects only (`organizationId: { not: null }`) and excludes soft-deleted rows", async () => {
		await listGuestProjects("user-1");

		const { where } = findManyMock.mock.calls[0][0];
		expect(where.organizationId).toEqual({ not: null });
		expect(Object.hasOwn(where, "deletedAt")).toBe(true);
		expect(where.deletedAt).toBeNull();
	});

	it("requires an ACCEPTED, UNEXPIRED membership (mirrors the listProjects member sub-filter)", async () => {
		await listGuestProjects("user-1");

		const { where } = findManyMock.mock.calls[0][0];
		expect(where.members.some.acceptedAt).toEqual({ not: null });
		expect(where.members.some.OR).toEqual([
			{ expiresAt: null },
			{ expiresAt: { gt: expect.any(Date) } },
		]);
	});

	it("is guest-only: excludes orgs where the user holds a Member row (`organization.members none`)", async () => {
		await listGuestProjects("user-1");

		const { where } = findManyMock.mock.calls[0][0];
		expect(where.organization).toEqual({
			members: { none: { userId: "user-1" } },
		});
	});

	it("selects the ProjectCard shape (org slug + filtered context count) ordered by updatedAt desc", async () => {
		await listGuestProjects("user-1");

		const args = findManyMock.mock.calls[0][0];
		expect(args.select).toEqual({
			id: true,
			userId: true,
			name: true,
			description: true,
			status: true,
			projectTypes: true,
			tags: true,
			color: true,
			icon: true,
			createdAt: true,
			updatedAt: true,
			userPreferences: {
				where: { userId: "user-1" },
				select: { favoritedAt: true },
				take: 1,
			},
			organization: {
				select: {
					id: true,
					slug: true,
					name: true,
				},
			},
			_count: {
				select: {
					documents: true,
					contexts: {
						where: { importedDocuments: { none: {} } },
					},
				},
			},
		});
		expect(args.orderBy).toEqual({ updatedAt: "desc" });
	});

	// #1694 added a caller-scoped favorite flag. The relation MUST carry a
	// userId filter — an unfiltered one returns every member's preference rows
	// through a list endpoint that only checks project read access.
	it("scopes the favorite relation to the calling user", async () => {
		await listGuestProjects("user-1");

		const { select } = findManyMock.mock.calls[0][0];
		expect(select.userPreferences.where).toEqual({ userId: "user-1" });
	});

	it("flattens the favorite relation to a boolean and drops the rows", async () => {
		findManyMock.mockResolvedValue([
			{
				id: "proj-1",
				name: "Guest project",
				userPreferences: [{ favoritedAt: new Date() }],
			},
			{
				id: "proj-2",
				name: "Another guest project",
				userPreferences: [],
			},
		]);

		const result = await listGuestProjects("user-1");

		expect(result).toEqual([
			{ id: "proj-1", name: "Guest project", isFavorite: true },
			{ id: "proj-2", name: "Another guest project", isFavorite: false },
		]);
		// The relation itself never leaves the server.
		expect(result[0]).not.toHaveProperty("userPreferences");
	});

	it("treats a preference row with no favorite timestamp as not favorited", async () => {
		findManyMock.mockResolvedValue([
			{
				id: "proj-1",
				name: "Guest project",
				// A row that exists only because the user set some other
				// preference, or unfavorited earlier.
				userPreferences: [{ favoritedAt: null }],
			},
		]);

		await expect(listGuestProjects("user-1")).resolves.toEqual([
			{ id: "proj-1", name: "Guest project", isFavorite: false },
		]);
	});
});
