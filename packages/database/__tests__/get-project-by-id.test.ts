/**
 * Regression coverage for Fizzy #2267.
 *
 * Project detail reads must keep the small inventories used by the overview
 * and edit wizard without transferring document/context bodies. Authorization-
 * only callers use getProjectAccessById and fetch no relations at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirstMock } = vi.hoisted(() => ({
	findFirstMock: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		project: { findFirst: findFirstMock },
	},
	Prisma: {
		JsonNull: Symbol("JsonNull"),
		PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {},
	},
	ProjectMemberRole: {
		OWNER: "OWNER",
	},
}));

import {
	getProjectAccessById,
	getProjectById,
	getProjectByIdForExternalApi,
	getProjectSummaryById,
} from "../prisma/queries/projects/projects";

beforeEach(() => {
	findFirstMock.mockReset();
});

describe("getProjectById", () => {
	it.each([
		["personal", undefined, null],
		["organization", "org-1", "org-1"],
	] as const)(
		"selects only lightweight relation inventories in %s context",
		async (_context, organizationId, expectedOrganizationId) => {
			findFirstMock.mockResolvedValue({
				id: "project-1",
				organizationId: expectedOrganizationId,
				userPreferences: [],
				documents: [],
				contexts: [],
			});

			await getProjectById("project-1", "user-1", organizationId);

			expect(findFirstMock).toHaveBeenCalledTimes(1);
			const query = findFirstMock.mock.calls[0]?.[0];
			expect(query.where).toEqual({
				id: "project-1",
				organizationId: expectedOrganizationId,
				OR: [
					{ userId: "user-1" },
					{
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
					},
				],
			});
			expect(query.include.documents).toEqual({
				orderBy: { createdAt: "desc" },
				select: {
					id: true,
					type: true,
					title: true,
					status: true,
					isActive: true,
				},
			});
			expect(query.include.contexts).toEqual({
				where: { type: "INTEGRATION" },
				orderBy: { createdAt: "desc" },
				select: {
					id: true,
					type: true,
					sourceTitle: true,
					sourceUrl: true,
					metadata: true,
				},
			});
			expect(query.include.documents.select).not.toHaveProperty(
				"content",
			);
			expect(query.include.contexts.select).not.toHaveProperty("content");
		},
	);
});

describe("getProjectAccessById", () => {
	it("fetches only the tenant identity for authorization-only callers", async () => {
		findFirstMock.mockResolvedValue({
			id: "project-1",
			organizationId: "org-1",
		});

		await getProjectAccessById("project-1", "user-1", "org-1");

		const query = findFirstMock.mock.calls[0]?.[0];
		expect(query.select).toEqual({ id: true, organizationId: true });
		expect(query).not.toHaveProperty("include");
	});
});

describe("getProjectSummaryById", () => {
	it("fetches only the scalar fields used by lightweight project consumers", async () => {
		findFirstMock.mockResolvedValue({ id: "project-1", name: "Project" });

		await getProjectSummaryById("project-1", "user-1");

		const query = findFirstMock.mock.calls[0]?.[0];
		expect(query.select).toEqual({
			id: true,
			name: true,
			description: true,
			status: true,
			heroEmojis: true,
			createdAt: true,
			updatedAt: true,
		});
		expect(query).not.toHaveProperty("include");
	});
});

describe("getProjectByIdForExternalApi", () => {
	it("keeps the historical full relation includes at the v1 compatibility boundary", async () => {
		findFirstMock.mockResolvedValue({
			id: "project-1",
			userPreferences: [],
			documents: [],
			contexts: [],
		});

		await getProjectByIdForExternalApi("project-1", "user-1");

		const query = findFirstMock.mock.calls[0]?.[0];
		expect(query.include.documents).toEqual({
			orderBy: { createdAt: "desc" },
		});
		expect(query.include.contexts).toEqual({
			orderBy: { createdAt: "desc" },
		});
		expect(query.include.documents).not.toHaveProperty("select");
		expect(query.include.contexts).not.toHaveProperty("select");
	});
});
