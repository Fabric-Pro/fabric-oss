/**
 * Unit tests for `findFabricItemsByExternalId` — the PLURAL lookup that feeds
 * the FLAG_MISSING producer (#1360 Task 5). This query backs a DESTRUCTIVE
 * unlink path, so it is covered at the query level (not only via mocked
 * consumer tests). Its core property is anti-masking: an externalId shared by
 * multiple stories must return ALL of them so a co-linked row cannot hide
 * another. Stories are the only work-item rows since the Epic/Feature folder
 * tables were dropped.
 *
 * Run with: pnpm --filter @repo/database test __tests__/find-fabric-items-by-external-id.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	storyFindMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		userStory: { findMany: mocks.storyFindMany },
	},
}));

import { findFabricItemsByExternalId } from "../prisma/queries/pending-pm-state-changes";

beforeEach(() => {
	Object.values(mocks).forEach((m) => m.mockReset());
	// Default: nothing found
	mocks.storyFindMany.mockResolvedValue([]);
});

describe("findFabricItemsByExternalId", () => {
	it("returns every story sharing the externalId with entityType STORY + server stamp", async () => {
		mocks.storyFindMany.mockResolvedValue([
			{
				id: "story-1",
				draftingStage: "PUBLISHED",
				externalMcpServerId: "srv-1",
			},
			{
				id: "story-2",
				draftingStage: "DRAFT",
				externalMcpServerId: null,
			},
		]);

		const result = await findFabricItemsByExternalId("proj-1", "AB#1");

		expect(result).toEqual([
			{
				entityType: "STORY",
				entityId: "story-1",
				draftingStage: "PUBLISHED",
				externalMcpServerId: "srv-1",
			},
			{
				entityType: "STORY",
				entityId: "story-2",
				draftingStage: "DRAFT",
				externalMcpServerId: null,
			},
		]);
		// The query is scoped to the project + externalId.
		expect(mocks.storyFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "proj-1", externalId: "AB#1" },
			}),
		);
	});

	it("anti-masking: an externalId on TWO stories returns BOTH entries", async () => {
		mocks.storyFindMany.mockResolvedValue([
			{
				id: "story-1",
				draftingStage: "DRAFT",
				externalMcpServerId: "srv-1",
			},
			{
				id: "story-2",
				draftingStage: "CLOSED",
				externalMcpServerId: "srv-1",
			},
		]);

		const result = await findFabricItemsByExternalId("proj-1", "AB#1");

		expect(result).toHaveLength(2);
		expect(result).toContainEqual(
			expect.objectContaining({
				entityType: "STORY",
				entityId: "story-1",
			}),
		);
		expect(result).toContainEqual(
			expect.objectContaining({
				entityType: "STORY",
				entityId: "story-2",
			}),
		);
	});

	it("returns [] when nothing matches", async () => {
		const result = await findFabricItemsByExternalId("proj-1", "NO-MATCH");
		expect(result).toEqual([]);
	});
});
