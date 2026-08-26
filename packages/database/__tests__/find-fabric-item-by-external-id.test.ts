/**
 * Unit tests for `findFabricItemByExternalId` — covers the `pmAutoHidden`
 * field added in Task 4 of the PM terminal-status UNHIDE producer (#1360).
 *
 * Run with: pnpm --filter @repo/database test __tests__/find-fabric-item-by-external-id.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	storyFindFirst: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		userStory: { findFirst: mocks.storyFindFirst },
	},
}));

import { findFabricItemByExternalId } from "../prisma/queries/pending-pm-state-changes";

beforeEach(() => {
	Object.values(mocks).forEach((m) => m.mockReset());
	// Default: nothing found
	mocks.storyFindFirst.mockResolvedValue(null);
});

describe("findFabricItemByExternalId — pmAutoHidden (Task 4)", () => {
	it("STORY return includes pmAutoHidden when story has pmAutoHidden:true", async () => {
		mocks.storyFindFirst.mockResolvedValue({
			id: "story-1",
			draftingStage: "CLOSED",
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
			pmAutoHidden: true,
		});

		const result = await findFabricItemByExternalId("proj-1", "ADO-1");

		expect(result).not.toBeNull();
		expect(result!.entityType).toBe("STORY");
		expect(result).toMatchObject({ pmAutoHidden: true });
	});

	it("STORY return includes pmAutoHidden:false when story has pmAutoHidden:false", async () => {
		mocks.storyFindFirst.mockResolvedValue({
			id: "story-1",
			draftingStage: "DRAFT",
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
			pmAutoHidden: false,
		});

		const result = await findFabricItemByExternalId("proj-1", "ADO-1");

		expect(result).toMatchObject({ pmAutoHidden: false });
	});

	it("the story query select includes pmAutoHidden (asserts the select arg)", async () => {
		mocks.storyFindFirst.mockResolvedValue({
			id: "story-1",
			draftingStage: "DRAFT",
			lastSyncedPmHash: null,
			lastPmSyncStatus: null,
			pmAutoHidden: false,
		});

		await findFabricItemByExternalId("proj-1", "ADO-1");

		const callArgs = mocks.storyFindFirst.mock.calls[0]?.[0];
		expect(callArgs?.select).toMatchObject({ pmAutoHidden: true });
	});

	it("returns null when nothing found", async () => {
		const result = await findFabricItemByExternalId("proj-1", "NO-MATCH");
		expect(result).toBeNull();
	});
});
