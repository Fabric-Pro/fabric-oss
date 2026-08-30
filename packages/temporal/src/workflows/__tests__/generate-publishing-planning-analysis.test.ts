import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	generatePlanningAnalysisActivity: vi.fn(),
	markPlanningAnalysisFailedActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: vi.fn(() => activityStubs),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { generatePublishingPlanningAnalysisWorkflow } from "../generate-publishing-planning-analysis";

const INPUT = {
	analysisId: "pa_1",
	topicId: "topic_1",
	projectId: "p1",
	organizationId: "org1",
	actorUserId: "u1",
};

beforeEach(() => {
	vi.clearAllMocks();
	activityStubs.generatePlanningAnalysisActivity.mockResolvedValue({
		status: "READY",
	});
	activityStubs.markPlanningAnalysisFailedActivity.mockResolvedValue(
		undefined,
	);
});

describe("generatePublishingPlanningAnalysisWorkflow", () => {
	it("returns READY on the happy path", async () => {
		const result = await generatePublishingPlanningAnalysisWorkflow(INPUT);

		expect(result).toEqual({ status: "READY" });
		expect(
			activityStubs.markPlanningAnalysisFailedActivity,
		).not.toHaveBeenCalled();
	});

	it("never throws to the fire-and-forget caller; flips the row FAILED instead", async () => {
		// Nobody awaits this workflow. A thrown error would be invisible AND would
		// leave the row on GENERATING, where it blocks the partial unique index
		// until the deadline sweep reclaims it — ten minutes during which the
		// button does nothing.
		activityStubs.generatePlanningAnalysisActivity.mockRejectedValue(
			new Error("model timeout"),
		);

		const result = await generatePublishingPlanningAnalysisWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED" });
		expect(
			activityStubs.markPlanningAnalysisFailedActivity,
		).toHaveBeenCalledWith({
			analysisId: "pa_1",
			projectId: "p1",
			message: "model timeout",
		});
	});

	it("stays silent when even the failure marker cannot be written", async () => {
		activityStubs.generatePlanningAnalysisActivity.mockRejectedValue(
			new Error("model timeout"),
		);
		activityStubs.markPlanningAnalysisFailedActivity.mockRejectedValue(
			new Error("database unreachable"),
		);

		await expect(
			generatePublishingPlanningAnalysisWorkflow(INPUT),
		).resolves.toEqual({ status: "FAILED" });
	});

	it("does not mark a superseded attempt failed", async () => {
		// SUPERSEDED means a deadline sweep already reclaimed this attempt and a
		// newer one owns the topic. Writing FAILED here would be a write to a row
		// this run no longer owns — and the CAS inside `failPlanningAnalysis` would
		// refuse it anyway. Calling it at all would be a lie in the logs.
		activityStubs.generatePlanningAnalysisActivity.mockResolvedValue({
			status: "SUPERSEDED",
		});

		const result = await generatePublishingPlanningAnalysisWorkflow(INPUT);

		expect(result).toEqual({ status: "SUPERSEDED" });
		expect(
			activityStubs.markPlanningAnalysisFailedActivity,
		).not.toHaveBeenCalled();
	});
});
