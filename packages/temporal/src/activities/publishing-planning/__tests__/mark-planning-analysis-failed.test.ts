import { beforeEach, describe, expect, it, vi } from "vitest";

const failPlanningAnalysis = vi.fn();
vi.mock("@repo/database", () => ({
	failPlanningAnalysis: (...a: unknown[]) => failPlanningAnalysis(...a),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { markPlanningAnalysisFailedActivity } from "../mark-planning-analysis-failed";

beforeEach(() => {
	vi.clearAllMocks();
	failPlanningAnalysis.mockResolvedValue({ persisted: true });
});

describe("markPlanningAnalysisFailedActivity", () => {
	it("scopes the write by projectId", async () => {
		await markPlanningAnalysisFailedActivity({
			analysisId: "pa-1",
			projectId: "proj-1",
			message: "model timeout",
		});

		expect(failPlanningAnalysis).toHaveBeenCalledWith({
			id: "pa-1",
			projectId: "proj-1",
			error: "model timeout",
		});
	});

	it("does not throw when the attempt was already terminal", async () => {
		// A deadline sweep reclaimed the attempt while the model ran, so the CAS
		// refuses. Throwing would make the workflow's last-resort catch report a
		// crash where there was only a race the database already settled.
		failPlanningAnalysis.mockResolvedValue({ persisted: false });

		await expect(
			markPlanningAnalysisFailedActivity({
				analysisId: "pa-1",
				projectId: "proj-1",
				message: "model timeout",
			}),
		).resolves.toBeUndefined();
	});
});
