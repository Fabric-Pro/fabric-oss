/**
 * Restoring an older version rewrites an item's content, so on an
 * AI-recommended item it is a person's content edit (Fizzy #2211). A restore
 * that only moves the stage is not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	storyFindFirst: vi.fn(),
	versionFindFirst: vi.fn(),
	txUpdateMany: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		$transaction: mocks.transaction,
		userStory: { findFirst: mocks.storyFindFirst },
		featureVersion: { findFirst: mocks.versionFindFirst },
	},
}));

import { restoreFeatureVersion } from "../feature-versions";

const tx = {
	userStory: {
		findFirst: vi.fn(async () => ({
			draftingStage: "DRAFT",
			deliveryTrack: "SPECIFY",
			description: "current desc",
			acceptanceCriteria: "current AC",
		})),
		findUnique: vi.fn(async () => ({ id: "story-1", tasks: [] })),
		updateMany: mocks.txUpdateMany,
	},
	featureVersion: { create: vi.fn(async () => ({})) },
	project: {
		findUnique: vi.fn(async () => ({
			engagementProfile: "PROPOSAL",
			enforceSpecifyGate: false,
			enforceSpikeGate: false,
			enforceDiscoveryGate: false,
			organizationId: "org-1",
			userId: "owner-1",
			_count: { stageApprovers: 0 },
		})),
	},
	codingRun: { count: vi.fn(async () => 0) },
	projectDocument: { findFirst: vi.fn(async () => null) },
	stageTransitionRequest: {
		updateMany: vi.fn(async () => ({ count: 0 })),
		create: vi.fn(),
	},
};

const CURRENT = {
	id: "story-1",
	version: 3,
	description: "current desc",
	acceptanceCriteria: "current AC",
	draftingStage: "DRAFT",
	source: "AI_RECOMMENDED",
	firstHumanEditAt: null as Date | null,
};

function restore() {
	return restoreFeatureVersion("story-1", "proj-1", 2, "user-1", {
		userId: "user-1",
	});
}

function writeData(): Record<string, unknown> {
	return mocks.txUpdateMany.mock.calls.at(-1)?.[0].data;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.transaction.mockImplementation(async (fn: (t: unknown) => unknown) =>
		fn(tx),
	);
	mocks.txUpdateMany.mockResolvedValue({ count: 1 });
	mocks.storyFindFirst.mockResolvedValue(CURRENT);
	mocks.versionFindFirst.mockResolvedValue({
		id: "fv-1",
		description: "old desc",
		acceptanceCriteria: "current AC",
		draftingStage: "DRAFT",
	});
});

describe("restoreFeatureVersion firstHumanEditAt", () => {
	it("stamps it when the restore changes an AI-recommended item's content", async () => {
		await restore();

		expect(writeData().firstHumanEditAt).toBeInstanceOf(Date);
		expect(writeData().firstHumanEditAt).toBe(writeData().lastEditedAt);
	});

	it("does not stamp a restore that only moves the stage", async () => {
		mocks.versionFindFirst.mockResolvedValue({
			id: "fv-1",
			description: CURRENT.description,
			acceptanceCriteria: CURRENT.acceptanceCriteria,
			draftingStage: "PUBLISHED",
		});

		await restore();

		expect(writeData()).not.toHaveProperty("firstHumanEditAt");
	});

	it("never overwrites an existing stamp", async () => {
		mocks.storyFindFirst.mockResolvedValue({
			...CURRENT,
			firstHumanEditAt: new Date("2026-08-01T00:00:00.000Z"),
		});

		await restore();

		expect(writeData()).not.toHaveProperty("firstHumanEditAt");
	});

	it("does not stamp an item that was not AI-recommended", async () => {
		mocks.storyFindFirst.mockResolvedValue({
			...CURRENT,
			source: "MANUAL",
		});

		await restore();

		expect(writeData()).not.toHaveProperty("firstHumanEditAt");
	});
});
