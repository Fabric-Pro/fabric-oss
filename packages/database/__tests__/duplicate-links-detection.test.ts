import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
}));

vi.mock("../prisma/client", async (original) => ({
	...(await original<typeof import("../prisma/client")>()),
	db: {
		userStory: { findMany: mocks.findMany },
	},
}));

import { listActiveStoriesForDetection } from "../prisma/queries/projects/duplicate-links";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findMany.mockResolvedValue([]);
});

it("filters out INITIATIVE from duplicate detection and meeting routing queries", async () => {
	await listActiveStoriesForDetection("p-1");
	expect(mocks.findMany).toHaveBeenCalledTimes(1);
	const query = mocks.findMany.mock.calls[0][0];
	expect(query.where.projectId).toBe("p-1");
	expect(query.where.kind).toEqual({ not: "INITIATIVE" });
	expect(query.where.draftingStage).toEqual({ notIn: expect.any(Array) });
});
