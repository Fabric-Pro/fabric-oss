import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	transaction: vi.fn(),
	count: vi.fn(),
	projectFindUnique: vi.fn(),
	statusFindFirst: vi.fn(),
}));

vi.mock("../prisma/client", async (original) => ({
	...(await original<typeof import("../prisma/client")>()),
	db: {
		userStory: {
			count: mocks.count,
		},
		project: {
			findUnique: mocks.projectFindUnique,
		},
		projectStoryStatus: {
			findFirst: mocks.statusFindFirst,
		},
		$transaction: mocks.transaction,
	},
}));

import {
	countProjectInitiatives,
	InitiativesDisabledError,
	withVisibleStories,
} from "../prisma/queries/projects/initiative-visibility";
import { createStory } from "../prisma/queries/projects/stories";

describe("initiative visibility filter", () => {
	it("keeps the original where, including its OR, and adds the rule via AND", () => {
		const originalWhere = {
			projectId: "proj-1",
			OR: [
				{ title: { contains: "foo" } },
				{ description: { contains: "foo" } },
			],
		};

		const combined = withVisibleStories(originalWhere);

		expect(combined).toEqual({
			AND: [
				originalWhere,
				{
					NOT: {
						kind: "INITIATIVE",
						project: { initiativesEnabled: false },
					},
				},
			],
		});
	});
});

describe("countProjectInitiatives", () => {
	it("counts initiatives for the project including hidden ones", async () => {
		mocks.count.mockResolvedValue(3);

		const result = await countProjectInitiatives("proj-1");

		expect(result).toBe(3);
		expect(mocks.count).toHaveBeenCalledWith({
			where: { projectId: "proj-1", kind: "INITIATIVE" },
		});
	});
});

describe("createStory — Initiatives switch", () => {
	beforeEach(() => vi.clearAllMocks());

	it("refuses an Initiative when the project has Initiatives off", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			initiativesEnabled: false,
		});
		await expect(
			createStory({
				projectId: "proj-1",
				title: "Q3 goals",
				kind: "INITIATIVE",
				createdById: "u1",
				source: "MANUAL",
			}),
		).rejects.toBeInstanceOf(InitiativesDisabledError);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it("refuses an Initiative when project lookup returns null", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);
		await expect(
			createStory({
				projectId: "proj-1",
				title: "Q3 goals",
				kind: "INITIATIVE",
				createdById: "u1",
				source: "MANUAL",
			}),
		).rejects.toBeInstanceOf(InitiativesDisabledError);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it("lets an Initiative through when the switch is on", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			initiativesEnabled: true,
		});
		// Fail at the next step to prove the check passed without mocking the whole create.
		mocks.statusFindFirst.mockRejectedValue(new Error("past-the-gate"));
		await expect(
			createStory({
				projectId: "proj-1",
				title: "Q3 goals",
				kind: "INITIATIVE",
				createdById: "u1",
				source: "MANUAL",
			}),
		).rejects.toThrow("past-the-gate");
	});

	it("does not look up the project for a Feature", async () => {
		mocks.statusFindFirst.mockRejectedValue(new Error("past-the-gate"));
		await expect(
			createStory({
				projectId: "proj-1",
				title: "Add export",
				kind: "FEATURE",
				createdById: "u1",
				source: "MANUAL",
			}),
		).rejects.toThrow("past-the-gate");
		expect(mocks.projectFindUnique).not.toHaveBeenCalled();
	});
});
