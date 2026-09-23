import { beforeEach, describe, expect, it, vi } from "vitest";

const { groupByMock } = vi.hoisted(() => ({ groupByMock: vi.fn() }));

vi.mock("../../../client", () => ({
	db: { userStory: { groupBy: groupByMock } },
}));

import {
	aiRecommendedAwaitingApprovalWhere,
	aiRecommendedEligibleWhere,
	aiRecommendedProtectedWhere,
	countEligibleAiRecommendationBatches,
} from "../ai-recommendation-batches";

const PROJECT_ID = "project_example";
const BATCH_ID = "proposal_example";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("aiRecommendedEligibleWhere", () => {
	it("takes only unprotected, live, unfinished items from any batch with no close awaiting approval", () => {
		expect(aiRecommendedEligibleWhere(PROJECT_ID)).toEqual({
			projectId: PROJECT_ID,
			source: "AI_RECOMMENDED",
			aiRecommendationBatchId: { not: null },
			draftingStage: { notIn: ["DECLINED", "CLOSED"] },
			aiBatchProtectedAt: null,
			status: { isFinal: false },
			stageTransitionRequests: {
				none: { status: "PENDING", toStage: "CLOSED" },
			},
		});
	});

	it("leaves an item in a final (Done) status column out of every removal", () => {
		expect(aiRecommendedEligibleWhere(PROJECT_ID, BATCH_ID).status).toEqual(
			{
				isFinal: false,
			},
		);
	});

	it("narrows to one batch when a batch id is given", () => {
		expect(
			aiRecommendedEligibleWhere(PROJECT_ID, BATCH_ID)
				.aiRecommendationBatchId,
		).toBe(BATCH_ID);
	});
});

describe("aiRecommendedAwaitingApprovalWhere", () => {
	it("is the eligible predicate with the pending close request required instead of excluded", () => {
		expect(
			aiRecommendedAwaitingApprovalWhere(PROJECT_ID, BATCH_ID),
		).toEqual({
			projectId: PROJECT_ID,
			source: "AI_RECOMMENDED",
			aiRecommendationBatchId: BATCH_ID,
			draftingStage: { notIn: ["DECLINED", "CLOSED"] },
			aiBatchProtectedAt: null,
			stageTransitionRequests: {
				some: { status: "PENDING", toStage: "CLOSED" },
			},
		});
	});
});

describe("aiRecommendedProtectedWhere", () => {
	it("takes only protected, live items", () => {
		expect(aiRecommendedProtectedWhere(PROJECT_ID, BATCH_ID)).toEqual({
			projectId: PROJECT_ID,
			source: "AI_RECOMMENDED",
			aiRecommendationBatchId: BATCH_ID,
			draftingStage: { notIn: ["DECLINED", "CLOSED"] },
			aiBatchProtectedAt: { not: null },
		});
	});
});

describe("countEligibleAiRecommendationBatches", () => {
	it("counts batches, not items, through the eligible predicate", async () => {
		groupByMock.mockResolvedValue([
			{ aiRecommendationBatchId: "batch_a" },
			{ aiRecommendationBatchId: "batch_b" },
		]);

		await expect(
			countEligibleAiRecommendationBatches(PROJECT_ID),
		).resolves.toBe(2);
		expect(groupByMock).toHaveBeenCalledWith({
			by: ["aiRecommendationBatchId"],
			where: aiRecommendedEligibleWhere(PROJECT_ID),
		});
	});

	it("is zero when no batch has an eligible item", async () => {
		groupByMock.mockResolvedValue([]);

		await expect(
			countEligibleAiRecommendationBatches(PROJECT_ID),
		).resolves.toBe(0);
	});
});
