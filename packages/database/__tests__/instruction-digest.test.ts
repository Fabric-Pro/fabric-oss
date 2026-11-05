import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	preferenceFindUnique: vi.fn(),
	preferenceUpsert: vi.fn(),
	snapshotFindMany: vi.fn(),
	snapshotFindFirst: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		projectUserPreference: {
			findUnique: mocks.preferenceFindUnique,
			upsert: mocks.preferenceUpsert,
		},
		projectInstructionSnapshot: {
			findMany: mocks.snapshotFindMany,
			findFirst: mocks.snapshotFindFirst,
		},
	},
}));

import {
	findReadableInstructionVersion,
	getInstructionSeenMarker,
	listInstructionProposalsResolvedSince,
	listInstructionVersionsPublishedSince,
	recordInstructionSeen,
} from "../prisma/queries/instruction-digest";

beforeEach(() => {
	for (const fn of Object.values(mocks)) {
		fn.mockReset();
	}
	mocks.snapshotFindMany.mockResolvedValue([]);
});

describe("the seen marker", () => {
	it("is null on a first visit, including a preference row that predates it", async () => {
		mocks.preferenceFindUnique.mockResolvedValueOnce(null);
		expect(await getInstructionSeenMarker("p", "u")).toBeNull();
		mocks.preferenceFindUnique.mockResolvedValueOnce({
			instructionsSeenSnapshotId: null,
			instructionsSeenVersion: null,
			instructionsSeenAt: null,
		});
		expect(await getInstructionSeenMarker("p", "u")).toBeNull();
	});

	it("is written for one person on one project, with the project's tenancy", async () => {
		await recordInstructionSeen({
			projectId: "p",
			userId: "u",
			organizationId: "o",
			snapshotId: "s",
			version: 3,
		});

		expect(mocks.preferenceUpsert).toHaveBeenCalledWith({
			where: { projectId_userId: { projectId: "p", userId: "u" } },
			create: expect.objectContaining({
				projectId: "p",
				userId: "u",
				organizationId: "o",
				instructionsSeenSnapshotId: "s",
				instructionsSeenVersion: 3,
			}),
			update: {
				instructionsSeenSnapshotId: "s",
				instructionsSeenVersion: 3,
				instructionsSeenAt: expect.any(Date),
			},
		});
	});
});

describe("digest reads", () => {
	it("lists only readable, published versions newer than the marker, in the tenant", async () => {
		await listInstructionVersionsPublishedSince({
			projectId: "p",
			organizationId: "o",
			afterVersion: 3,
		});

		expect(mocks.snapshotFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "p",
					organizationId: "o",
					version: { gt: 3 },
					publishedAt: { not: null },
					contentKind: "FULL_SNAPSHOT",
					status: "READY",
					proposalDestination: { not: "REPOSITORY_COMMIT" },
					OR: [
						{ proposalStatus: null },
						{ proposalStatus: "APPROVED" },
					],
				},
			}),
		);
	});

	it("keeps the newest versions when more than a page qualify, returned oldest first", async () => {
		mocks.snapshotFindMany.mockResolvedValue([
			{ id: "s-30", version: 30 },
			{ id: "s-29", version: 29 },
			{ id: "s-28", version: 28 },
		]);

		const versions = await listInstructionVersionsPublishedSince({
			projectId: "p",
			organizationId: "o",
			afterVersion: 3,
		});

		expect(mocks.snapshotFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				orderBy: { version: "desc" },
				take: 20,
			}),
		);
		expect(versions.map((v) => v.version)).toEqual([28, 29, 30]);
	});

	it("falls back to a readable snapshot by version number", async () => {
		await findReadableInstructionVersion({
			projectId: "p",
			organizationId: "o",
			version: 3,
		});

		expect(mocks.snapshotFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "p",
					organizationId: "o",
					version: 3,
					status: "READY",
				}),
			}),
		);
	});

	it("narrows decided proposals to approved ones and the viewer's own for a non-reviewer", async () => {
		const since = new Date("2026-01-01T00:00:00Z");
		await listInstructionProposalsResolvedSince({
			projectId: "p",
			organizationId: "o",
			since,
			proposerUserId: "u",
		});
		await listInstructionProposalsResolvedSince({
			projectId: "p",
			organizationId: "o",
			since,
		});

		expect(mocks.snapshotFindMany.mock.calls[0]![0].where).toEqual({
			projectId: "p",
			organizationId: "o",
			proposalStatus: { in: ["APPROVED", "REJECTED"] },
			reviewerUserId: { not: null },
			reviewedAt: { gt: since },
			OR: [{ proposalStatus: "APPROVED" }, { userId: "u" }],
		});
		expect(
			mocks.snapshotFindMany.mock.calls[1]![0].where,
		).not.toHaveProperty("OR");
	});
});
