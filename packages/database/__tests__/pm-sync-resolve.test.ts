/**
 * Unit tests for the `@repo/database` PM-sync conflict-resolution dispatch
 * helpers (`getPmSyncItemState` / `clearPmSyncConflictFlag` /
 * `writePmSyncItemContent`).
 *
 * Mocks the Prisma client (`../prisma/client`) — no real DB. Mirrors the
 * `pm-sync-log.test.ts` convention.
 *
 * Asserts the `story`/`bug` → `db.userStory` coalescing (mirroring
 * `enqueue-pm-sync.ts`), that the read selects only the columns the
 * resolution flow needs, and that legacy `epic`/`feature` item types are
 * no-ops (the Epic/Feature folder tables were dropped — stories are the only
 * work-item rows).
 *
 * Run with: pnpm --filter @repo/database test __tests__/pm-sync-resolve.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	storyFindFirst,
	storyFindUnique,
	storyUpdate,
	storyUpdateMany,
	testCaseUpdateMany,
	createFeatureVersionMock,
} = vi.hoisted(() => ({
	storyFindFirst: vi.fn(),
	storyFindUnique: vi.fn(),
	storyUpdate: vi.fn(),
	storyUpdateMany: vi.fn(),
	testCaseUpdateMany: vi.fn(),
	createFeatureVersionMock: vi.fn(),
}));

vi.mock("../prisma/client", async () => {
	const actual =
		await vi.importActual<typeof import("../prisma/client")>(
			"../prisma/client",
		);
	return {
		PmSyncStatus: actual.PmSyncStatus,
		db: {
			userStory: {
				findFirst: storyFindFirst,
				findUnique: storyFindUnique,
				update: storyUpdate,
				updateMany: storyUpdateMany,
			},
			testCase: {
				updateMany: testCaseUpdateMany,
			},
		},
	};
});

vi.mock("../prisma/queries/projects/feature-versions", () => ({
	createFeatureVersion: createFeatureVersionMock,
}));

import {
	applyAdoContentToFabricItem,
	clearPmSyncConflictFlag,
	clearPmSyncFailure,
	clearPmSyncFailures,
	getPmSyncItemState,
	writePmSyncItemContent,
} from "../prisma/queries/projects/pm-sync-resolve";

beforeEach(() => {
	for (const m of [
		storyFindFirst,
		storyFindUnique,
		storyUpdate,
		storyUpdateMany,
		testCaseUpdateMany,
		createFeatureVersionMock,
	]) {
		m.mockReset();
	}
	storyFindUnique.mockResolvedValue({
		title: "Current title",
		description: "Current body",
	});
});

describe("getPmSyncItemState", () => {
	it.each(["story", "bug"] as const)(
		"coalesces itemType=%s to db.userStory",
		async (itemType) => {
			storyFindFirst.mockResolvedValue({
				id: "story_1",
				lastPmSyncStatus: "CONFLICT",
			});

			const result = await getPmSyncItemState({
				itemType,
				itemId: "story_1",
				projectId: "proj_1",
			});

			expect(storyFindFirst).toHaveBeenCalledWith({
				where: { id: "story_1", projectId: "proj_1" },
				select: { id: true, lastPmSyncStatus: true },
			});
			expect(result).toEqual({
				id: "story_1",
				lastPmSyncStatus: "CONFLICT",
			});
		},
	);

	it.each(["epic", "feature"] as const)(
		"returns null for legacy itemType=%s without touching the DB (folder tables dropped)",
		async (itemType) => {
			const result = await getPmSyncItemState({
				itemType,
				itemId: "legacy_1",
				projectId: "proj_1",
			});
			expect(result).toBeNull();
			expect(storyFindFirst).not.toHaveBeenCalled();
		},
	);

	it("returns null when the item is not in the project", async () => {
		storyFindFirst.mockResolvedValue(null);
		const result = await getPmSyncItemState({
			itemType: "story",
			itemId: "missing",
			projectId: "proj_1",
		});
		expect(result).toBeNull();
	});
});

describe("clearPmSyncConflictFlag", () => {
	it.each(["story", "bug"] as const)(
		"coalesces itemType=%s to db.userStory",
		async (itemType) => {
			storyUpdate.mockResolvedValue({});
			await clearPmSyncConflictFlag({ itemType, itemId: "story_1" });
			expect(storyUpdate).toHaveBeenCalledWith({
				where: { id: "story_1" },
				data: { lastPmSyncStatus: "SUCCESS", lastPmSyncError: null },
			});
		},
	);

	it.each(["epic", "feature"] as const)(
		"no-ops for legacy itemType=%s (folder tables dropped)",
		async (itemType) => {
			await clearPmSyncConflictFlag({ itemType, itemId: "legacy_1" });
			expect(storyUpdate).not.toHaveBeenCalled();
		},
	);
});

describe("clearPmSyncFailure", () => {
	it.each(["story", "bug"] as const)(
		"clears a FAILED %s to null, scoped to project + FAILED via updateMany",
		async (itemType) => {
			storyUpdateMany.mockResolvedValue({ count: 1 });
			const result = await clearPmSyncFailure({
				itemType,
				itemId: "story_1",
				projectId: "proj_1",
			});
			expect(storyUpdateMany).toHaveBeenCalledWith({
				where: {
					id: "story_1",
					projectId: "proj_1",
					lastPmSyncStatus: "FAILED",
				},
				data: { lastPmSyncStatus: null, lastPmSyncError: null },
			});
			expect(result).toEqual({ cleared: 1 });
		},
	);

	it("is a no-op (cleared: 0) when the item is not in FAILED state", async () => {
		// `updateMany` scoped to FAILED matches nothing → count 0, never
		// clobbering a newer CONFLICT/SUCCESS/PENDING state.
		storyUpdateMany.mockResolvedValue({ count: 0 });
		const result = await clearPmSyncFailure({
			itemType: "story",
			itemId: "story_1",
			projectId: "proj_1",
		});
		expect(result).toEqual({ cleared: 0 });
	});

	it.each(["epic", "feature"] as const)(
		"no-ops for legacy itemType=%s (folder tables dropped)",
		async (itemType) => {
			const result = await clearPmSyncFailure({
				itemType,
				itemId: "legacy_1",
				projectId: "proj_1",
			});
			expect(storyUpdateMany).not.toHaveBeenCalled();
			expect(result).toEqual({ cleared: 0 });
		},
	);

	it("routes itemType=testCase to db.testCase (not userStory), scoped to project + FAILED/CONFLICT", async () => {
		testCaseUpdateMany.mockResolvedValue({ count: 1 });
		const result = await clearPmSyncFailure({
			itemType: "testCase",
			itemId: "tc_1",
			projectId: "proj_1",
		});
		expect(testCaseUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "tc_1",
				projectId: "proj_1",
				// Test-case Dismiss clears CONFLICT as well as FAILED — test cases
				// have no clearPmSyncConflictFlag path, so Dismiss handles both.
				lastPmSyncStatus: { in: ["FAILED", "CONFLICT"] },
			},
			data: { lastPmSyncStatus: null, lastPmSyncError: null },
		});
		expect(storyUpdateMany).not.toHaveBeenCalled();
		expect(result).toEqual({ cleared: 1 });
	});
});

describe("clearPmSyncFailures (bulk)", () => {
	it("clears all FAILED rows in the id set, scoped to project + FAILED", async () => {
		storyUpdateMany.mockResolvedValue({ count: 2 });
		const result = await clearPmSyncFailures({
			projectId: "proj_1",
			itemIds: ["a", "b", "c"],
		});
		expect(storyUpdateMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["a", "b", "c"] },
				projectId: "proj_1",
				lastPmSyncStatus: "FAILED",
			},
			data: { lastPmSyncStatus: null, lastPmSyncError: null },
		});
		expect(result).toEqual({ cleared: 2 });
	});

	it("short-circuits on an empty id list (no DB call)", async () => {
		const result = await clearPmSyncFailures({
			projectId: "proj_1",
			itemIds: [],
		});
		expect(storyUpdateMany).not.toHaveBeenCalled();
		expect(result).toEqual({ cleared: 0 });
	});

	it("targets db.testCase when itemType=testCase (default stays story)", async () => {
		testCaseUpdateMany.mockResolvedValue({ count: 2 });
		const result = await clearPmSyncFailures({
			projectId: "proj_1",
			itemIds: ["a", "b"],
			itemType: "testCase",
		});
		expect(testCaseUpdateMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["a", "b"] },
				projectId: "proj_1",
				lastPmSyncStatus: { in: ["FAILED", "CONFLICT"] },
			},
			data: { lastPmSyncStatus: null, lastPmSyncError: null },
		});
		expect(storyUpdateMany).not.toHaveBeenCalled();
		expect(result).toEqual({ cleared: 2 });
	});
});

describe("writePmSyncItemContent", () => {
	it("writes both title and description when supplied", async () => {
		storyUpdate.mockResolvedValue({});
		await writePmSyncItemContent({
			itemType: "story",
			itemId: "story_1",
			projectId: "proj_1",
			title: "Merged title",
			description: "Merged body",
		});
		expect(storyUpdate).toHaveBeenCalledWith({
			where: { id: "story_1", projectId: "proj_1" },
			data: { title: "Merged title", description: "Merged body" },
		});
	});

	it("omits unsupplied fields from the update payload", async () => {
		storyUpdate.mockResolvedValue({});
		await writePmSyncItemContent({
			itemType: "story",
			itemId: "story_1",
			projectId: "proj_1",
			description: "Merged body",
		});
		expect(storyUpdate).toHaveBeenCalledWith({
			where: { id: "story_1", projectId: "proj_1" },
			data: { description: "Merged body" },
		});
		const callData = storyUpdate.mock.calls[0]?.[0]?.data ?? {};
		expect(callData).not.toHaveProperty("title");
	});

	it.each(["story", "bug"] as const)(
		"coalesces itemType=%s to db.userStory",
		async (itemType) => {
			storyUpdate.mockResolvedValue({});
			await writePmSyncItemContent({
				itemType,
				itemId: "story_1",
				projectId: "proj_1",
				title: "Merged title",
				description: "Merged body",
			});
			expect(storyUpdate).toHaveBeenCalledWith({
				where: { id: "story_1", projectId: "proj_1" },
				data: { title: "Merged title", description: "Merged body" },
			});
		},
	);

	it("stamps CONFLICT_RESOLUTION + resolving user's name on a story write", async () => {
		storyUpdate.mockResolvedValue({});
		await writePmSyncItemContent({
			itemType: "story",
			itemId: "story_1",
			projectId: "proj_1",
			title: "Merged title",
			description: "Merged body",
			lastEditedSource: "CONFLICT_RESOLUTION",
			lastEditedByName: "Ada Lovelace",
		});
		expect(storyUpdate).toHaveBeenCalledWith({
			where: { id: "story_1", projectId: "proj_1" },
			data: {
				title: "Merged title",
				description: "Merged body",
				lastEditedByName: "Ada Lovelace",
				lastEditedSource: "CONFLICT_RESOLUTION",
				lastEditedAt: expect.any(Date),
			},
		});
	});

	it.each(["epic", "feature"] as const)(
		"no-ops for legacy itemType=%s (folder tables dropped)",
		async (itemType) => {
			await writePmSyncItemContent({
				itemType,
				itemId: "legacy_1",
				projectId: "proj_1",
				title: "Merged title",
				lastEditedSource: "CONFLICT_RESOLUTION",
				lastEditedByName: "Ada Lovelace",
			});
			expect(storyUpdate).not.toHaveBeenCalled();
		},
	);
});

describe("applyAdoContentToFabricItem", () => {
	it.each(["epic", "feature"] as const)(
		"no-ops for legacy itemType=%s (folder tables dropped)",
		async (itemType) => {
			await applyAdoContentToFabricItem({
				itemType,
				itemId: "legacy_1",
				projectId: "proj_1",
				title: "ADO title",
				description: "ADO body",
				newContentHash: "hash-legacy",
				userId: "user_1",
				organizationId: null,
			});

			expect(storyFindUnique).not.toHaveBeenCalled();
			expect(storyUpdate).not.toHaveBeenCalled();
			expect(createFeatureVersionMock).not.toHaveBeenCalled();
		},
	);

	it.each(["story", "bug"] as const)(
		"itemType=%s snapshots a FeatureVersion then overwrites title + description + hash + version",
		async (itemType) => {
			storyFindUnique.mockResolvedValue({
				id: "story_1",
				title: "old title",
				version: 3,
				description: "old body",
				acceptanceCriteria: "old AC",
				draftingStage: "DRAFT",
			});
			storyUpdate.mockResolvedValue({});
			createFeatureVersionMock.mockResolvedValue({});

			await applyAdoContentToFabricItem({
				itemType,
				itemId: "story_1",
				projectId: "proj_1",
				title: "ADO story",
				description: "ADO story body",
				newContentHash: "hash-story",
				userId: "user_1",
				organizationId: null,
			});

			// FeatureVersion snapshot at the bumped version with the spec's copy.
			// The snapshot must preserve the story's CURRENT drafting stage
			// (content ingest does not change the stage) — not a hardcoded value.
			expect(createFeatureVersionMock).toHaveBeenCalledTimes(1);
			expect(createFeatureVersionMock).toHaveBeenCalledWith(
				expect.objectContaining({
					storyId: "story_1",
					version: 4,
					draftingStage: "DRAFT",
					changeDescription:
						"ADO content sync: applied PM tool's title/description",
					changedBy: "user_1",
				}),
			);

			// Single userStory update: title + description + re-stamped hash + version.
			expect(storyUpdate).toHaveBeenCalledTimes(1);
			expect(storyUpdate).toHaveBeenCalledWith({
				where: { id: "story_1", projectId: "proj_1" },
				data: {
					title: "ADO story",
					description: "ADO story body",
					lastSyncedPmHash: "hash-story",
					version: 4,
					lastEditedAt: expect.any(Date),
					lastEditedByName: null,
					lastEditedSource: "PM_PULL",
				},
			});
		},
	);

	it("re-stamp invariant: post-write lastSyncedPmHash equals the passed content hash", async () => {
		// The caller computes computePmHash(title, description); this test proves
		// the helper writes exactly that hash through to the entity update.
		storyFindUnique.mockResolvedValue({
			id: "story_1",
			title: "old title",
			version: 1,
			description: "old",
			acceptanceCriteria: null,
			draftingStage: "DRAFT",
		});
		storyUpdate.mockResolvedValue({});
		createFeatureVersionMock.mockResolvedValue({});

		const newContentHash = "computed-by-caller-hash";
		await applyAdoContentToFabricItem({
			itemType: "story",
			itemId: "story_1",
			projectId: "proj_1",
			title: "T",
			description: "D",
			newContentHash,
			userId: "user_1",
			organizationId: null,
		});

		const writtenHash =
			storyUpdate.mock.calls[0]?.[0]?.data?.lastSyncedPmHash;
		expect(writtenHash).toBe(newContentHash);
	});

	it("no-ops when the story is not found in the project (no update, no version)", async () => {
		storyFindUnique.mockResolvedValue(null);

		await applyAdoContentToFabricItem({
			itemType: "story",
			itemId: "missing",
			projectId: "proj_1",
			title: "T",
			description: "D",
			newContentHash: "h",
			userId: "user_1",
			organizationId: null,
		});

		expect(createFeatureVersionMock).not.toHaveBeenCalled();
		expect(storyUpdate).not.toHaveBeenCalled();
	});
});
