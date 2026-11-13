/**
 * Which projects may be the organization's template for coding instructions.
 *
 * One rule serves the picker (`listInstructionTemplateCandidates`) and the
 * write's check (`findInstructionTemplateCandidate`), so a project the picker
 * offers is never refused on save, and one it leaves out is never accepted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	findMany: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		project: { findFirst: mocks.findFirst, findMany: mocks.findMany },
	},
}));

import {
	findInstructionTemplateCandidate,
	isInstructionTemplateEligible,
	listInstructionTemplateCandidates,
} from "../prisma/queries/organizations/instruction-template";

const OPEN_MOVE = {
	sourceOfTruth: "UPLOAD",
	migration: {
		v: 1,
		state: "PROPOSING",
		branchId: null,
		snapshotId: null,
		syncId: "sync-1",
		pullRequestUrl: null,
		startedAt: "2026-10-03T10:00:00.000Z",
		userId: "user-1",
	},
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("isInstructionTemplateEligible", () => {
	it.each([
		["no settings", null],
		["empty settings", {}],
		["upload mode", { sourceOfTruth: "UPLOAD" }],
		["ignore rules only", { ignoreGlobs: ["tasks/**"] }],
	])("accepts a project with %s", (_label, settings) => {
		expect(isInstructionTemplateEligible(settings)).toBe(true);
	});

	it("refuses a project whose instructions come from a repository", () => {
		expect(
			isInstructionTemplateEligible({ sourceOfTruth: "REPOSITORY" }),
		).toBe(false);
	});

	it("refuses a project whose move into a repository is open", () => {
		expect(isInstructionTemplateEligible(OPEN_MOVE)).toBe(false);
	});
});

describe("listInstructionTemplateCandidates", () => {
	it("offers the organization's live upload-mode projects by name, saying which have nothing published", async () => {
		mocks.findMany.mockResolvedValue([
			{
				id: "proj-a",
				name: "Example platform",
				instructionSettings: null,
				publishedInstructionSnapshotId: "snap-a",
			},
			{
				id: "proj-repo",
				name: "Example repository project",
				instructionSettings: { sourceOfTruth: "REPOSITORY" },
				publishedInstructionSnapshotId: "snap-r",
			},
			{
				id: "proj-moving",
				name: "Example moving project",
				instructionSettings: OPEN_MOVE,
				publishedInstructionSnapshotId: "snap-m",
			},
			{
				id: "proj-new",
				name: "Example service",
				instructionSettings: { sourceOfTruth: "UPLOAD" },
				publishedInstructionSnapshotId: null,
			},
		]);

		const candidates = await listInstructionTemplateCandidates("org-1");

		expect(mocks.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: "org-1", deletedAt: null },
			}),
		);
		expect(candidates).toEqual([
			{ id: "proj-a", name: "Example platform", published: true },
			{ id: "proj-new", name: "Example service", published: false },
		]);
	});

	it("lists published projects first, then by name ignoring case and reading numbers by value", async () => {
		mocks.findMany.mockResolvedValue(
			[
				{ id: "p-upper", name: "Example B", published: false },
				{ id: "p-ten", name: "example 10", published: false },
				{ id: "p-lower", name: "example a", published: false },
				{ id: "p-two", name: "Example 2", published: false },
				{ id: "p-late", name: "Zeta example", published: true },
				{ id: "p-early", name: "alpha example", published: true },
			].map(({ id, name, published }) => ({
				id,
				name,
				instructionSettings: null,
				publishedInstructionSnapshotId: published ? `snap-${id}` : null,
			})),
		);

		const candidates = await listInstructionTemplateCandidates("org-1");

		expect(candidates.map((candidate) => candidate.id)).toEqual([
			"p-early",
			"p-late",
			"p-two",
			"p-ten",
			"p-lower",
			"p-upper",
		]);
	});
});

describe("findInstructionTemplateCandidate", () => {
	it("reads the project within the organization and says whether it may be named", async () => {
		mocks.findFirst.mockResolvedValue({
			id: "proj-repo",
			name: "Example repository project",
			instructionSettings: { sourceOfTruth: "REPOSITORY" },
		});

		await expect(
			findInstructionTemplateCandidate("proj-repo", "org-1"),
		).resolves.toEqual({
			id: "proj-repo",
			name: "Example repository project",
			eligible: false,
		});
		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "proj-repo",
					organizationId: "org-1",
					deletedAt: null,
				},
			}),
		);
	});

	it("is null for a project that is not a live project of the organization", async () => {
		mocks.findFirst.mockResolvedValue(null);

		await expect(
			findInstructionTemplateCandidate("proj-elsewhere", "org-1"),
		).resolves.toBeNull();
	});
});
