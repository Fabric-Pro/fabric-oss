/**
 * A kind change moves the row version (Fizzy #2048).
 *
 * The conversion redraft protects itself from landing a stale body with an
 * `expectedVersion` guard, and that guard has a premise: a second conversion
 * moves the version on, so an in-flight redraft's expectation stops matching.
 *
 * The premise is not free. `shouldCreateVersion` decides both whether a
 * `FeatureVersion` is snapshotted AND whether the write takes the
 * version-incrementing path at all — the `expectedVersion` check lives inside
 * that branch, so a change that does not qualify skips the guard entirely.
 *
 * Converting a work item writes only `kind` and a stage snapped to DRAFT. Every
 * bug already sits in DRAFT, so on a BUG -> FEATURE -> BUG toggle the stage
 * never changes and `kind` is the only thing that moves. If `kind` did not
 * count, the version would stand still across both toggles, the first redraft's
 * `expectedVersion` would still match when it finally landed, and it would
 * write its FEATURE-shaped body onto a row that is now a BUG — the exact
 * cross-type bleed the ticket exists to close.
 *
 * These tests pin the premise, not the mechanism. A test that hands the guard a
 * pre-diverged version proves the comparison works while saying nothing about
 * whether the divergence can ever occur.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	txFindUniqueMock,
	txUpdateMock,
	txUpdateManyMock,
	txVersionCreateManyMock,
	txPendingPmUpdateManyMock,
	txStreakDeleteManyMock,
	transactionMock,
} = vi.hoisted(() => ({
	txFindUniqueMock: vi.fn(),
	txUpdateMock: vi.fn(),
	txUpdateManyMock: vi.fn(),
	txVersionCreateManyMock: vi.fn(),
	txPendingPmUpdateManyMock: vi.fn(),
	txStreakDeleteManyMock: vi.fn(),
	transactionMock: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: { $transaction: transactionMock },
}));

import { updateStory } from "../stories";

const STORY_ID = "story-1";
const PROJECT_ID = "proj-1";

/** A bug at rest: bugs live in DRAFT, which is what makes the stage a no-op. */
const BUG_IN_DRAFT = {
	version: 4,
	updatedAt: new Date("2026-08-10T10:00:00.000Z"),
	title: "Editor drops focus on paste",
	description: "## Steps to Reproduce\n\n1. Paste into the editor",
	acceptanceCriteria: null,
	draftingStage: "DRAFT",
	kind: "BUG",
	priority: "P2_MEDIUM",
	roadmapOrder: 1,
	externalId: null,
	externalMcpServerId: null,
};

const RETURNED_ROW = {
	id: STORY_ID,
	kind: "FEATURE",
	draftingStage: "DRAFT",
	status: null,
	tasks: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	txFindUniqueMock.mockResolvedValue(BUG_IN_DRAFT);
	txUpdateMock.mockResolvedValue(RETURNED_ROW);
	txUpdateManyMock.mockResolvedValue({ count: 1 });
	txVersionCreateManyMock.mockResolvedValue({ count: 1 });
	txPendingPmUpdateManyMock.mockResolvedValue({ count: 0 });
	txStreakDeleteManyMock.mockResolvedValue({ count: 0 });

	transactionMock.mockImplementation(async (fn: (tx: unknown) => unknown) =>
		fn({
			userStory: {
				findUnique: txFindUniqueMock,
				update: txUpdateMock,
				updateMany: txUpdateManyMock,
			},
			featureVersion: { createMany: txVersionCreateManyMock },
			pendingPmStateChange: { updateMany: txPendingPmUpdateManyMock },
			pmTicketMissingStreak: { deleteMany: txStreakDeleteManyMock },
		}),
	);
});

describe("updateStory — a kind change is version-worthy", () => {
	it("increments the version when only the kind changes", async () => {
		// Exactly what conversion writes: the new kind, and a stage snapped to
		// DRAFT that the row already holds.
		await updateStory(
			STORY_ID,
			PROJECT_ID,
			{ kind: "FEATURE", draftingStage: "DRAFT" },
			{ lastEditedSource: "MANUAL" },
		);

		expect(txUpdateManyMock).toHaveBeenCalledTimes(1);
		const call = txUpdateManyMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		};
		expect(call.data.version).toEqual({ increment: 1 });
		// The version is in the WHERE clause, not merely compared in memory —
		// an in-memory compare leaves the race open.
		expect(call.where).toMatchObject({ version: 4 });
	});

	it("does not take the early-return path, so the expectedVersion guard runs", async () => {
		// The guard lives inside the version-creating branch. A kind-only change
		// that fell through to `update` would skip it silently.
		await updateStory(
			STORY_ID,
			PROJECT_ID,
			{ kind: "FEATURE", draftingStage: "DRAFT" },
			{ lastEditedSource: "MANUAL" },
		);

		expect(txUpdateMock).not.toHaveBeenCalled();
	});

	it("refuses a write whose expectedVersion no longer matches", async () => {
		await expect(
			updateStory(
				STORY_ID,
				PROJECT_ID,
				{ kind: "FEATURE", draftingStage: "DRAFT" },
				{ expectedVersion: 3, lastEditedSource: "MANUAL" },
			),
		).rejects.toThrow(/updated by another request/i);

		expect(txUpdateManyMock).not.toHaveBeenCalled();
	});

	it("still skips the version when nothing version-worthy changed", async () => {
		// Converting to the kind the row already holds, with the stage it already
		// holds — the no-op branch must stay cheap.
		await updateStory(STORY_ID, PROJECT_ID, {
			kind: "BUG",
			draftingStage: "DRAFT",
		});

		expect(txUpdateManyMock).toHaveBeenCalledTimes(1);
		expect(txUpdateManyMock.mock.calls[0]?.[0].data).not.toHaveProperty(
			"version",
		);
		expect(txUpdateMock).not.toHaveBeenCalled();
	});
});
