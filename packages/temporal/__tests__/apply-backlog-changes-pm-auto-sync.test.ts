/**
 * Unit tests for the AI Update sidebar's `syncToPM → enablePmAutoSync`
 * threading in `applyBacklogChanges`.
 *
 * Bug fix: when a user approved an AI Update proposal with "Sync to PM" on,
 * the first push succeeded (via the workflow's per-item syncWorkItemToPM
 * loop) but the new row landed with `pmAutoSyncEnabled=false`. Every later
 * Fabric edit was then a local-only mutation — silent divergence from the
 * PM tool. This activity passes `enablePmAutoSync: syncToPM` through to
 * `createStoryFromProposal` so the per-row gate is honored on subsequent
 * edits. `user_story` is the only work-item table (the Epic/Feature folder
 * tables were dropped), so EVERY create — feature, epic-normalized, bug —
 * routes through the same helper.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		createStoryFromProposal: vi.fn(),
		updateStory: vi.fn(),
		tenantWhere: vi.fn(() => ({
			organizationId: "org-pm-1",
			userId: "user-pm-1",
		})),
		dbProjectFindFirst: vi.fn(),
		dbUserStoryFindMany: vi.fn(),
		heartbeat: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: mocks.dbProjectFindFirst },
		userStory: { findMany: mocks.dbUserStoryFindMany, findFirst: vi.fn() },
	},
	tenantWhere: mocks.tenantWhere,
	createStory: vi.fn(),
	updateStory: mocks.updateStory,
	normalizeBacklogTitle: (title: string) =>
		title
			.toLowerCase()
			.trim()
			.replace(/^\[bug\]\s+/i, "")
			.trim(),
	TERMINAL_DRAFTING_STAGES: ["DECLINED", "CLOSED"],
	isTerminalWorkItemState: (item: {
		draftingStage: string;
		pmAutoHidden: boolean;
	}) =>
		["DECLINED", "CLOSED"].includes(item.draftingStage) ||
		item.pmAutoHidden === true,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: mocks.heartbeat,
}));

vi.mock("../src/lib/create-story-from-proposal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
}));

// Stub the background duplicate-detection enqueue (own dedicated unit test) so
// this suite stays hermetic and the PM-auto-sync assertions are unaffected.
vi.mock("../src/lib/trigger-duplicate-detection", () => ({
	triggerDuplicateDetection: vi.fn(async () => ({
		workflowId: "dup-detect-test",
	})),
}));

import { applyBacklogChanges } from "../src/activities/backlog-context/analyze-context";

const EMPTY_BACKLOG = { stories: [] };
const PROJECT_ID = "project-pm-1";
const USER_ID = "user-pm-1";
const ORG_ID = "org-pm-1";

function makeEpicCreate(title: string) {
	return {
		action: "create" as const,
		type: "epic" as const,
		title: { to: title, from: null },
		description: { to: "epic desc", from: null },
		acceptanceCriteria: undefined,
		priority: undefined,
		size: undefined,
		parentFeatureIdentifier: undefined,
		parentFeatureTitle: undefined,
		existingExternalId: undefined,
		reasoning: "test",
		sourceContext: "test",
	};
}

function makeFeatureCreate(title: string) {
	return {
		action: "create" as const,
		type: "feature" as const,
		title: { to: title, from: null },
		description: { to: "feature desc", from: null },
		acceptanceCriteria: undefined,
		priority: undefined,
		size: undefined,
		parentEpicIdentifier: undefined,
		parentEpicTitle: undefined,
		existingExternalId: undefined,
		reasoning: "test",
		sourceContext: "test",
	};
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset?.();
	}
	mocks.tenantWhere.mockReturnValue({
		organizationId: ORG_ID,
		userId: USER_ID,
	});
	mocks.dbProjectFindFirst.mockResolvedValue({ id: PROJECT_ID });
	mocks.dbUserStoryFindMany.mockResolvedValue([]);
	mocks.createStoryFromProposal.mockImplementation(
		async (p: { title: string }) => ({
			story: {
				id: `story-${p.title.toLowerCase().replace(/\s+/g, "-")}`,
				identifier: "F-100",
				title: p.title,
				kind: "FEATURE",
			},
			aiDrafted: false,
		}),
	);
});

describe("applyBacklogChanges — pmAutoSyncEnabled threading", () => {
	it("syncToPM=true → createStoryFromProposal receives enablePmAutoSync=true (BUG create)", async () => {
		await applyBacklogChanges({
			projectId: PROJECT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			approvedChanges: [
				{
					action: "create",
					type: "bug",
					title: { to: "Crash on iOS", from: null },
					description: { to: "Login crashes", from: null },
					acceptanceCriteria: undefined,
					priority: undefined,
					size: undefined,
					existingExternalId: undefined,
					reasoning: "test",
					sourceContext: "test",
				},
			],
			existingBacklog: EMPTY_BACKLOG,
			syncToPM: true,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		const arg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
		};
		expect(arg.enablePmAutoSync).toBe(true);
	});

	it("syncToPM=false → enablePmAutoSync is undefined (preserves default-false on row)", async () => {
		await applyBacklogChanges({
			projectId: PROJECT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			approvedChanges: [
				{
					action: "create",
					type: "bug",
					title: { to: "Crash on Android", from: null },
					description: { to: "Login crashes", from: null },
					acceptanceCriteria: undefined,
					priority: undefined,
					size: undefined,
					existingExternalId: undefined,
					reasoning: "test",
					sourceContext: "test",
				},
			],
			existingBacklog: EMPTY_BACKLOG,
			syncToPM: false,
		});

		const arg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
		};
		expect(arg.enablePmAutoSync).toBeUndefined();
	});

	it("syncToPM=true + epic CREATE (normalized to feature) → createStoryFromProposal receives enablePmAutoSync=true", async () => {
		await applyBacklogChanges({
			projectId: PROJECT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			approvedChanges: [makeEpicCreate("Q3 Onboarding")],
			existingBacklog: EMPTY_BACKLOG,
			syncToPM: true,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		const arg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
			kind?: string;
		};
		expect(arg.enablePmAutoSync).toBe(true);
		expect(arg.kind).toBe("FEATURE");
	});

	it("syncToPM=true + feature CREATE → createStoryFromProposal receives enablePmAutoSync=true (roadmap UserStory)", async () => {
		await applyBacklogChanges({
			projectId: PROJECT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			approvedChanges: [makeFeatureCreate("CSV export")],
			existingBacklog: EMPTY_BACKLOG,
			syncToPM: true,
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		const arg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
			kind?: string;
		};
		expect(arg.enablePmAutoSync).toBe(true);
		expect(arg.kind).toBe("FEATURE");
	});

	it("syncToPM=undefined → none of the creates receive a flag", async () => {
		await applyBacklogChanges({
			projectId: PROJECT_ID,
			userId: USER_ID,
			organizationId: ORG_ID,
			approvedChanges: [makeEpicCreate("Q4 launch")],
			existingBacklog: EMPTY_BACKLOG,
			// syncToPM omitted
		});

		const arg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
		};
		expect(arg.enablePmAutoSync).toBeUndefined();
	});
});
