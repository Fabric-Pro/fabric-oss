/**
 * Roadmap-recommendation acceptance policy inside `applyBacklogChanges`
 * (Fizzy #2208). The policy is read from the proposal row, so every door that
 * applies a ROADMAP_RECOMMENDATION proposal gets it:
 *   - creates are pinned to FEATURE, drafted through Clean Spec
 *     (`requireCleanSpec`) and stamped AI_RECOMMENDED + the batch id;
 *   - `predrafted` / `sourceRef` / `kindOverride` shortcuts are stripped;
 *   - updates are refused per item;
 *   - a title collision is recorded as resolved in the index mirror.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mocks } = vi.hoisted(() => {
	const mockDb = {
		project: { findFirst: vi.fn() },
		userStory: { findFirst: vi.fn(), findMany: vi.fn() },
		pendingBacklogProposal: {
			updateMany: vi.fn(),
			findUnique: vi.fn(),
			update: vi.fn(),
		},
		pendingBacklogProposalApplication: {
			findMany: vi.fn(),
			create: vi.fn(),
		},
		$transaction: vi.fn(),
	};
	const mocks = {
		createStory: vi.fn(),
		updateStory: vi.fn(),
		recordAudit: vi.fn(),
		recordProposalApplication: vi.fn(),
		appendAppliedChangeIndexes: vi.fn(),
		createStoryFromProposal: vi.fn(),
	};
	return { mockDb, mocks };
});

vi.mock("@repo/database", async () => {
	return {
		db: mockDb,
		tenantWhere: vi.fn(() => ({})),
		createStory: mocks.createStory,
		updateStory: mocks.updateStory,
		recordAudit: mocks.recordAudit,
		recordProposalApplication: mocks.recordProposalApplication,
		appendAppliedChangeIndexes: mocks.appendAppliedChangeIndexes,
		getBoundPromptForAgent: vi.fn(),
		normalizeBacklogTitle: (title: string) => title.toLowerCase().trim(),
		TERMINAL_DRAFTING_STAGES: ["DECLINED", "CLOSED"],
		isTerminalWorkItemState: (item: {
			draftingStage: string;
			pmAutoHidden: boolean;
		}) =>
			["DECLINED", "CLOSED"].includes(item.draftingStage) ||
			item.pmAutoHidden === true,
	};
});

vi.mock("../src/lib/create-story-from-proposal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
}));

vi.mock("../src/lib/trigger-duplicate-detection", () => ({
	triggerDuplicateDetection: vi.fn(async () => null),
}));

vi.mock("@repo/ai", () => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
	ApplicationFailure: { nonRetryable: (m: string) => new Error(m) },
}));

import {
	applyBacklogChanges,
	type ChangeProposal,
} from "../src/activities/backlog-context/analyze-context";

type Change = ChangeProposal["changes"][number];

function createChange(title: string, extra: Partial<Change> = {}): Change {
	return {
		type: "feature",
		action: "create",
		title: { to: title },
		reasoning: "grounded in the project brief",
		sourceContext: "multiple",
		...extra,
	};
}

function apply(
	approvedChanges: Change[],
	extra: {
		approvedChangeIndexes?: number[];
		existingBacklog?: {
			stories: Array<{ id: string; identifier: string; title: string }>;
		};
	} = {},
) {
	return applyBacklogChanges({
		projectId: "p1",
		userId: "u1",
		organizationId: "org-1",
		approvedChanges,
		existingBacklog: extra.existingBacklog ?? { stories: [] },
		pendingProposalId: "batch-1",
		proposalId: "batch-1",
		approvedChangeIndexes: extra.approvedChangeIndexes,
	});
}

function createParams(): Record<string, unknown>[] {
	return mocks.createStoryFromProposal.mock.calls.map(
		(c) => c[0] as Record<string, unknown>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.project.findFirst.mockResolvedValue({ id: "p1" });
	mockDb.userStory.findMany.mockResolvedValue([]);
	mockDb.pendingBacklogProposal.findUnique.mockResolvedValue({
		source: "ROADMAP_RECOMMENDATION",
	});
	mockDb.pendingBacklogProposalApplication.findMany.mockResolvedValue([]);
	mockDb.$transaction.mockImplementation(
		async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
	);
	let m = 0;
	mocks.createStoryFromProposal.mockImplementation(
		async (params: { title: string }) => {
			m += 1;
			return {
				story: {
					id: `story-${m}`,
					identifier: `F-10${m}`,
					title: params.title,
					description: null,
				},
				aiDrafted: true,
			};
		},
	);
});

describe("applyBacklogChanges — ROADMAP_RECOMMENDATION source", () => {
	it("reads the policy from the proposal row", async () => {
		await apply([createChange("Saved searches")]);
		expect(mockDb.pendingBacklogProposal.findUnique).toHaveBeenCalledWith({
			where: { id: "batch-1" },
			select: { source: true },
		});
	});

	it("stamps AI_RECOMMENDED + the batch id and requires a Clean Spec FEATURE draft", async () => {
		await apply([createChange("Saved searches")]);
		expect(createParams()[0]).toMatchObject({
			source: "AI_RECOMMENDED",
			aiRecommendationBatchId: "batch-1",
			createdFromProposalId: "batch-1",
			requireCleanSpec: true,
			kind: "FEATURE",
			skipClassifier: true,
			skipDrafting: false,
			bodyAlreadyDrafted: false,
		});
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({ source: "AI_RECOMMENDED" }),
			}),
		);
	});

	it("strips predrafted / sourceRef / kindOverride so the Clean Spec draft path is taken", async () => {
		await apply([
			createChange("Saved searches", {
				predrafted: true,
				needsMoreInfo: true,
				sourceRef: "AA-01",
				kindOverride: "BUG",
			}),
		]);
		expect(mocks.createStory).not.toHaveBeenCalled();
		const params = createParams()[0];
		expect(params).toMatchObject({
			kind: "FEATURE",
			skipDrafting: false,
			bodyAlreadyDrafted: false,
			requireCleanSpec: true,
		});
		expect(params.needsMoreInfo).toBeUndefined();
	});

	it("pins a bug-typed create to a feature", async () => {
		await apply([createChange("Crash on save", { type: "bug" })]);
		const params = createParams()[0];
		expect(params.kind).toBe("FEATURE");
		expect(params.labels).not.toContain("bug");
		expect(params.source).toBe("AI_RECOMMENDED");
	});

	it("refuses an update per item and still applies the creates", async () => {
		const result = await apply([
			createChange("Existing thing", {
				action: "update",
				existingId: "cabcdefghijklmnopqrstuvwxyz",
			}),
			createChange("Saved searches"),
		]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.error).toBe(
			"Recommendations can only create features",
		);
		expect(mocks.updateStory).not.toHaveBeenCalled();
		expect(result.createdItemMap[1]).toBe("story-1");
	});

	it("records a title-collision skip as resolved, by proposal index", async () => {
		const result = await apply(
			[createChange("Saved searches"), createChange("Audit log")],
			{
				approvedChangeIndexes: [4, 9],
				existingBacklog: {
					stories: [
						{
							id: "s-old",
							identifier: "F-001",
							title: "Audit log",
						},
					],
				},
			},
		);
		expect(result.skippedDuplicates).toHaveLength(1);
		expect(mocks.appendAppliedChangeIndexes).toHaveBeenCalledWith(
			"batch-1",
			[9],
		);
		// No fake application row for the skipped item.
		expect(mocks.recordProposalApplication).toHaveBeenCalledTimes(1);
	});

	it("keeps the AI_UPDATE stamp for any other source", async () => {
		mockDb.pendingBacklogProposal.findUnique.mockResolvedValue({
			source: "TEAMS_CHANNEL",
		});
		const result = await apply(
			[createChange("Saved searches"), createChange("Audit log")],
			{
				existingBacklog: {
					stories: [
						{
							id: "s-old",
							identifier: "F-001",
							title: "Audit log",
						},
					],
				},
			},
		);
		const params = createParams()[0];
		expect(params.source).toBe("AI_UPDATE");
		expect(params).not.toHaveProperty("aiRecommendationBatchId");
		expect(params).not.toHaveProperty("requireCleanSpec");
		expect(result.skippedDuplicates).toHaveLength(1);
		expect(mocks.appendAppliedChangeIndexes).not.toHaveBeenCalled();
	});
});
