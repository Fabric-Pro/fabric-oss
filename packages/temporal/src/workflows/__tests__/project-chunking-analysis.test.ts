import { beforeEach, describe, expect, it, vi } from "vitest";

const acts = vi.hoisted(() => ({
	buildChunkingQuestionsActivity: vi.fn(),
	evaluateChunkingTypeActivity: vi.fn(),
	finishChunkingAnalysisActivity: vi.fn(),
	listMeasurableChunkingTypesActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: () => acts,
}));

import { projectChunkingAnalysisWorkflow } from "../project-chunking-analysis";

const input = {
	runId: "run-1",
	projectId: "p1",
	organizationId: "org-example",
	userId: "user-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	acts.finishChunkingAnalysisActivity.mockResolvedValue({ rows: [] });
	acts.listMeasurableChunkingTypesActivity.mockResolvedValue({
		types: ["backlog", "prd"],
	});
	acts.evaluateChunkingTypeActivity.mockImplementation(
		async ({ contentType }: { contentType: string }) => ({
			contentType,
			scored: [],
		}),
	);
});

describe("projectChunkingAnalysisWorkflow", () => {
	it("evaluates every measurable type and keeps the result on the run", async () => {
		acts.buildChunkingQuestionsActivity.mockResolvedValue({
			questions: 40,
		});
		const result = await projectChunkingAnalysisWorkflow(input);
		expect(result).toEqual({ status: "COMPLETED", types: 2 });
		expect(acts.evaluateChunkingTypeActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-example",
				contentType: "prd",
			}),
		);
		expect(acts.finishChunkingAnalysisActivity).toHaveBeenCalledWith(
			expect.objectContaining({ evaluations: expect.any(Array) }),
		);
	});

	it("records a failure on the run and writes nothing else", async () => {
		acts.buildChunkingQuestionsActivity.mockRejectedValue(
			new Error("model unavailable"),
		);
		const result = await projectChunkingAnalysisWorkflow(input);
		expect(result.status).toBe("FAILED");
		expect(acts.evaluateChunkingTypeActivity).not.toHaveBeenCalled();
		expect(acts.finishChunkingAnalysisActivity).toHaveBeenCalledWith(
			expect.objectContaining({ error: "model unavailable" }),
		);
	});
});
